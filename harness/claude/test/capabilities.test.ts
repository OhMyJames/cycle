import { expect, test } from "bun:test";
import {
  client,
  methods,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type AdapterConfig, askContext, createAgent, planWindowsOf } from "../src/index.ts";
import { fakeQuery, textTurn } from "./fake-query.ts";

const ID = "5b0c3a3e-8a52-4d3f-9a0e-1c2d3e4f5a6b";

type Answers = {
  /** The client does not say it can answer forms (it would refuse one if sent). */
  noCapability?: boolean;
  /** The client says it can, and then fails the request, as a host that does not know the method would. */
  failElicitation?: boolean;
  /** What a client with the elicitation capability would answer; absent: the daemon with no such client. */
  elicitation?: (params: Record<string, unknown>) => Record<string, unknown>;
  permission?: (params: Record<string, unknown>) => "allow" | "deny";
};

/** An ACP client wired straight to the adapter, answering what it is asked as `answers` says. */
const connect = async <T>(
  runQuery: ReturnType<typeof fakeQuery>["run"],
  body: (api: {
    agent: Parameters<Parameters<ReturnType<typeof client>["connectWith"]>[1]>[0];
    updates: SessionUpdate[];
    asked: { elicitation: Record<string, unknown>[]; permission: Record<string, unknown>[] };
    idle: () => Promise<void>;
  }) => Promise<T>,
  answers: Answers = {},
  config: Partial<AdapterConfig> = {},
): Promise<T> => {
  const updates: SessionUpdate[] = [];
  const asked = {
    elicitation: [] as Record<string, unknown>[],
    permission: [] as Record<string, unknown>[],
  };
  let idles = 0;
  const waiting: (() => void)[] = [];
  const app = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
      const update = params.update as { sessionUpdate: string; state?: string };
      if (update.sessionUpdate === "state_update" && update.state === "idle") {
        idles++;
        for (const resolve of waiting.splice(0)) resolve();
      }
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      asked.permission.push(params as never);
      const answer = answers.permission?.(params as never) ?? "allow";
      return { outcome: { outcome: "selected", optionId: answer } };
    })
    .onRequest(methods.client.elicitation.create, async ({ params }) => {
      asked.elicitation.push(params as never);
      if (answers.failElicitation) throw new RequestError(-32601, "Method not found");
      return (answers.elicitation?.(params as never) ?? {
        action: "cancel",
        _meta: { "cycle/noClient": true },
      }) as never;
    });
  const adapter = createAgent({ env: {}, ...config }, runQuery);
  return app.connectWith(adapter, async (agent) => {
    await agent.request(methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "test", version: "0" },
      capabilities: answers.noCapability ? {} : { elicitation: { form: {} } },
    } as never);
    return body({
      agent,
      updates,
      asked,
      idle: async () => {
        const seen = idles;
        if (idles > seen) return;
        await new Promise<void>((resolve) => waiting.push(resolve));
      },
    });
  });
};

type Requester = { request: (method: string, params: unknown) => Promise<unknown> };

const kinds = (updates: SessionUpdate[]) => updates.map((u) => u.sessionUpdate);
const png = Buffer.from("not really a png").toString("base64");

const newSession = (agent: Requester, extra: Record<string, unknown> = {}) =>
  agent.request(methods.agent.session.new, {
    cwd: "/work",
    _meta: { "cycle/sessionId": ID },
    ...extra,
  });

const prompt = async (agent: Requester, idle: () => Promise<void>, content: unknown[]) => {
  const waiting = idle();
  await agent.request(methods.agent.session.prompt, { sessionId: ID, prompt: content });
  await waiting;
};

// ---- attachments ----

test("the adapter says what a prompt may carry, and what a session may be started with", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  const adapter = createAgent({ env: {} }, fake.run);
  const app = client();
  const init = await app.connectWith(adapter, (agent) =>
    agent.request(methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "t", version: "0" },
    } as never),
  );
  expect((init as { capabilities: { session: unknown } }).capabilities.session).toMatchObject({
    prompt: { image: {}, embeddedContext: {} },
    mcp: { stdio: {}, http: {} },
    additionalDirectories: {},
    systemPrompt: {},
  });
});

test("images, PDFs, text files and links reach Claude as content, not as nothing", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    await newSession(agent);
    await prompt(agent, idle, [
      { type: "text", text: "what is this?" },
      { type: "image", data: png, mimeType: "image/png" },
      {
        type: "resource",
        resource: { uri: "file:///notes.md", mimeType: "text/markdown", text: "# notes" },
      },
      {
        type: "resource",
        resource: { uri: "file:///a.pdf", mimeType: "application/pdf", blob: png },
      },
      { type: "resource_link", name: "log", uri: "file:///var/log/x" },
    ]);
  });
  expect(fake.contents[0]).toEqual([
    { type: "text", text: "what is this?" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
    { type: "text", text: '<file uri="file:///notes.md">\n# notes\n</file>' },
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: png },
      title: "file:///a.pdf",
    },
    { type: "text", text: '<mention name="log" uri="file:///var/log/x"/>' },
  ]);
});

test("text and links alone stay a string, as before", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    await newSession(agent);
    await prompt(agent, idle, [
      { type: "text", text: "see" },
      { type: "resource_link", name: "a", uri: "file:///a" },
    ]);
  });
  expect(fake.contents[0]).toBe('see\n\n<mention name="a" uri="file:///a"/>');
});

test("a block it cannot carry refuses the prompt, and the session takes the next one", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    await newSession(agent);
    await expect(
      agent.request(methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [
          { type: "text", text: "listen" },
          { type: "audio", data: "AAAA", mimeType: "audio/wav" },
        ],
      } as never),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      agent.request(methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [
          {
            type: "resource",
            resource: { uri: "file:///a.zip", mimeType: "application/zip", blob: png },
          },
        ],
      } as never),
    ).rejects.toMatchObject({ code: -32602 });
    await prompt(agent, idle, [{ type: "text", text: "never mind" }]);
  });
  expect(fake.prompts).toEqual(["never mind"]);
});

// ---- session setup ----

const setup = {
  additionalDirectories: ["/data/more"],
  mcpServers: [
    {
      name: "files",
      type: "stdio",
      command: "/usr/bin/files-mcp",
      args: ["--ro"],
      env: [{ name: "TOKEN", value: "s3cret" }],
    },
    {
      name: "docs",
      type: "http",
      url: "https://docs.example/mcp",
      headers: [{ name: "Authorization", value: "Bearer s3cret" }],
    },
  ],
  systemPrompt: { mode: "append", content: [{ type: "text", text: "Answer in French." }] },
};

test("directories, MCP servers and the system prompt reach Claude, and again after an idle release", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(
    fake.run,
    async ({ agent, idle }) => {
      await newSession(agent, setup);
      await prompt(agent, idle, [{ type: "text", text: "one" }]);
      await new Promise((resolve) => setTimeout(resolve, 80)); // let go: idleMs is 20
      await prompt(agent, idle, [{ type: "text", text: "two" }]);
    },
    {},
    { idleMs: 20 },
  );
  expect(fake.calls.length).toBe(2);
  for (const { options } of fake.calls) {
    expect(options.additionalDirectories).toEqual(["/data/more"]);
    expect(options.mcpServers).toEqual({
      files: {
        type: "stdio",
        command: "/usr/bin/files-mcp",
        args: ["--ro"],
        env: { TOKEN: "s3cret" },
      },
      docs: {
        type: "http",
        url: "https://docs.example/mcp",
        headers: { Authorization: "Bearer s3cret" },
      },
    });
    // Secrets go over stdin, not on the command line.
    expect(options.mcpServersDelivery).toBe("initialize");
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Answer in French.",
    });
  }
});

test("a session started without any of them passes none of them on", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
  });
  const options = fake.calls[0]?.options;
  expect(options).not.toHaveProperty("mcpServers");
  expect(options).not.toHaveProperty("mcpServersDelivery");
  expect(options).not.toHaveProperty("systemPrompt");
  expect(options).not.toHaveProperty("additionalDirectories");
});

test("a resume carries the setup again: the adapter that resumes has not seen the session new", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    await agent.request(methods.agent.session.resume, {
      sessionId: ID,
      cwd: "/work",
      ...setup,
    } as never);
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
  });
  const options = fake.calls[0]?.options;
  expect(options?.resume).toBe(ID);
  expect(Object.keys(options?.mcpServers ?? {})).toEqual(["files", "docs"]);
  expect(options?.additionalDirectories).toEqual(["/data/more"]);
});

test("what cannot be honoured is refused when the session is made, not ignored", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent }) => {
    const refused = async (extra: Record<string, unknown>) =>
      expect(newSession(agent, extra)).rejects.toMatchObject({ code: -32602 });
    await refused({ systemPrompt: { mode: "override", content: [{ type: "text", text: "x" }] } });
    await refused({
      systemPrompt: {
        mode: "append",
        content: [{ type: "image", data: png, mimeType: "image/png" }],
      },
    });
    await refused({ mcpServers: [{ name: "a", type: "sse", url: "https://x" }] });
    await refused({
      mcpServers: [
        { name: "a", type: "http", url: "https://x" },
        { name: "a", type: "http", url: "https://y" },
      ],
    });
    await refused({ additionalDirectories: ["relative/dir"] });
    await refused({ mcpServers: [{ name: "a", type: "stdio" }] }); // no command
    await refused({ mcpServers: [{ name: "a", type: "http" }] }); // no url
  });
});

// ---- model and configuration ----

test("the model is an option, and 'default' lets Claude pick", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    const created = (await newSession(agent)) as { configOptions: { configId: string }[] };
    const model = created.configOptions.find((o) => o.configId === "model") as unknown as {
      currentValue: string;
      options: { value: string }[];
    };
    expect(model.currentValue).toBe("default");
    expect(model.options.map((o) => o.value)).toEqual(["default", "sonnet", "opus", "haiku"]);

    await prompt(agent, idle, [{ type: "text", text: "one" }]); // a process to change
    const set = (value: string) =>
      agent.request(methods.agent.session.setConfigOption, {
        sessionId: ID,
        configId: "model",
        type: "id",
        value,
      } as never) as Promise<{ configOptions: { configId: string; currentValue: string }[] }>;
    expect(
      (await set("opus")).configOptions.find((o) => o.configId === "model")?.currentValue,
    ).toBe("opus");
    expect(
      (await set("default")).configOptions.find((o) => o.configId === "model")?.currentValue,
    ).toBe("default");
  });
  expect(fake.state.models).toEqual(["opus", undefined]);
});

test("reasoning effort is offered, applied to new and running processes, and cleared by default", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    const created = (await newSession(agent)) as { configOptions: { configId: string }[] };
    const effort = created.configOptions.find((o) => o.configId === "effort") as unknown as {
      currentValue: string;
      options: { value: string }[];
    };
    expect(effort.currentValue).toBe("default");
    expect(effort.options.map((o) => o.value)).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    const set = (value: string) =>
      agent.request(methods.agent.session.setConfigOption, {
        sessionId: ID,
        configId: "effort",
        type: "id",
        value,
      } as never) as Promise<{ configOptions: { configId: string; currentValue: string }[] }>;

    expect(
      (await set("high")).configOptions.find((o) => o.configId === "effort")?.currentValue,
    ).toBe("high");
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
    expect(fake.calls[0]?.options.effort).toBe("high");

    expect(
      (await set("medium")).configOptions.find((o) => o.configId === "effort")?.currentValue,
    ).toBe("medium");
    expect(
      (await set("default")).configOptions.find((o) => o.configId === "effort")?.currentValue,
    ).toBe("default");
    await expect(set("turbo")).rejects.toMatchObject({ code: -32602 });
  });
  expect(fake.state.flagSettings).toEqual([{ effortLevel: "medium" }, { effortLevel: null }]);
});

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("initializationResult().models updates live model and per-model effort options and caches across sessions", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  fake.state.availableModels = [
    {
      value: "fabel",
      displayName: "Fabel",
      description: "Latest flagship model.",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      value: "claude-haiku-4-5",
      displayName: "Haiku 4.5",
      description: "Fast model.",
      supportsEffort: false,
    },
  ];
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "hello" }]);
    await waitFor(() => updates.some((u) => u.sessionUpdate === "config_option_update"));
    const announced = updates.findLast((u) => u.sessionUpdate === "config_option_update") as
      | { configOptions?: { configId: string; options: { value: string; name: string }[] }[] }
      | undefined;
    const modelOpt = announced?.configOptions?.find((o) => o.configId === "model");
    expect(modelOpt?.options.map((o) => o.value)).toEqual(["default", "fabel", "claude-haiku-4-5"]);
    expect(modelOpt?.options.find((o) => o.value === "fabel")?.name).toBe("Fabel");
    // Each model says which effort levels it takes: [] for none, nothing when the SDK does not say.
    const efforts = Object.fromEntries(
      (modelOpt?.options ?? []).map((o) => [
        o.value,
        (o as { _meta?: Record<string, unknown> })._meta?.["cycle/efforts"],
      ]),
    );
    expect(efforts).toEqual({
      default: undefined,
      fabel: ["low", "medium", "high", "xhigh", "max"],
      "claude-haiku-4-5": [],
    });

    // Set high effort on Fabel, then switch to Haiku (`supportsEffort: false`): stale effort resets to default and high is rejected.
    await agent.request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "model",
      type: "id",
      value: "fabel",
    } as never);
    await agent.request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "effort",
      type: "id",
      value: "high",
    } as never);

    const toHaiku = (await agent.request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "model",
      type: "id",
      value: "claude-haiku-4-5",
    } as never)) as {
      configOptions: { configId: string; currentValue: string; options: { value: string }[] }[];
    };
    const haikuEffort = toHaiku.configOptions.find((o) => o.configId === "effort");
    expect(haikuEffort?.currentValue).toBe("default");
    expect(haikuEffort?.options.map((o) => o.value)).toEqual(["default"]);
    expect(fake.state.flagSettings.at(-1)).toEqual({ effortLevel: null });
    await expect(
      agent.request(methods.agent.session.setConfigOption, {
        sessionId: ID,
        configId: "effort",
        type: "id",
        value: "high",
      } as never),
    ).rejects.toMatchObject({ code: -32602 });

    // Switching to Fabel exposes its full supportedEffortLevels.
    const toFabel = (await agent.request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "model",
      type: "id",
      value: "fabel",
    } as never)) as {
      configOptions: { configId: string; options: { value: string }[] }[];
    };
    expect(
      toFabel.configOptions.find((o) => o.configId === "effort")?.options.map((o) => o.value),
    ).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);

    // Custom unlisted models are marked with `_meta["cycle/custom"]` so the daemon never caches them globally.
    const custom = (await agent.request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "model",
      type: "id",
      value: "claude-custom-preview",
    } as never)) as {
      configOptions: {
        configId: string;
        currentValue: string;
        options: { value: string; _meta?: Record<string, unknown> }[];
      }[];
    };
    const customOpt = custom.configOptions
      .find((o) => o.configId === "model")
      ?.options.find((o) => o.value === "claude-custom-preview");
    expect(customOpt?._meta).toEqual({ "cycle/custom": true });

    // A subsequent new session immediately inherits the discovered models without starting a process first.
    const second = (await agent.request(methods.agent.session.new, { cwd: "/work" })) as {
      configOptions: { configId: string; options: { value: string }[] }[];
    };
    expect(
      second.configOptions.find((o) => o.configId === "model")?.options.map((o) => o.value),
    ).toEqual(["default", "fabel", "claude-haiku-4-5"]);
  });
});

test("initializationResult() failure falls back independently to supportedCommands() and supportedModels()", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  fake.state.failInitializationResult = true;
  fake.state.commands = [
    { name: "compact", description: "Compact conversation", argumentHint: "" },
  ];
  fake.state.availableModels = [{ value: "fabel", displayName: "Fabel", description: "Latest." }];
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "hello" }]);
    await waitFor(
      () =>
        updates.some((u) => u.sessionUpdate === "available_commands_update") &&
        updates.some((u) => u.sessionUpdate === "config_option_update"),
    );
    const announced = updates.findLast((u) => u.sessionUpdate === "config_option_update") as
      | { configOptions?: { configId: string; options: { value: string }[] }[] }
      | undefined;
    expect(
      announced?.configOptions?.find((o) => o.configId === "model")?.options.map((o) => o.value),
    ).toEqual(["default", "fabel"]);
  });
});

test("the default model is the model it stands for, with its version, not an option of its own", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  fake.state.availableModels = [
    {
      value: "default",
      resolvedModel: "claude-opus-5-5",
      displayName: "Default (recommended)",
      description: "Use the default model (currently Opus 5.5) · $4/$20 per Mtok",
    },
    {
      value: "opus",
      resolvedModel: "claude-opus-5-5",
      displayName: "Opus",
      description: "Opus 5.5 · Best for everyday, complex tasks",
    },
    {
      value: "sonnet",
      resolvedModel: "claude-sonnet-5-5",
      displayName: "Sonnet",
      description: "Sonnet 5.5 · Efficient for routine tasks",
    },
  ];
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "hello" }]);
    await waitFor(() => updates.some((u) => u.sessionUpdate === "config_option_update"));
    const announced = updates.findLast((u) => u.sessionUpdate === "config_option_update") as
      | {
          configOptions?: {
            configId: string;
            currentValue: string;
            options: { value: string; name: string }[];
          }[];
        }
      | undefined;
    const model = announced?.configOptions?.find((o) => o.configId === "model");
    // The alias row that `default` duplicates is folded into it.
    expect(model?.options.map((o) => [o.value, o.name])).toEqual([
      ["default", "Opus 5.5 (default)"],
      ["sonnet", "Sonnet 5.5"],
    ]);
    expect(model?.currentValue).toBe("default");

    // Pinned to the model `default` stands for: the pin keeps its own row, so it is seen and `default` can be chosen.
    const answer = (await agent.request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "model",
      type: "id",
      value: "opus",
    } as never)) as {
      configOptions: {
        configId: string;
        currentValue: string;
        options: { value: string; name: string }[];
      }[];
    };
    const pinned = answer.configOptions.find((o) => o.configId === "model");
    expect(pinned?.currentValue).toBe("opus");
    expect(pinned?.options.map((o) => [o.value, o.name])).toEqual([
      ["default", "Opus 5.5 (default)"],
      ["opus", "Opus 5.5"],
      ["sonnet", "Sonnet 5.5"],
    ]);
  });
});

test("a mode Claude changes by itself is told to the client, and kept for the next process", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "plan it"
      ? ([
          ...textTurn(ID, "m", "planned"),
          { type: "system", subtype: "status", status: null, permissionMode: "acceptEdits" },
        ].sort((a, b) => (a.type === "result" ? 1 : b.type === "result" ? -1 : 0)) as SDKMessage[])
      : textTurn(ID, "m", "ok"),
  );
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "plan it" }]);
      const update = updates.find((u) => u.sessionUpdate === "config_option_update") as unknown as {
        configOptions: { configId: string; currentValue: string }[];
      };
      expect(update.configOptions.find((o) => o.configId === "mode")?.currentValue).toBe(
        "acceptEdits",
      );
      // The same mode again is not news.
      expect(kinds(updates).filter((k) => k === "config_option_update").length).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
    },
    {},
    { idleMs: 20 },
  );
  expect(fake.calls[1]?.options.permissionMode).toBe("acceptEdits");
});

// ---- commands, compaction, title ----

test("the commands Claude has are announced, and replaced when they change", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "again"
      ? ([
          {
            type: "system",
            subtype: "commands_changed",
            commands: [{ name: "deploy", description: "Ship it", argumentHint: "" }],
          },
          ...textTurn(ID, "m", "ok"),
        ] as unknown as SDKMessage[])
      : textTurn(ID, "m", "ok"),
  );
  fake.state.commands = [
    { name: "review", description: "Review the diff", argumentHint: "<pr>" },
    { name: "review", description: "a duplicate", argumentHint: "" },
  ];
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
    await prompt(agent, idle, [{ type: "text", text: "again" }]);
    const lists = updates
      .filter((u) => u.sessionUpdate === "available_commands_update")
      .map((u) => (u as unknown as { availableCommands: unknown[] }).availableCommands);
    expect(lists).toEqual([
      [
        {
          type: "command",
          name: "review",
          description: "Review the diff",
          input: { type: "text", hint: "<pr>" },
        },
      ],
      [{ type: "command", name: "deploy", description: "Ship it" }],
    ]);
  });
});

test("with warmStart, the commands are known before the first prompt, and a prompt then uses that process", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  fake.state.commands = [{ name: "review", description: "Review the diff", argumentHint: "" }];
  const commandsIn = (updates: SessionUpdate[]) =>
    updates.filter((u) => u.sessionUpdate === "available_commands_update");
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      const deadline = Date.now() + 2000;
      while (commandsIn(updates).length === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(commandsIn(updates)).toHaveLength(1);
      await prompt(agent, idle, [{ type: "text", text: "one" }]);
      // The same process took the prompt: its commands were not announced a second time.
      expect(commandsIn(updates)).toHaveLength(1);
    },
    {},
    { warmStart: true },
  );
});

test("without warmStart nothing is started until the first prompt", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  fake.state.commands = [{ name: "review", description: "x", argumentHint: "" }];
  await connect(fake.run, async ({ agent, updates }) => {
    await newSession(agent);
    await Bun.sleep(50);
    expect(updates.filter((u) => u.sessionUpdate === "available_commands_update")).toHaveLength(0);
  });
});

test("a process started ahead of the first prompt is let go if none comes", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(
    fake.run,
    async ({ agent }) => {
      await newSession(agent);
      await Bun.sleep(150);
      expect(fake.state.inputClosed).toBe(true);
    },
    {},
    { warmStart: true, idleMs: 30 },
  );
});

// ---- found in review ----

test("the same commands are not announced again by a process that started again", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  fake.state.commands = [{ name: "review", description: "Review the diff", argumentHint: "" }];
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "one" }]);
      await Bun.sleep(120); // let go for being idle
      await prompt(agent, idle, [{ type: "text", text: "two" }]);
      await Bun.sleep(30);
      expect(fake.calls.length).toBe(2); // a second process did start
      expect(updates.filter((u) => u.sessionUpdate === "available_commands_update")).toHaveLength(
        1,
      );
    },
    {},
    { idleMs: 40 },
  );
});

test("two mode changes in flight: once both have landed the process's own word counts again", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "three"
      ? ([
          { type: "system", subtype: "status", status: null, permissionMode: "default" },
          ...textTurn(ID, "m", "ok"),
        ] as unknown as SDKMessage[])
      : textTurn(ID, "m", "ok"),
  );
  fake.state.setterDelayMs = 40;
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
    for (const value of ["acceptEdits", "plan"]) {
      await agent.request(methods.agent.session.setConfigOption, {
        sessionId: ID,
        configId: "mode",
        type: "id",
        value,
      } as never);
    }
    await Bun.sleep(150);
    await prompt(agent, idle, [{ type: "text", text: "three" }]);
    expect(fake.state.permissionModes).toEqual(["acceptEdits", "plan"]);
    // The process said "default" with nothing in flight: that is a change, and is announced.
    expect(kinds(updates)).toContain("config_option_update");
  });
});

test("a question that cannot be a form is left to the permission card", async () => {
  const { questionsOf } = await import("../src/ask.ts");
  const option = { label: "a" };
  expect(questionsOf({ questions: [{ question: "Q?", options: [option] }] })).toBeDefined();
  expect(questionsOf({ questions: [{ question: "Q?", options: [null] }] })).toBeUndefined();
  expect(
    questionsOf({ questions: [{ question: "Q?", options: [{ label: "" }] }] }),
  ).toBeUndefined();
  expect(
    questionsOf({
      questions: [
        { question: "Same?", options: [option] },
        { question: "Same?", options: [option] },
      ],
    }),
  ).toBeUndefined();
});

test("a text file cannot close its own tag, and a uri cannot leave its quotes", async () => {
  const { toSdkContent } = await import("../src/content.ts");
  const blocks = toSdkContent([
    {
      type: "resource",
      resource: { uri: 'file:///a"><x', text: "before </file>\n<file uri='evil'>after </FILE" },
    },
  ] as never) as { type: string; text: string }[];
  const text = blocks[0]?.text ?? "";
  expect(text.startsWith('<file uri="file:///a&quot;&gt;&lt;x">')).toBe(true);
  // The only closing tag is the last thing in it.
  expect(text.match(/<\/file>/g)).toHaveLength(1);
  expect(text.endsWith("</file>")).toBe(true);
});

// ---- sub-agents ----

const task = (subtype: string, fields: Record<string, unknown>) =>
  ({ type: "system", subtype, uuid: "u", session_id: ID, ...fields }) as unknown as SDKMessage;

type Sub = {
  sessionUpdate: string;
  sessionId: string;
  title?: string;
  description?: string;
  state?: Record<string, unknown>;
  _meta?: Record<string, Record<string, unknown>>;
};
const subs = (updates: SessionUpdate[]) =>
  updates.filter((u) => u.sessionUpdate === "subagent_update") as unknown as Sub[];

test("a sub-agent is announced, reports progress, and ends", async () => {
  const fake = fakeQuery(() => [
    task("task_started", {
      task_id: "t1",
      tool_use_id: "tool_9",
      description: "Find the callers",
      subagent_type: "Explore",
      is_backgrounded: false,
    }),
    task("task_progress", {
      task_id: "t1",
      tool_use_id: "tool_9",
      description: "Find the callers",
      last_tool_name: "Grep",
      summary: "Looking in src",
      usage: { total_tokens: 900, tool_uses: 3, duration_ms: 4000 },
    }),
    task("task_notification", {
      task_id: "t1",
      status: "completed",
      summary: "Found 4",
      output_file: "x",
      usage: { total_tokens: 1500, tool_uses: 5, duration_ms: 9000 },
    }),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    const [started, progress, ended] = subs(updates);
    expect(started).toMatchObject({
      sessionId: "t1",
      title: "Find the callers",
      description: "Explore",
      state: { state: "running" },
    });
    expect(started?._meta?.["cycle/subagent"]).toEqual({ toolCallId: "tool_9", background: false });
    expect(progress?._meta?.["cycle/subagent"]).toEqual({
      toolCallId: "tool_9",
      summary: "Looking in src",
      lastTool: "Grep",
      usage: { tokens: 900, toolUses: 3, durationMs: 4000 },
    });
    expect(ended?.state).toEqual({ state: "idle", stopReason: "end_turn" });
    // The end did not say which call it came from; the start had.
    expect(ended?._meta?.["cycle/subagent"]?.toolCallId).toBe("tool_9");
    expect(ended?._meta?.["cycle/subagent"]?.usage).toEqual({
      tokens: 1500,
      toolUses: 5,
      durationMs: 9000,
    });
    expect(subs(updates)).toHaveLength(3);
  });
  // Summaries cost a model call each: not asked for unless the configuration says so.
  expect(
    ((fake.calls[0]?.options ?? {}) as { agentProgressSummaries?: boolean }).agentProgressSummaries,
  ).toBeUndefined();
});

test("a sub-agent that moves to the background later is announced as one", async () => {
  const fake = fakeQuery(() => [
    task("task_started", { task_id: "t1", tool_use_id: "tool_9", is_backgrounded: false }),
    task("task_updated", { task_id: "t1", patch: { is_backgrounded: true } }),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    const [started, moved] = subs(updates);
    expect(started?._meta?.["cycle/subagent"]?.background).toBe(false);
    expect(moved).toMatchObject({ sessionId: "t1" });
    expect(moved?._meta?.["cycle/subagent"]).toEqual({ toolCallId: "tool_9", background: true });
    expect(moved?.state).toBeUndefined();
  });
});

test("progress summaries are asked of the SDK when the configuration says to", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(
    fake.run,
    async ({ agent, idle }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
    },
    {},
    { progressSummaries: true },
  );
  expect(
    ((fake.calls[0]?.options ?? {}) as { agentProgressSummaries?: boolean }).agentProgressSummaries,
  ).toBe(true);
});

test("sessions made ahead of a prompt do not each keep a process: the oldest is let go past the limit", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(
    fake.run,
    async ({ agent }) => {
      for (const n of [1, 2, 3]) {
        await agent.request(methods.agent.session.new, {
          cwd: "/work",
          _meta: { "cycle/sessionId": `aaaaaaa${n}-aaaa-4bbb-8ccc-dddddddddddd` },
        });
      }
      await Bun.sleep(50);
      // Three were started; the first was let go when the third came (its input closed).
      expect(fake.state.inputClosed).toBe(true);
    },
    {},
    { warmStart: true, maxWarm: 2 },
  );
});

test("a failed or stopped sub-agent says how it ended", async () => {
  const fake = fakeQuery(() => [
    task("task_started", { task_id: "a", description: "A" }),
    task("task_started", { task_id: "b", description: "B" }),
    task("task_notification", {
      task_id: "a",
      status: "failed",
      summary: "It broke",
      output_file: "x",
    }),
    task("task_notification", { task_id: "b", status: "stopped", summary: "", output_file: "x" }),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    const ends = subs(updates).filter((u) => u.state?.state === "idle");
    expect(ends.map((u) => u.state)).toEqual([
      { state: "idle", stopReason: "error", error: { code: -32603, message: "It broke" } },
      { state: "idle", stopReason: "cancelled" },
    ]);
  });
});

test("tasks that are not sub-agents, and progress for ones nobody was told of, are left out", async () => {
  const fake = fakeQuery(() => [
    task("task_started", { task_id: "sh", task_type: "local_bash", description: "npm test" }),
    task("task_progress", {
      task_id: "sh",
      description: "npm test",
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 1 },
    }),
    task("task_started", { task_id: "w", description: "watch", ambient: true }),
    task("task_progress", {
      task_id: "never",
      description: "?",
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 1 },
    }),
    task("task_notification", {
      task_id: "sh",
      status: "completed",
      summary: "",
      output_file: "x",
    }),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    expect(subs(updates)).toEqual([]);
  });
});

test("a sub-agent still running when its process is let go is told as cancelled", async () => {
  const fake = fakeQuery(() => [
    task("task_started", { task_id: "t1", description: "Long job" }),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
      const deadline = Date.now() + 2000;
      while (subs(updates).length < 2 && Date.now() < deadline) await Bun.sleep(10);
      expect(subs(updates).map((u) => u.state)).toEqual([
        { state: "running" },
        { state: "idle", stopReason: "cancelled" },
      ]);
    },
    {},
    { idleMs: 30 },
  );
});

test("a compaction is announced as it starts and as it ends, or fails", async () => {
  const status = (s: string | null, extra: object = {}) =>
    ({ type: "system", subtype: "status", status: s, ...extra }) as unknown as SDKMessage;
  const fake = fakeQuery((call) =>
    call.prompt === "fail"
      ? [
          status("compacting"),
          status(null, { compact_result: "failed", compact_error: "too big" }),
          ...textTurn(ID, "m", "x"),
        ]
      : [
          status("compacting"),
          status(null, { compact_result: "success" }),
          ...textTurn(ID, "m", "ok"),
        ],
  );
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
    await prompt(agent, idle, [{ type: "text", text: "fail" }]);
    const compactions = updates.filter(
      (u) => u.sessionUpdate === "compaction_update",
    ) as unknown as {
      compactionId: string;
      status: string;
      error?: string;
    }[];
    expect(compactions.map((c) => c.status)).toEqual([
      "in_progress",
      "completed",
      "in_progress",
      "failed",
    ]);
    expect(compactions[0]?.compactionId).toBe(compactions[1]?.compactionId as string);
    expect(compactions[0]?.compactionId).not.toBe(compactions[2]?.compactionId as string);
    expect(compactions[3]?.error).toBe("too big");
  });
});

test("a compaction with post_tokens tells the usage it left at once, after the compaction; without them nothing is made up", async () => {
  const status = (s: string | null, extra: object = {}) =>
    ({ type: "system", subtype: "status", status: s, ...extra }) as unknown as SDKMessage;
  const boundary = (post?: number) =>
    ({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: {
        trigger: "manual",
        pre_tokens: 150_000,
        ...(post !== undefined ? { post_tokens: post } : {}),
      },
    }) as unknown as SDKMessage;
  /** A turn whose one model call used `tokens`, in a 200K window. */
  const measured = (tokens: number) => {
    const [init, start, block, d1, d2, assistant] = textTurn(ID, "m", "ok") as unknown as Record<
      string,
      unknown
    >[];
    return [
      init,
      start,
      block,
      d1,
      d2,
      {
        ...assistant,
        message: {
          ...(assistant?.message as object),
          usage: { input_tokens: 10, cache_read_input_tokens: tokens - 20, output_tokens: 10 },
        },
      },
      {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        session_id: ID,
        total_cost_usd: 0.5,
        modelUsage: { opus: { contextWindow: 200_000 } },
      },
    ] as unknown as SDKMessage[];
  };
  const fake = fakeQuery((call) => {
    const text = fake.prompts.at(-1) ?? call.prompt;
    if (text === "compact")
      // `/compact`: no model call of its own that reports usage, then the result.
      return [
        status("compacting"),
        boundary(40_000),
        status(null, { compact_result: "success" }),
        {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
          session_id: ID,
        } as unknown as SDKMessage,
      ];
    if (text === "failed") {
      // A model call measured, then a compaction that said where it would land and failed.
      const turn = measured(150_000);
      const result = turn.pop() as SDKMessage;
      return [
        ...turn,
        status("compacting"),
        boundary(40_000),
        status(null, { compact_result: "failed", compact_error: "no" }),
        result,
      ];
    }
    if (text === "unknown")
      return [
        status("compacting"),
        boundary(),
        status(null, { compact_result: "success" }),
        {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
          session_id: ID,
        } as unknown as SDKMessage,
      ];
    return measured(150_000);
  });
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "work" }]);
    const kinds = () =>
      updates
        .filter(
          (u) => u.sessionUpdate === "usage_update" || u.sessionUpdate === "compaction_update",
        )
        .map((u) =>
          u.sessionUpdate === "usage_update"
            ? `usage ${(u as unknown as { used: number }).used}/${(u as unknown as { size: number }).size}`
            : `compaction ${(u as unknown as { status: string }).status}`,
        );
    expect(kinds()).toEqual(["usage 150000/200000"]);

    await prompt(agent, idle, [{ type: "text", text: "compact" }]);
    // The usage comes after the compaction is told as completed, so a client never sees it before.
    expect(kinds()).toEqual([
      "usage 150000/200000",
      "compaction in_progress",
      "compaction completed",
      "usage 40000/200000",
    ]);
    const compactedUsage = updates.filter((u) => u.sessionUpdate === "usage_update").at(-1);
    // No cost of its own: the last one stays (protocol §8).
    expect(compactedUsage).not.toHaveProperty("cost");

    await prompt(agent, idle, [{ type: "text", text: "unknown" }]);
    // Without post_tokens no number is invented: no usage is told after that compaction.
    expect(kinds().slice(4)).toEqual(["compaction in_progress", "compaction completed"]);

    await prompt(agent, idle, [{ type: "text", text: "failed" }]);
    // The context was not made smaller: the turn ends with what the model call measured.
    expect(kinds().slice(6)).toEqual([
      "compaction in_progress",
      "compaction failed",
      "usage 150000/200000",
    ]);
  });
});

test("Claude trying its request again is a notice with the counts, not the end of the turn", async () => {
  const retry = (attempt: number, status: number | null) =>
    ({
      type: "system",
      subtype: "api_retry",
      attempt,
      max_retries: 10,
      retry_delay_ms: 1200,
      error_status: status,
      error: "rate_limit",
    }) as unknown as SDKMessage;
  const fake = fakeQuery(() => [retry(1, 529), retry(2, null), ...textTurn(ID, "m", "ok")]);
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
    const notices = updates.filter((u) => u.sessionUpdate === "notice") as unknown as {
      severity: string;
      title: string;
      _meta: Record<string, unknown>;
    }[];
    expect(notices.map((n) => n.title)).toEqual([
      "Retrying the request (attempt 1 of 10)",
      "Retrying the request (attempt 2 of 10)",
    ]);
    expect(notices.every((n) => n.severity === "info")).toBe(true);
    expect(notices[0]?._meta["cycle/retry"]).toEqual({
      attempt: 1,
      maxRetries: 10,
      delayMs: 1200,
      status: 529,
    });
    // A connection error has no status.
    expect(notices[1]?._meta["cycle/retry"]).toEqual({ attempt: 2, maxRetries: 10, delayMs: 1200 });
    // The turn went on and ended well.
    const ends = updates.filter(
      (u) => u.sessionUpdate === "state_update" && (u as { state?: string }).state === "idle",
    ) as unknown as { stopReason?: string }[];
    expect(ends.at(-1)?.stopReason).toBe("end_turn");
  });
});

test("the title Claude gave the session is told once, and a first prompt is not a title", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  const infos = [
    { summary: "hello there", firstPrompt: "hello there" },
    { summary: "Fixing the login bug", firstPrompt: "hello there" },
    { summary: "Fixing the login bug", firstPrompt: "hello there" },
  ];
  let n = 0;
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      for (const text of ["one", "two", "three"]) {
        await prompt(agent, idle, [{ type: "text", text }]);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const titles = updates
        .filter((u) => u.sessionUpdate === "session_info_update")
        .map((u) => (u as unknown as { title: string }).title);
      expect(titles).toEqual(["Fixing the login bug"]);
    },
    {},
    { sessionInfo: async () => infos[n++] },
  );
});

// ---- elicitation ----

const input = {
  questions: [
    {
      question: "Which library?",
      header: "Library",
      multiSelect: false,
      options: [
        { label: "date-fns", description: "small" },
        { label: "luxon", description: "big" },
      ],
    },
    {
      question: "Which features?",
      header: "Features",
      multiSelect: true,
      options: [
        { label: "tz", description: "time zones" },
        { label: "i18n", description: "locales" },
      ],
    },
  ],
};

/** A turn in which Claude asks for permission to use a tool, and the answer is what the test sees. */
const asking = (tool: string, toolInput: unknown) => {
  const seen: { result?: unknown } = {};
  const fake = fakeQuery(async ({ options }) => {
    seen.result = await options.canUseTool?.(
      tool,
      toolInput as never,
      {
        signal: new AbortController().signal,
        toolUseID: "tool_1",
      } as never,
    );
    return textTurn(ID, "m", "ok");
  });
  return { fake, seen };
};

test("AskUserQuestion is a form when a client can answer one, and the answers go back to the tool", async () => {
  const { fake, seen } = asking("AskUserQuestion", input);
  await connect(
    fake.run,
    async ({ agent, idle, asked }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
      expect(asked.permission).toEqual([]);
      const form = asked.elicitation[0] as {
        mode: string;
        message: string;
        requestedSchema: {
          properties: Record<string, { type: string; oneOf?: unknown[]; items?: unknown }>;
          required?: string[];
        };
      };
      expect(form.mode).toBe("form");
      // Nothing is required: each question also has a field of free text, so no one field is.
      expect(form.requestedSchema.required).toBeUndefined();
      expect(form.requestedSchema.properties.q0_other?.type).toBe("string");
      expect(form.requestedSchema.properties.q1_other?.type).toBe("string");
      expect(form.requestedSchema.properties.q0?.type).toBe("string");
      expect(form.requestedSchema.properties.q0?.oneOf).toEqual([
        { const: "date-fns", title: "date-fns", description: "small" },
        { const: "luxon", title: "luxon", description: "big" },
      ]);
      expect(form.requestedSchema.properties.q1?.type).toBe("array");
    },
    { elicitation: () => ({ action: "accept", content: { q0: "luxon", q1: ["tz", "i18n"] } }) },
  );
  expect(seen.result).toEqual({
    behavior: "allow",
    updatedInput: {
      ...input,
      answers: { "Which library?": "luxon", "Which features?": "tz, i18n" },
    },
  });
});

test("a written answer replaces a single choice and is one more label of a multiple choice", async () => {
  const { fake, seen } = asking("AskUserQuestion", input);
  await connect(
    fake.run,
    async ({ agent, idle }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
    },
    {
      elicitation: () => ({
        action: "accept",
        content: { q0: "luxon", q0_other: "  Temporal  ", q1: ["tz"], q1_other: "calendars" },
      }),
    },
  );
  expect(seen.result).toEqual({
    behavior: "allow",
    updatedInput: {
      ...input,
      answers: { "Which library?": "Temporal", "Which features?": "tz, calendars" },
    },
  });
});

test("a form that comes back with nothing in it is not an answer", async () => {
  const { fake, seen } = asking("AskUserQuestion", input);
  await connect(
    fake.run,
    async ({ agent, idle }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
    },
    { elicitation: () => ({ action: "accept", content: { q0_other: "   ", q1: [] } }) },
  );
  expect(seen.result).toEqual({ behavior: "deny", message: "The user did not answer" });
});

test("declining the questions denies the tool, with a reason Claude can read", async () => {
  const { fake, seen } = asking("AskUserQuestion", input);
  await connect(
    fake.run,
    async ({ agent, idle }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
    },
    { elicitation: () => ({ action: "decline" }) },
  );
  expect(seen.result).toEqual({ behavior: "deny", message: "The user declined to answer" });
});

test("with no client that can answer a form, AskUserQuestion is the permission card it was", async () => {
  const { fake, seen } = asking("AskUserQuestion", input);
  await connect(fake.run, async ({ agent, idle, asked }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    expect(asked.elicitation.length).toBe(1);
    expect(asked.permission.length).toBe(1);
    expect((asked.permission[0] as { title: string }).title).toBe("Allow AskUserQuestion?");
  });
  expect(seen.result).toEqual({ behavior: "allow", updatedInput: input });
});

test("a malformed AskUserQuestion is not turned into a form", async () => {
  const { fake } = asking("AskUserQuestion", { questions: "which?" });
  await connect(fake.run, async ({ agent, idle, asked }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    expect(asked.elicitation).toEqual([]);
    expect(asked.permission.length).toBe(1);
  });
});

const mcpAsk = (request: Record<string, unknown>) => {
  const seen: { result?: unknown } = {};
  const fake = fakeQuery(async ({ options }) => {
    seen.result = await options.onElicitation?.(request as never, {
      signal: new AbortController().signal,
      requestId: "r1",
    });
    return textTurn(ID, "m", "ok");
  });
  return { fake, seen };
};

test("an MCP server's question is a form for the user; without a client it is declined", async () => {
  const request = {
    serverName: "files",
    message: "Which folder?",
    mode: "form",
    requestedSchema: { type: "object", properties: { folder: { type: "string" } } },
  };
  const yes = mcpAsk(request);
  await connect(
    yes.fake.run,
    async ({ agent, idle, asked }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
      expect(asked.elicitation[0]).toMatchObject({ mode: "form", message: "Which folder?" });
    },
    { elicitation: () => ({ action: "accept", content: { folder: "src" } }) },
  );
  expect(yes.seen.result).toEqual({ action: "accept", content: { folder: "src" } });

  const none = mcpAsk(request);
  await connect(none.fake.run, async ({ agent, idle }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
  });
  expect(none.seen.result).toEqual({ action: "decline" });
});

test("an MCP server's URL request is declined, and is not sent to the client", async () => {
  const url = mcpAsk({
    serverName: "files",
    message: "Sign in",
    mode: "url",
    url: "https://x",
    elicitationId: "e1",
  });
  await connect(url.fake.run, async ({ agent, idle, asked }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    expect(asked.elicitation).toEqual([]);
  });
  expect(url.seen.result).toEqual({ action: "decline" });
});

for (const [name, answers] of [
  ["a client that did not say it can answer forms is sent none", { noCapability: true }],
  [
    "a client that fails the form request is not sent more, and the turn is not ended",
    { failElicitation: true },
  ],
] as const) {
  test(`${name}: AskUserQuestion is the permission card, an MCP question is declined`, async () => {
    const { fake, seen } = asking("AskUserQuestion", input);
    await connect(
      fake.run,
      async ({ agent, idle, asked }) => {
        await newSession(agent);
        await prompt(agent, idle, [{ type: "text", text: "go" }]);
        expect(asked.elicitation.length).toBe("failElicitation" in answers ? 1 : 0);
        expect(asked.permission.length).toBe(1);
      },
      answers,
    );
    // Allowed as it was, not denied with an interrupt.
    expect(seen.result).toEqual({ behavior: "allow", updatedInput: input });

    const mcp = mcpAsk({
      serverName: "files",
      message: "Which folder?",
      mode: "form",
      requestedSchema: { type: "object", properties: { folder: { type: "string" } } },
    });
    await connect(
      mcp.fake.run,
      async ({ agent, idle }) => {
        await newSession(agent);
        await prompt(agent, idle, [{ type: "text", text: "go" }]);
      },
      answers,
    );
    expect(mcp.seen.result).toEqual({ action: "decline" });
  });
}

test("a turn's usage carries what the window holds, as Claude Code counts it, in the window it counts against", async () => {
  const fake = fakeQuery(() => {
    const [init, start, block, d1, d2, assistant] = textTurn(ID, "m", "ok") as unknown as Record<
      string,
      unknown
    >[];
    return [
      init,
      start,
      block,
      d1,
      d2,
      {
        ...assistant,
        message: {
          ...(assistant?.message as object),
          usage: { input_tokens: 10, cache_read_input_tokens: 161_280, output_tokens: 10 },
        },
      },
      {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        session_id: ID,
        modelUsage: { opus: { contextWindow: 1_000_000 } },
      },
    ] as unknown as SDKMessage[];
  });
  fake.state.contextUsage = {
    totalTokens: 161_300,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    percentage: 81,
    isAutoCompactEnabled: true,
    autoCompactThreshold: 167_000,
    categories: [
      { id: "system_prompt", name: "System prompt", tokens: 6_000, kind: "used", color: "x" },
      { id: "messages", name: "Messages", tokens: 155_300, kind: "used", color: "x" },
      { id: "mcp_tools", name: "MCP tools", tokens: 0, kind: "used", color: "x" },
      {
        id: "mcp_tools_deferred",
        name: "MCP tools (deferred)",
        tokens: 89_300,
        kind: "deferred",
        color: "x",
      },
      { name: "Something new", tokens: 12, kind: "used", color: "x" },
      { id: "odd", name: "Odd", tokens: 5, kind: "sideways", color: "x" },
      {
        id: "autocompact_buffer",
        name: "Autocompact buffer",
        tokens: 33_000,
        kind: "buffer",
        color: "x",
      },
      { id: "free_space", name: "Free space", tokens: 5_700, kind: "free", color: "x" },
    ],
  };
  const usages = (updates: SessionUpdate[]) =>
    updates.filter((u) => u.sessionUpdate === "usage_update") as unknown as Record<
      string,
      unknown
    >[];
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "work" }]);
    const usage = usages(updates).at(-1);
    // The window is the one the parts are counted in, not the model's 1M: the share and the parts agree.
    expect(usage?.used).toBe(161_300);
    expect(usage?.size).toBe(200_000);
    // Empty parts and kinds it does not know are left out; a part with no id keeps its name.
    expect((usage?._meta as Record<string, unknown> | undefined)?.["cycle/context"]).toEqual({
      window: 200_000,
      autoCompactAt: 167_000,
      parts: [
        { id: "system_prompt", name: "System prompt", tokens: 6_000, kind: "used" },
        { id: "messages", name: "Messages", tokens: 155_300, kind: "used" },
        {
          id: "mcp_tools_deferred",
          name: "MCP tools (deferred)",
          tokens: 89_300,
          kind: "deferred",
        },
        { name: "Something new", tokens: 12, kind: "used" },
        { id: "autocompact_buffer", name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
        { id: "free_space", name: "Free space", tokens: 5_700, kind: "free" },
      ],
    });

    // A process that cannot say (an older CLI, an answer that is not one) ends the turn with the usage alone.
    // A process that cannot say this time keeps the window it last told: the ring does not jump to the model's 1M.
    fake.state.contextUsage = undefined;
    await prompt(agent, idle, [{ type: "text", text: "again" }]);
    expect(usages(updates).at(-1)).toEqual({
      sessionUpdate: "usage_update",
      used: 161_300,
      size: 200_000,
    });
    fake.state.contextUsage = { categories: "no" };
    await prompt(agent, idle, [{ type: "text", text: "again" }]);
    expect(usages(updates).at(-1)).not.toHaveProperty("_meta");
  });

  // A new process has told no window yet: without an answer, the model's is the one.
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "work" }]);
    expect(usages(updates).at(-1)?.size).toBe(1_000_000);
  });
});

test("a prompt steered in while the turn's context is asked is answered in the same turn, by the same process", async () => {
  const fake = fakeQuery(() => {
    const [init, start, block, d1, d2, assistant] = textTurn(ID, "m", "ok") as unknown as Record<
      string,
      unknown
    >[];
    return [
      init,
      start,
      block,
      d1,
      d2,
      {
        ...assistant,
        message: { ...(assistant?.message as object), usage: { input_tokens: 100 } },
      },
      {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        session_id: ID,
        modelUsage: { opus: { contextWindow: 200_000 } },
      },
    ] as unknown as SDKMessage[];
  });
  const answer = { rawMaxTokens: 200_000, categories: [] };
  let asked = 0;
  let answerFirst: () => void = () => {};
  fake.state.contextUsage = () => {
    asked++;
    // The first ask waits until a steer has come in; the next answers at once.
    return asked === 1
      ? new Promise((resolve) => {
          answerFirst = () => resolve(answer);
        })
      : Promise.resolve(answer);
  };
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    const ended = idle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "work" }],
    });
    for (let i = 0; i < 100 && asked === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(asked).toBe(1);
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "mind this" }],
      _meta: { "cycle/steer": true },
    });
    answerFirst();
    await ended;
    // Claude answered the steer in the same process, inside the one turn: one idle, one usage, at its end.
    expect(fake.prompts).toEqual(["work", "mind this"]);
    expect(fake.calls).toHaveLength(1);
    expect(updates.filter((u) => (u as { state?: string }).state === "idle")).toHaveLength(1);
    expect(updates.filter((u) => u.sessionUpdate === "usage_update")).toHaveLength(1);
  });
});

test("asking for the context's parts gives up in time: the turn does not wait on a process that does not answer", async () => {
  const query = { getContextUsage: () => new Promise(() => {}) } as unknown as Query;
  const started = performance.now();
  expect(await askContext(query, 20)).toBeUndefined();
  expect(performance.now() - started).toBeLessThan(1000);
  expect(await askContext(undefined)).toBeUndefined();
});

test("a compaction cut short by the process going is ended, and the next one is announced", async () => {
  const status = (s: string | null) =>
    ({ type: "system", subtype: "status", status: s }) as unknown as SDKMessage;
  const fake = fakeQuery((call) =>
    call.prompt === "one"
      ? [status("compacting"), ...textTurn(ID, "m", "ok")]
      : [status("compacting"), status(null), ...textTurn(ID, "m", "ok")],
  );
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "one" }]);
      await new Promise((resolve) => setTimeout(resolve, 80)); // the process is let go: idleMs is 20
      await prompt(agent, idle, [{ type: "text", text: "two" }]);
      const statuses = updates
        .filter((u) => u.sessionUpdate === "compaction_update")
        .map((u) => (u as unknown as { status: string }).status);
      expect(statuses).toEqual(["in_progress", "cancelled", "in_progress", "completed"]);
    },
    {},
    { idleMs: 20 },
  );
});

test("a dismissed form ends the turn, as a dismissed permission card does", async () => {
  const { fake, seen } = asking("AskUserQuestion", input);
  await connect(
    fake.run,
    async ({ agent, idle }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "go" }]);
    },
    { elicitation: () => ({ action: "cancel" }) },
  );
  expect(seen.result).toEqual({ behavior: "deny", message: "Cancelled", interrupt: true });
});

test("a mode the process reports while the user's own is on its way does not undo it", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "one"
      ? textTurn(ID, "m", "ok")
      : ([
          { type: "system", subtype: "status", status: null, permissionMode: "default" },
          ...textTurn(ID, "m", "ok"),
        ] as unknown as SDKMessage[]),
  );
  fake.state.setterDelayMs = 60;
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "one" }]);
    await agent.request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "mode",
      type: "id",
      value: "acceptEdits",
    } as never);
    // The process's old news arrives while the change is still on its way.
    await prompt(agent, idle, [{ type: "text", text: "two" }]);
    expect(kinds(updates)).not.toContain("config_option_update");
    await new Promise((resolve) => setTimeout(resolve, 100)); // the change lands
    expect(fake.state.permissionModes).toEqual(["acceptEdits"]);
  });
});

test("a mention's name and address cannot end the tag they are in", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, idle }) => {
    await newSession(agent);
    await prompt(agent, idle, [
      { type: "text", text: "see" },
      { type: "resource_link", name: 'a"/><x y="', uri: "file:///a&b<c>" },
    ]);
  });
  expect(fake.contents[0]).toBe(
    'see\n\n<mention name="a&quot;/&gt;&lt;x y=&quot;" uri="file:///a&amp;b&lt;c&gt;"/>',
  );
});

test("a process let go that exits late does not end the turn of the one that replaced it", async () => {
  let openOld: () => void = () => undefined;
  let openTurn: () => void = () => undefined;
  const turnGate = new Promise<void>((resolve) => {
    openTurn = resolve;
  });
  const fake = fakeQuery(async ({ prompt: text }) => {
    if (text === "two") await turnGate;
    return textTurn(ID, text, "ok");
  });
  fake.state.holdExit = new Promise<void>((resolve) => {
    openOld = resolve;
  });
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "one" }]);
      await new Promise((resolve) => setTimeout(resolve, 80)); // let go: idleMs is 20
      fake.state.holdExit = undefined; // only the first process is slow to go
      const second = prompt(agent, idle, [{ type: "text", text: "two" }]);
      for (let waited = 0; !fake.prompts.includes("two"); waited += 5) {
        if (waited > 2_000) throw new Error("the second prompt never reached the process");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      openOld(); // the first process is gone now, with the second one in the middle of its turn
      await new Promise((resolve) => setTimeout(resolve, 40));
      const ended = updates.filter(
        (u) => u.sessionUpdate === "state_update" && (u as { state?: string }).state === "idle",
      );
      expect(ended.length).toBe(1); // the first turn's: the second has not ended
      openTurn();
      await second;
      const idles = updates.filter(
        (u) => u.sessionUpdate === "state_update" && (u as { state?: string }).state === "idle",
      );
      expect(idles.length).toBe(2);
      expect(idles[1]).toMatchObject({ stopReason: "end_turn" });
    },
    {},
    { idleMs: 20 },
  );
});

test("what Claude says on its own after a turn (a background task woke it) is a turn of its own, shown and ended", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m1", "first"));
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "start it" }]);
    const before = updates.length;
    // No prompt: the process answers a finished background task.
    const waiting = idle();
    fake.state.say(textTurn(ID, "m2", "the inventory is ready"));
    await waiting;
    const own = updates.slice(before);
    expect(kinds(own)).toEqual([
      "state_update",
      "agent_message_chunk",
      "agent_message_chunk",
      "state_update",
    ]);
    expect(own[0]).toMatchObject({ state: "running" });
    expect(own.at(-1)).toMatchObject({ state: "idle", stopReason: "end_turn" });
    const said = own
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => (u as { content: { text: string } }).content.text)
      .join("");
    expect(said).toBe("the inventory is ready");
    // And it is a turn like any: a prompt after it is answered.
    await prompt(agent, idle, [{ type: "text", text: "thanks" }]);
  });
});

test("a sub-agent's own talk between turns does not start a turn", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m1", "first"));
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "start it" }]);
    const before = updates.length;
    fake.state.say(
      textTurn(ID, "sub", "I am a helper").map((m) => ({
        ...m,
        parent_tool_use_id: "toolu_1",
      })) as never,
    );
    await Bun.sleep(50);
    expect(updates.slice(before)).toEqual([]);
  });
});

test("a turn Claude began by itself can be cancelled, and the next prompt is answered", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m1", "first"));
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "start it" }]);
      const before = updates.length;
      // It begins a message and goes quiet: the turn is running, with no result to come.
      fake.state.say(textTurn(ID, "m2", "working").slice(0, 3));
      const start = Date.now();
      while (!updates.slice(before).some((u) => (u as { state?: string }).state === "running")) {
        if (Date.now() - start > 2_000) throw new Error("the turn never began");
        await Bun.sleep(5);
      }
      const ended = idle();
      await agent.notify(methods.agent.session.cancel, { sessionId: ID });
      await ended;
      expect(updates.at(-1)).toMatchObject({ state: "idle", stopReason: "cancelled" });
      await prompt(agent, idle, [{ type: "text", text: "again" }]);
    },
    {},
    { cancelGraceMs: 50 },
  );
});

test("the background roster reconciles a missed terminal across turns and accepts the late outcome", async () => {
  const child = {
    task_id: "child",
    run_id: "2",
    task_type: "local_agent",
    tool_use_id: "call",
    is_backgrounded: true,
  };
  const fake = fakeQuery(({ prompt }) => [
    ...(prompt === "start"
      ? [task("task_started", child), task("background_tasks_changed", { tasks: [child] })]
      : prompt === "missing"
        ? [task("background_tasks_changed", { tasks: [] })]
        : [task("task_notification", { ...child, status: "completed" })]),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "start" }]);
      await Bun.sleep(90);
      expect(subs(updates)).toHaveLength(1);
      await prompt(agent, idle, [{ type: "text", text: "missing" }]);
      expect(subs(updates).at(-1)).toMatchObject({
        _meta: { "cycle/subagent": { status: "unknown", toolCallId: "call" } },
      });
      expect(subs(updates).at(-1)?.state).toBeUndefined();
      await prompt(agent, idle, [{ type: "text", text: "end" }]);
      expect(subs(updates).at(-1)?.state).toEqual({ state: "idle", stopReason: "end_turn" });
    },
    {},
    { idleMs: 40 },
  );
});

test("plan limits Claude Code learns from a response are told once each time they change, in milliseconds, only those it names", async () => {
  const rate = (utilization: number) =>
    ({
      type: "rate_limit_event",
      uuid: "r",
      session_id: ID,
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAt: 1_795_225_398,
        unifiedWindows: {
          five_hour: { utilization, resetsAt: 1_795_225_398, status: "allowed" },
          seven_day: { utilization: 0.31, resetsAt: 1_795_484_598, status: "allowed_warning" },
        },
      },
    }) as unknown as SDKMessage;
  const fake = fakeQuery((call) => {
    const turn = textTurn(ID, "m", "ok");
    const result = turn.pop() as SDKMessage;
    // The same twice in a turn, then a change in the next.
    const said = fake.prompts.at(-1) ?? call.prompt;
    if (said === "third")
      // An event about one limit only (no `unifiedWindows`): only that one is told; the daemon keeps the others.
      return [
        ...turn,
        {
          type: "rate_limit_event",
          uuid: "r",
          session_id: ID,
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "seven_day_opus",
            utilization: 1,
            resetsAt: 1_795_484_598,
          },
        } as unknown as SDKMessage,
        result,
      ];
    return said === "first"
      ? [...turn, rate(0.69), rate(0.69), result]
      : [...turn, rate(0.7), result];
  });
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "first" }]);
    await prompt(agent, idle, [{ type: "text", text: "second" }]);
    const told = updates.filter((u) => (u.sessionUpdate as string) === "_cycle/plan_usage");
    expect(told).toHaveLength(2);
    expect(told[0]).toMatchObject({
      windows: [
        { kind: "five_hour", utilization: 0.69, resetsAt: 1_795_225_398_000, status: "allowed" },
        {
          kind: "seven_day",
          utilization: 0.31,
          resetsAt: 1_795_484_598_000,
          status: "allowed_warning",
        },
      ],
    });
    expect(typeof (told[0] as unknown as { at: unknown }).at).toBe("number");
    expect(
      (told[1] as unknown as { windows: { utilization: number }[] }).windows[0]?.utilization,
    ).toBe(0.7);

    await prompt(agent, idle, [{ type: "text", text: "third" }]);
    const last = updates.filter((u) => (u.sessionUpdate as string) === "_cycle/plan_usage").at(-1);
    expect(
      (last as unknown as { windows: { kind: string; status?: string }[] }).windows.map(
        (w) => `${w.kind}:${w.status}`,
      ),
    ).toEqual(["seven_day_opus:rejected"]);
  });
});

test("a rate limit event without the windows says the one it is about; one that says nothing usable is nothing", () => {
  expect(
    planWindowsOf({
      status: "rejected",
      rateLimitType: "seven_day_opus",
      utilization: 1,
      resetsAt: 10,
    }),
  ).toEqual([{ kind: "seven_day_opus", utilization: 1, resetsAt: 10_000, status: "rejected" }]);
  expect(planWindowsOf({ status: "allowed" })).toEqual([]);
  expect(
    planWindowsOf({ unifiedWindows: { five_hour: { utilization: "x", resetsAt: 1 } } }),
  ).toEqual([]);
  expect(planWindowsOf(undefined)).toEqual([]);
  // A limit with no name is no limit: the daemon would refuse the whole usage for it.
  expect(planWindowsOf({ unifiedWindows: { "": { utilization: 0.1, resetsAt: 1 } } })).toEqual([]);
});

// ---- background tasks that are not sub-agents, and the goal (CYCL-87) ----

const tasksOf = (updates: SessionUpdate[]) =>
  updates.filter(
    (u) => (u as { sessionUpdate: string }).sessionUpdate === "_cycle/task_update",
  ) as unknown as Record<string, unknown>[];

test("a background command is told as a task, from start to end, and never as a sub-agent", async () => {
  const shell = {
    task_id: "b1",
    run_id: "1",
    task_type: "local_bash",
    tool_use_id: "call-b",
    description: "Run the dev server",
  };
  const quiet = { task_id: "w", task_type: "monitor", ambient: true, description: "watch" };
  const fake = fakeQuery(({ prompt }) => [
    ...(prompt === "start"
      ? [
          // The list names it before its start does, and without the tool call (SDK: the level comes first).
          task("background_tasks_changed", {
            tasks: [{ ...shell, tool_use_id: undefined }, quiet],
          }),
          task("task_started", shell),
          task("task_started", quiet),
        ]
      : [task("task_notification", { ...shell, status: "failed", summary: "exit 1" })]),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "start" }]);
    await prompt(agent, idle, [{ type: "text", text: "end" }]);
    expect(subs(updates)).toHaveLength(0);
    expect(tasksOf(updates)).toEqual([
      {
        sessionUpdate: "_cycle/task_update",
        taskId: "b1",
        kind: "shell",
        title: "Run the dev server",
        state: "running",
      },
      {
        sessionUpdate: "_cycle/task_update",
        taskId: "b1",
        kind: "shell",
        title: "Run the dev server",
        toolCallId: "call-b",
        state: "running",
      },
      { sessionUpdate: "_cycle/task_update", taskId: "b1", state: "failed" },
    ]);
  });
});

test("a Monitor's task is a monitor, though the SDK names it local_bash like any command (CYCL-120)", async () => {
  // As a real Claude sends it (SDK 0.3.327): the call, the list, then the start naming the call.
  const watch = {
    task_id: "bm",
    run_id: "1",
    task_type: "local_bash",
    description: "Watch the beats",
  };
  const call = (id: string, name: string) =>
    ({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: `m-${id}`,
        content: [{ type: "tool_use", id, name, input: { command: "tail" } }],
      },
    }) as unknown as SDKMessage;
  const result = (id: string) =>
    ({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "started" }] },
    }) as unknown as SDKMessage;
  const fake = fakeQuery(({ prompt }) =>
    prompt === "watch"
      ? [
          { type: "system", subtype: "init", session_id: ID } as unknown as SDKMessage,
          call("call-m", "Monitor"),
          task("background_tasks_changed", { tasks: [watch] }),
          task("task_started", { ...watch, tool_use_id: "call-m", is_backgrounded: true }),
          result("call-m"),
          // Its next run, heard of from the list alone: still a monitor.
          task("background_tasks_changed", { tasks: [{ ...watch, run_id: "2" }] }),
          // A second Monitor whose start comes after its call's result: the call is still known.
          call("call-n", "Monitor"),
          result("call-n"),
          task("task_started", { task_id: "bn", task_type: "local_bash", tool_use_id: "call-n" }),
          // And a plain background command stays a shell.
          call("call-b", "Bash"),
          task("task_started", { task_id: "bb", task_type: "local_bash", tool_use_id: "call-b" }),
          result("call-b"),
          ...textTurn(ID, "m2", "ok"),
        ]
      : textTurn(ID, "m3", "ok"),
  );
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "watch" }]);
    // The list comes first and cannot know; the start, which names the call, sets it right for good.
    expect(tasksOf(updates).map((u) => [u.taskId, u.kind, u.toolCallId])).toEqual([
      ["bm", "shell", undefined],
      ["bm", "monitor", "call-m"],
      ["bm", "monitor", undefined],
      ["bn", "monitor", "call-n"],
      ["bb", "shell", "call-b"],
    ]);
  });
});

test("a task gone from the background list with no end is unknown, and one left running ends with its process", async () => {
  const watcher = { task_id: "m1", task_type: "monitor_mcp", description: "Watch the logs" };
  const workflow = { task_id: "f1", task_type: "local_workflow", description: "spec" };
  const fake = fakeQuery(({ prompt }) =>
    prompt === "start"
      ? [task("task_started", watcher), task("task_started", workflow), ...textTurn(ID, "m", "ok")]
      : [task("background_tasks_changed", { tasks: [workflow] }), ...textTurn(ID, "m2", "ok")],
  );
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "start" }]);
      await prompt(agent, idle, [{ type: "text", text: "again" }]);
      expect(tasksOf(updates).map((u) => [u.taskId, u.kind, u.state])).toEqual([
        ["m1", "monitor", "running"],
        ["f1", "workflow", "running"],
        ["m1", undefined, "unknown"],
      ]);
      await agent.request(methods.agent.session.close, { sessionId: ID }).catch(() => undefined);
      const start = Date.now();
      while (!tasksOf(updates).some((u) => u.taskId === "f1" && u.state === "stopped")) {
        if (Date.now() - start > 2_000) throw new Error("the workflow never ended");
        await Bun.sleep(5);
      }
      expect(tasksOf(updates).some((u) => u.taskId === "m1" && u.state === "stopped")).toBe(false);
    },
    {},
    { idleMs: 20 },
  );
});

test("the goal set with /goal is told whole each time it is checked, and cleared as null", async () => {
  const goal = (value: unknown) =>
    ({ type: "active_goal", value, uuid: "g", session_id: ID }) as unknown as SDKMessage;
  const fake = fakeQuery(() => [
    goal({ condition: "all tests pass", iterations: 0, set_at: 1700, tokens_at_start: 5 }),
    goal({
      condition: "all tests pass",
      iterations: 1,
      set_at: 1700,
      tokens_at_start: 5,
      last_reason: "two still fail",
    }),
    goal(null),
    ...textTurn(ID, "m", "ok"),
  ]);
  await connect(fake.run, async ({ agent, idle, updates }) => {
    await newSession(agent);
    await prompt(agent, idle, [{ type: "text", text: "go" }]);
    const goals = updates.filter(
      (u) => (u as { sessionUpdate: string }).sessionUpdate === "_cycle/goal_update",
    );
    expect(goals).toEqual([
      {
        sessionUpdate: "_cycle/goal_update",
        goal: { condition: "all tests pass", iterations: 0, setAt: 1700 },
      },
      {
        sessionUpdate: "_cycle/goal_update",
        goal: {
          condition: "all tests pass",
          iterations: 1,
          setAt: 1700,
          lastReason: "two still fail",
        },
      },
      { sessionUpdate: "_cycle/goal_update", goal: null },
    ] as unknown as SessionUpdate[]);
  });
});

test("an ended task a late background list still names is not brought back, and a running one keeps the process", async () => {
  const shell = { task_id: "b1", run_id: "1", task_type: "local_bash", description: "dev server" };
  const fake = fakeQuery(({ prompt }) =>
    prompt === "start"
      ? [task("task_started", shell), ...textTurn(ID, "m", "ok")]
      : [
          task("task_notification", { ...shell, status: "completed", summary: "" }),
          // The list lags behind the end (SDK: their order is not promised).
          task("background_tasks_changed", { tasks: [shell, { task_id: "x", description: "?" }] }),
          ...textTurn(ID, "m2", "ok"),
        ],
  );
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      await prompt(agent, idle, [{ type: "text", text: "start" }]);
      // Well past the idle time: the command is running, so the process is kept and the task not ended.
      await Bun.sleep(80);
      expect(tasksOf(updates).map((u) => u.state)).toEqual(["running"]);
      await prompt(agent, idle, [{ type: "text", text: "end" }]);
      expect(tasksOf(updates).map((u) => [u.taskId, u.state])).toEqual([
        ["b1", "running"],
        ["b1", "completed"],
      ]);
    },
    {},
    { idleMs: 20 },
  );
});

// ---- what is set to wake the session (CYCL-146) ----

const schedulesOf = (updates: SessionUpdate[]) =>
  updates.filter(
    (u) => (u as { sessionUpdate: string }).sessionUpdate === "_cycle/schedule_update",
  ) as unknown as { jobs: Record<string, unknown>[]; dormant?: boolean }[];

test("a wakeup the model sets is told at once, then by the Stop hook's id, and the list says when the process is gone", async () => {
  const due = Date.now() + 3 * 60 * 60_000;
  const fake = fakeQuery(async (call) => {
    const turn = textTurn(ID, "m", "ok");
    if (call.prompt === "check back later")
      return [
        {
          type: "assistant",
          message: {
            id: "m0",
            content: [
              {
                type: "tool_use",
                id: "w1",
                name: "ScheduleWakeup",
                input: { delaySeconds: 3600, prompt: "Check the build" },
              },
            ],
          },
          parent_tool_use_id: null,
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }],
          },
          parent_tool_use_id: null,
          tool_use_result: { scheduledFor: due, clampedDelaySeconds: 3600, wasClamped: false },
        },
        ...turn,
      ] as unknown as SDKMessage[];
    // The next turn ends with the Stop hook: the wakeup is set, under its own id.
    await call.options.hooks?.Stop?.[0]?.hooks[0]?.(
      {
        hook_event_name: "Stop",
        session_crons: [
          // Set for its own minute, three hours on: a fixed hour would be within the hour of the clock once a day.
          {
            id: "c9",
            schedule: `${new Date(due).getMinutes()} ${new Date(due).getHours()} * * *`,
            recurring: false,
            prompt: "Check the build",
          },
        ],
      } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    return turn;
  });
  await connect(
    fake.run,
    async ({ agent, idle, updates }) => {
      await newSession(agent);
      // Three hours away: the process is let go after each turn, and the list says so.
      // Waited for, not slept on: on a slow machine the process is let go later than idleMs.
      const until = async (count: number) => {
        const start = Date.now();
        while (schedulesOf(updates).length < count && Date.now() - start < 3_000)
          await new Promise((resolve) => setTimeout(resolve, 10));
      };
      await prompt(agent, idle, [{ type: "text", text: "check back later" }]);
      await until(2);
      await prompt(agent, idle, [{ type: "text", text: "anything?" }]);
      await until(5);
      const told = schedulesOf(updates).map((u) => [
        u.jobs.map((j) => [j.id, j.kind, j.toolCallId]),
        u.dormant === true,
      ]);
      expect(told).toEqual([
        [[["wakeup:w1", "wakeup", "w1"]], false],
        [[["wakeup:w1", "wakeup", "w1"]], true],
        [[["wakeup:w1", "wakeup", "w1"]], false],
        [[["c9", "wakeup", "w1"]], false],
        [[["c9", "wakeup", "w1"]], true],
      ]);
      expect(schedulesOf(updates)[0]?.jobs[0]).toMatchObject({
        prompt: "Check the build",
        nextFireAt: due,
        recurring: false,
        durable: false,
      });
    },
    {},
    { idleMs: 40 },
  );
});

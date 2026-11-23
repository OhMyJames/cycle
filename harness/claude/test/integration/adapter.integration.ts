// Runs the adapter as a process, on the real Agent SDK and its bundled Claude binary, against a
// local mock of the Anthropic API. No account, no network. Run with:
//   bun run test:integration   (in harness/claude)
// It is not a *.test.ts, so the pre-commit gate does not run it: each run starts Claude processes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { ClaudePlugins } from "../../src/plugins.ts";
import { tempConfigDir, withAdapter } from "./adapter-process.ts";
import {
  heldTextReply,
  type MockRequest,
  sentText,
  startMock,
  textReply,
  toolReply,
} from "./mock-anthropic.ts";

const _ID = "7c1e2f30-1111-4222-8333-944455566677";
let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "cycle-v1-claude-cwd-"));
});
afterAll(() => rm(cwd, { recursive: true, force: true }));

const asked = (requests: MockRequest[]) => requests.filter((r) => r.path === "/v1/messages");

test("a new process resumes the session WITHOUT replayFrom, and the model has the context", async () => {
  const mock = startMock(() => textReply("Noted."));
  const config = await tempConfigDir();
  const id = "8d2f3041-2222-4333-8444-a55566677788";
  try {
    await withAdapter({ mockUrl: mock.url, configDir: config.dir }, async ({ agent, idle }) => {
      await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
      const done = idle();
      await agent.request(methods.agent.session.prompt, {
        sessionId: id,
        prompt: [{ type: "text", text: "Remember the word PINEAPPLE." }],
      });
      await done;
    });
    // The first process is gone. A second one, with the same config directory, picks it up.
    await withAdapter(
      { mockUrl: mock.url, configDir: config.dir },
      async ({ agent, updates, idle }) => {
        await agent.request(methods.agent.session.resume, { sessionId: id, cwd });
        // ACP v2: it sends its state, and no replay was asked for. The client records a notification
        // and an answer separately, so give the notification a moment instead of assuming an order.
        for (let waited = 0; updates.length === 0 && waited < 2_000; waited += 20)
          await Bun.sleep(20);
        expect(updates.map((u) => u.sessionUpdate)).toEqual(["state_update"]);
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text: "What was the word?" }],
        });
        await done;
      },
    );
    const last = asked(mock.requests).at(-1);
    const seen = sentText(last?.body);
    console.log("messages sent on the resumed turn:", seen.slice(0, 400));
    expect(seen).toContain("PINEAPPLE");
    expect(seen).toContain("What was the word?");
  } finally {
    mock.stop();
    await config.dispose();
  }
}, 60_000);

test("a tool call asks permission through ACP, and the answer decides", async () => {
  for (const answer of ["allow", "deny"] as const) {
    const mock = startMock((requests) =>
      JSON.stringify(asked(requests).at(-1)?.body).includes("tool_result")
        ? textReply("Done.")
        : toolReply("Bash", { command: `touch created-by-${answer}.txt` }),
    );
    const config = await tempConfigDir();
    const id =
      answer === "allow"
        ? "9e304152-3333-4444-8555-b66677788899"
        : "af415263-4444-4555-8666-c7778889990a";
    try {
      await withAdapter(
        { mockUrl: mock.url, configDir: config.dir, onPermission: () => answer },
        async ({ agent, updates, permissions, idle }) => {
          await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
          // The mode that asks first: new sessions start in auto, where this may not be asked about.
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: id,
            configId: "mode",
            type: "id",
            value: "default",
          } as never);
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: [{ type: "text", text: "Run echo." }],
          });
          expect(await done).toMatchObject({ stopReason: "end_turn" });
          expect(permissions).toHaveLength(1);
          console.log(answer, "permission request:", JSON.stringify(permissions[0]).slice(0, 300));
          const tool = updates.filter((u) => u.sessionUpdate === "tool_call_update") as unknown as {
            status?: string;
            content?: { content: { text: string } }[];
          }[];
          console.log(answer, "tool statuses:", tool.map((u) => u.status).join(", "));
          const last = tool.at(-1);
          if (answer === "allow") {
            expect(last?.status).toBe("completed");
          } else {
            expect(last?.status).toBe("failed");
          }
          // The answer really decided: the file exists only if the tool was allowed to run.
          expect(await Bun.file(join(cwd, `created-by-${answer}.txt`)).exists()).toBe(
            answer === "allow",
          );
        },
      );
    } finally {
      mock.stop();
      await config.dispose();
    }
  }
}, 60_000);

test("cancel, while the model is still writing, stops the turn and the rest never streams", async () => {
  const held = heldTextReply("The first part. ", "THE SECOND PART THAT MUST NOT ARRIVE.");
  const mock = startMock(() => held.body);
  const config = await tempConfigDir();
  const id = "b0526374-5555-4666-8777-d8889990aa1b";
  try {
    await withAdapter(
      { mockUrl: mock.url, configDir: config.dir },
      async ({ agent, updates, idle }) => {
        await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text: "Go." }],
        });
        // Wait until the first words have really streamed to the client.
        const started = Date.now();
        while (!updates.some((u) => u.sessionUpdate === "agent_message_chunk")) {
          if (Date.now() - started > 30_000) throw new Error("the model never started writing");
          await Bun.sleep(20);
        }
        const cancelledAt = Date.now();
        await agent.notify(methods.agent.session.cancel, { sessionId: id });
        const end = await Promise.race([
          done,
          Bun.sleep(8_000).then(() => {
            throw new Error("the turn did not end within 8s of the cancel");
          }),
        ]);
        console.log("ended", Date.now() - cancelledAt, "ms after the cancel:", JSON.stringify(end));
        expect(end).toMatchObject({ state: "idle", stopReason: "cancelled" });
        // Now let the model carry on. Nothing more may reach the client.
        held.release();
        await Bun.sleep(1_000);
        const text = updates
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => (u as unknown as { content: { text: string } }).content.text)
          .join("");
        expect(text).toContain("The first part.");
        expect(text).not.toContain("MUST NOT ARRIVE");
        expect(updates.at(-1)).toMatchObject({ state: "idle", stopReason: "cancelled" });
      },
    );
  } finally {
    held.release();
    mock.stop();
    await config.dispose();
  }
}, 60_000);

test("an image, a PDF and a text file reach the model as content, not as nothing", async () => {
  const mock = startMock(() => textReply("I see them."));
  const config = await tempConfigDir();
  const id = "9e304152-3333-4444-8555-b66677788899";
  // A real 1x1 PNG: the Claude process reads the image header, and drops what it cannot read.
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const pdf = Buffer.from("%PDF-1.4 not really").toString("base64");
  try {
    await withAdapter({ mockUrl: mock.url, configDir: config.dir }, async ({ agent, idle }) => {
      await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
      const done = idle();
      await agent.request(methods.agent.session.prompt, {
        sessionId: id,
        prompt: [
          { type: "text", text: "What are these?" },
          { type: "image", data: png, mimeType: "image/png" },
          { type: "resource", resource: { uri: "file:///notes.md", text: "ZEBRA notes" } },
          {
            type: "resource",
            resource: { uri: "file:///a.pdf", mimeType: "application/pdf", blob: pdf },
          },
        ],
      } as never);
      await done;
    });
    const body = JSON.stringify(asked(mock.requests).at(-1)?.body);
    expect(body).toContain("What are these?");
    expect(body).toContain(png); // the image, base64, as an image block
    expect(body).toContain('"type":"image"');
    expect(body).toContain("ZEBRA notes");
    expect(body).toContain('<file uri=\\"file:///notes.md\\">');
    expect(body).toContain(pdf);
    expect(body).toContain('"type":"document"');
  } finally {
    mock.stop();
    await config.dispose();
  }
}, 60_000);

test("MCP servers, an added directory and an appended system prompt reach the real Claude process", async () => {
  const mock = startMock(() => textReply("Ok."));
  const config = await tempConfigDir();
  const id = "af415263-4444-4555-8666-c77788899900";
  const server = new URL("./mcp-server.ts", import.meta.url).pathname;
  const extra = await mkdtemp(join(tmpdir(), "cycle-v1-claude-extra-"));
  try {
    await withAdapter({ mockUrl: mock.url, configDir: config.dir }, async ({ agent, idle }) => {
      await agent.request(methods.agent.session.new, {
        cwd,
        _meta: { "cycle/sessionId": id },
        additionalDirectories: [extra],
        mcpServers: [
          {
            name: "files",
            type: "stdio",
            command: process.execPath,
            args: [server],
            env: [{ name: "TOKEN", value: "s3cret_from_env" }],
          },
        ],
        systemPrompt: {
          mode: "append",
          content: [{ type: "text", text: "ALWAYS-ANSWER-IN-FRENCH" }],
        },
      } as never);
      const done = idle();
      await agent.request(methods.agent.session.prompt, {
        sessionId: id,
        prompt: [{ type: "text", text: "hello" }],
      });
      await done;
      // The Claude process is still alive. Its command line, and every other process's, is readable
      // by anyone on the machine: the server's secret must not be on any of them.
      if (existsSync("/proc/self/cmdline")) {
        const lines: string[] = [];
        for (const pid of await readdir("/proc")) {
          if (!/^\d+$/.test(pid)) continue;
          lines.push(await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => ""));
        }
        // The scan is only worth something if it sees the process: Claude is started with the session's id.
        expect(lines.some((line) => line.includes(id))).toBe(true);
        expect(lines.filter((line) => line.includes("s3cret_from_env"))).toEqual([]);
      }
    });
    const body = JSON.stringify(asked(mock.requests).at(-1)?.body);
    // The server started, with its env, and its tool was offered to the model.
    const found = {
      tool: body.includes("mcp__files__token_"),
      env: body.includes("mcp__files__token_s3cret_from_env"),
      prompt: body.includes("ALWAYS-ANSWER-IN-FRENCH"),
      directory: body.includes(extra),
    };
    console.log("what reached the model:", JSON.stringify(found));
    expect(found).toEqual({ tool: true, env: true, prompt: true, directory: true });
    // The secret was not on any command line of ours; the process list is the thing that would show it.
  } finally {
    mock.stop();
    await config.dispose();
    await rm(extra, { recursive: true, force: true });
  }
}, 60_000);

/**
 * A project folder whose own `.mcp.json` names an http MCP server that wants a key, and gets it from a
 * `headersHelper`, as a project would from its `.env`. The server answers only with the key.
 */
const projectWithHelper = async (url: string) => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-v1-claude-project-"));
  await Bun.write(
    join(dir, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        proj: {
          type: "http",
          url,
          headersHelper: `echo '{"Authorization":"Bearer helper-ran-4417"}'`,
        },
      },
    }),
  );
  await Bun.write(
    join(dir, ".claude", "settings.local.json"),
    JSON.stringify({ enableAllProjectMcpServers: true }),
  );
  return dir;
};

/** An http MCP server with one tool, that refuses whoever does not bring the helper's key. */
const keyedMcp = () => {
  const seen: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      seen.push(request.headers.get("authorization"));
      if (request.headers.get("authorization") !== "Bearer helper-ran-4417")
        return new Response("unauthorized", { status: 401 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = (await request.json()) as { id?: number; method: string };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "proj", version: "0" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "keyed_ping",
                    description: "Answers when the key was right.",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            : {};
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, seen, stop: () => server.stop(true) };
};

test("a project's headersHelper runs only in a folder the daemon says is trusted", async () => {
  const mock = startMock(() => textReply("Ok."));
  const mcp = keyedMcp();
  const config = await tempConfigDir();
  const trusted = await projectWithHelper(mcp.url);
  const untrusted = await projectWithHelper(mcp.url);
  const toolsOffered = async (dir: string, id: string, meta: Record<string, unknown>) =>
    withAdapter({ mockUrl: mock.url, configDir: config.dir }, async ({ agent, idle }) => {
      await agent.request(methods.agent.session.new, {
        cwd: dir,
        _meta: { "cycle/sessionId": id, ...meta },
      } as never);
      const done = idle();
      await agent.request(methods.agent.session.prompt, {
        sessionId: id,
        prompt: [{ type: "text", text: "hello" }],
      });
      await done;
      return JSON.stringify(asked(mock.requests).at(-1)?.body).includes("mcp__proj__keyed_ping");
    });
  try {
    // Nobody decided: Claude does not run the folder's helper, so the server never gets the key.
    expect(await toolsOffered(untrusted, "b1526374-5555-4666-8777-d88899900011", {})).toBe(false);
    expect(mcp.seen.filter((auth) => auth !== null)).toEqual([]);
    // Trusted: the helper runs, the key reaches the server, and its tool is offered to the model.
    expect(
      await toolsOffered(trusted, "c2637485-6666-4777-8888-e99900011122", {
        "cycle/trusted": true,
      }),
    ).toBe(true);
    expect(mcp.seen).toContain("Bearer helper-ran-4417");
  } finally {
    mock.stop();
    mcp.stop();
    await config.dispose();
    await rm(trusted, { recursive: true, force: true });
    await rm(untrusted, { recursive: true, force: true });
  }
}, 90_000);

test("the adapter announces the commands the real Claude process has", async () => {
  const mock = startMock(() => textReply("Ok."));
  const config = await tempConfigDir();
  const id = "b0526374-5555-4666-8777-d88899900011";
  try {
    await withAdapter(
      { mockUrl: mock.url, configDir: config.dir },
      async ({ agent, idle, updates }) => {
        await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text: "hello" }],
        });
        await done;
        const commands = updates.find((u) => u.sessionUpdate === "available_commands_update") as
          | { availableCommands: { type: string; name: string; description: string }[] }
          | undefined;
        expect(commands?.availableCommands.length).toBeGreaterThan(0);
        expect(commands?.availableCommands[0]).toMatchObject({ type: "command" });
      },
    );
  } finally {
    mock.stop();
    await config.dispose();
  }
}, 60_000);

test("with warmStart the real Claude process has the commands before any prompt, and then takes the first prompt", async () => {
  const mock = startMock(() => textReply("Ok."));
  const config = await tempConfigDir();
  const id = "b0526374-5555-4666-8777-d88899900022";
  try {
    await withAdapter(
      { mockUrl: mock.url, configDir: config.dir, adapter: { warmStart: true } },
      async ({ agent, idle, updates }) => {
        await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
        const deadline = Date.now() + 20_000;
        const commands = () =>
          updates.filter((u) => u.sessionUpdate === "available_commands_update");
        while (commands().length === 0 && Date.now() < deadline) await Bun.sleep(50);
        expect(commands().length).toBe(1);
        // Learning them did not need a turn: nothing the user typed has been sent anywhere.
        expect(mock.requests.filter((r) => r.method === "POST")).toEqual([]);
        // The process that was started ahead takes the first prompt, and the session exists after it.
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text: "hello" }],
        });
        await done;
        const stop = updates.filter((u) => (u as { stopReason?: string }).stopReason !== undefined);
        expect((stop.at(-1) as { stopReason: string }).stopReason).toBe("end_turn");
        expect(commands().length).toBe(1);
      },
    );
    // And it is on disk for the next process to resume.
    await withAdapter(
      { mockUrl: mock.url, configDir: config.dir },
      async ({ agent, idle, updates }) => {
        await agent.request(methods.agent.session.resume, { sessionId: id, cwd });
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text: "again" }],
        });
        await done;
        const stop = updates.filter((u) => (u as { stopReason?: string }).stopReason !== undefined);
        expect((stop.at(-1) as { stopReason: string }).stopReason).toBe("end_turn");
      },
    );
  } finally {
    mock.stop();
    await config.dispose();
  }
}, 90_000);

const questions = {
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
  ],
};

test("AskUserQuestion on the real Claude process: a form when a client can answer, a permission card when none can", async () => {
  for (const capable of [true, false]) {
    const mock = startMock((requests) =>
      JSON.stringify(asked(requests).at(-1)?.body).includes("tool_result")
        ? textReply("Noted.")
        : toolReply("AskUserQuestion", questions),
    );
    const config = await tempConfigDir();
    const id = capable
      ? "c1637485-6666-4777-8888-e99900011122"
      : "d2748596-7777-4888-8999-fa0011223344";
    try {
      const seen = await withAdapter(
        {
          mockUrl: mock.url,
          configDir: config.dir,
          ...(capable
            ? { onElicitation: () => ({ action: "accept", content: { q0: "luxon" } }) }
            : {}),
        },
        async ({ agent, idle, permissions, elicitations }) => {
          await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: [{ type: "text", text: "pick a date library" }],
          });
          await done;
          return { permissions: permissions.length, elicitations: elicitations.length };
        },
      );
      const last = JSON.stringify(asked(mock.requests).at(-1)?.body);
      console.log(capable ? "capable" : "not capable", JSON.stringify(seen));
      // A client that did not say it can answer forms is not sent one; either way the tool then ran.
      expect(seen.elicitations).toBe(capable ? 1 : 0);
      expect(seen.permissions).toBe(capable ? 0 : 1);
      expect(last).toContain("tool_result");
      if (capable) expect(last).toContain("luxon"); // the answer is what the tool told the model
    } finally {
      mock.stop();
      await config.dispose();
    }
  }
}, 90_000);

test("AskUserQuestion on the real Claude process: what a person wrote is the answer the model gets", async () => {
  const mock = startMock((requests) =>
    JSON.stringify(asked(requests).at(-1)?.body).includes("tool_result")
      ? textReply("Noted.")
      : toolReply("AskUserQuestion", questions),
  );
  const config = await tempConfigDir();
  const id = "c1637485-6666-4777-8888-e99900011133";
  try {
    await withAdapter(
      {
        mockUrl: mock.url,
        configDir: config.dir,
        onElicitation: () => ({ action: "accept", content: { q0_other: "Temporal" } }),
      },
      async ({ agent, idle, elicitations }) => {
        await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text: "pick a date library" }],
        });
        await done;
        const form = elicitations[0] as {
          requestedSchema: { properties: Record<string, unknown> };
        };
        expect(Object.keys(form.requestedSchema.properties)).toEqual(["q0", "q0_other"]);
      },
    );
    const last = JSON.stringify(asked(mock.requests).at(-1)?.body);
    expect(last).toContain("tool_result");
    expect(last).toContain("Temporal");
  } finally {
    mock.stop();
    await config.dispose();
  }
}, 90_000);

test("a session made and never prompted, in a new process: the first message completes (and the model gets it)", async () => {
  const mock = startMock(() => textReply("Hello."));
  const config = await tempConfigDir();
  const id = "9e304152-3333-4444-8555-b66677788899";
  try {
    // Made, and the process goes away before any prompt: Claude never wrote the session.
    await withAdapter({ mockUrl: mock.url, configDir: config.dir }, async ({ agent }) => {
      await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
    });
    await withAdapter(
      { mockUrl: mock.url, configDir: config.dir },
      async ({ agent, updates, idle }) => {
        await agent.request(methods.agent.session.resume, { sessionId: id, cwd });
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text: "first message" }],
        });
        await done;
        // The turn's own end: an idle that says why (the state it was in before is also an idle).
        const stops = () =>
          updates
            .map((u) => (u as { stopReason?: string }).stopReason)
            .filter((reason) => reason !== undefined);
        for (let waited = 0; stops().length === 0 && waited < 5_000; waited += 20)
          await Bun.sleep(20);
        expect(stops()).toEqual(["end_turn"]);
      },
    );
    expect(sentText(asked(mock.requests).at(-1)?.body)).toContain("first message");
  } finally {
    mock.stop();
    await config.dispose();
  }
}, 60_000);

test("a session that had a turn answered, whose record Claude no longer has, is not started over: the resume says so", async () => {
  const mock = startMock(() => textReply("Noted."));
  const config = await tempConfigDir();
  const id = "ae415263-4444-4555-8666-c77788899900";
  try {
    // A new, empty configuration directory: what the daemon remembers of the session is not there.
    await withAdapter({ mockUrl: mock.url, configDir: config.dir }, async ({ agent }) => {
      await expect(
        agent.request(methods.agent.session.resume, {
          sessionId: id,
          cwd,
          _meta: { "cycle/hadTurn": true },
        }),
      ).rejects.toMatchObject({ code: -32603 });
    });
    expect(asked(mock.requests)).toHaveLength(0);
  } finally {
    mock.stop();
    await config.dispose();
  }
}, 60_000);

test("a session that had a turn answered, whose record is there, is resumed with its context", async () => {
  const mock = startMock(() => textReply("Noted."));
  const config = await tempConfigDir();
  const id = "bf526374-5555-4666-8777-d88899900011";
  try {
    await withAdapter({ mockUrl: mock.url, configDir: config.dir }, async ({ agent, idle }) => {
      await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
      const done = idle();
      await agent.request(methods.agent.session.prompt, {
        sessionId: id,
        prompt: [{ type: "text", text: "Remember the word MANGO." }],
      });
      await done;
    });
    await withAdapter({ mockUrl: mock.url, configDir: config.dir }, async ({ agent, idle }) => {
      // The daemon says a turn was answered; Claude has its record, so this is a resume as any other.
      await agent.request(methods.agent.session.resume, {
        sessionId: id,
        cwd,
        _meta: { "cycle/hadTurn": true },
      });
      const done = idle();
      await agent.request(methods.agent.session.prompt, {
        sessionId: id,
        prompt: [{ type: "text", text: "What was the word?" }],
      });
      await done;
    });
    expect(sentText(asked(mock.requests).at(-1)?.body)).toContain("MANGO");
  } finally {
    mock.stop();
    await config.dispose();
  }
}, 60_000);

/** Waits, for at most `ms`, until `ok` holds. */
const waitUntil = async (ok: () => boolean, what: string, ms = 30_000) => {
  const started = Date.now();
  while (!ok()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

const idles = (updates: { sessionUpdate: string }[]) =>
  updates.filter(
    (u) => u.sessionUpdate === "state_update" && (u as { state?: string }).state === "idle",
  );

test("a prompt steered in while a tool runs reaches the model in the same turn, with the tool's result", async () => {
  const mock = startMock((requests) =>
    JSON.stringify(asked(requests).at(-1)?.body).includes("tool_result")
      ? textReply("Done.")
      : toolReply("Bash", { command: "sleep 2; echo slept" }),
  );
  const config = await tempConfigDir();
  const id = "c1637485-6666-4777-8888-e999aaa0bb2c";
  try {
    await withAdapter(
      { mockUrl: mock.url, configDir: config.dir },
      async ({ agent, updates, idle }) => {
        await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
        // Nothing to ask: the model's tool call runs while the prompt is steered in.
        await agent.request(methods.agent.session.setConfigOption, {
          sessionId: id,
          configId: "mode",
          type: "id",
          value: "bypassPermissions",
        } as never);
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text: "Sleep a little." }],
        });
        await waitUntil(
          () => updates.some((u) => u.sessionUpdate === "tool_call_update"),
          "the tool call",
        );
        const answer = (await agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text: "ALSO MIND THIS" }],
          _meta: { "cycle/steer": true },
        })) as { messageId: string };
        expect(await done).toMatchObject({ stopReason: "end_turn" });
        expect(
          updates.some(
            (u) =>
              u.sessionUpdate === "user_message" &&
              (u as { messageId?: string }).messageId === answer.messageId,
          ),
        ).toBe(true);
        // The model was sent it, after the tool call it was steered in during.
        const withIt = asked(mock.requests).filter((r) =>
          sentText(r.body).includes("ALSO MIND THIS"),
        );
        expect(withIt.length).toBeGreaterThan(0);
        await Bun.sleep(500);
        expect(idles(updates)).toHaveLength(1);
      },
    );
  } finally {
    mock.stop();
    await config.dispose();
  }
}, 60_000);

test("a prompt steered in as the model finishes its answer is answered before the turn ends", async () => {
  const held = heldTextReply("Writing. ", "Written.");
  let used = false;
  const mock = startMock((requests) => {
    if (!used && requests.at(-1)?.path === "/v1/messages") {
      used = true;
      return held.body;
    }
    return textReply("Noted.");
  });
  const config = await tempConfigDir();
  const id = "d2748596-7777-4888-8999-faaabbb1cc3d";
  try {
    await withAdapter(
      { mockUrl: mock.url, configDir: config.dir },
      async ({ agent, updates, idle }) => {
        await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text: "Write." }],
        });
        await waitUntil(
          () => updates.some((u) => u.sessionUpdate === "agent_message_chunk"),
          "the model to start writing",
        );
        await agent.request(methods.agent.session.prompt, {
          sessionId: id,
          prompt: [{ type: "text", text: "ONE MORE THING" }],
          _meta: { "cycle/steer": true },
        });
        await Bun.sleep(300);
        held.release();
        expect(await done).toMatchObject({ stopReason: "end_turn" });
        // Answered, whether Claude took it into the turn or as one of its own after it.
        expect(asked(mock.requests).some((r) => sentText(r.body).includes("ONE MORE THING"))).toBe(
          true,
        );
        await Bun.sleep(500);
        expect(idles(updates)).toHaveLength(1);
        const text = updates
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => (u as unknown as { content: { text: string } }).content.text)
          .join("");
        expect(text).toContain("Noted.");
      },
    );
  } finally {
    held.release();
    mock.stop();
    await config.dispose();
  }
}, 60_000);

test("a real Claude background Agent outlives its parent turn and reports its end", async () => {
  const held = heldTextReply("Checking ", "finished.");
  let launched = false;
  let childStarted = false;
  const mock = startMock((requests) => {
    const messages = sentText(asked(requests).at(-1)?.body);
    if (
      !launched &&
      !messages.includes("<session>") &&
      messages.includes("Start the background check")
    ) {
      launched = true;
      return toolReply("Agent", {
        description: "Check the fixture",
        subagent_type: "general-purpose",
        prompt: "Respond to CHILD-FIXTURE-921.",
        run_in_background: true,
      });
    }
    if (
      !childStarted &&
      messages.includes("CHILD-FIXTURE-921") &&
      !messages.includes("Start the background check")
    ) {
      childStarted = true;
      return held.body;
    }
    return textReply("Parent turn finished.");
  });
  const config = await tempConfigDir();
  try {
    await withAdapter(
      {
        mockUrl: mock.url,
        configDir: config.dir,
        adapter: { idleMs: 150 },
        onPermission: () => "allow",
      },
      async ({ agent, updates, idle }) => {
        const sessionId = "d2026374-5555-4666-8777-d8889990aa1c";
        await agent.request(methods.agent.session.new, {
          cwd,
          _meta: { "cycle/sessionId": sessionId },
        });
        await agent.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: "mode",
          type: "id",
          value: "default",
        } as never);
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "Start the background check" }],
        });
        expect(await done).toMatchObject({ stopReason: "end_turn" });
        const states = () =>
          updates
            .filter((u) => u.sessionUpdate === "subagent_update")
            .map(
              (u) =>
                u as unknown as {
                  state?: { state?: string };
                  _meta?: Record<string, { background?: boolean }>;
                },
            );
        const deadline = Date.now() + 12_000;
        while (
          (!childStarted || !states().some((u) => u._meta?.["cycle/subagent"]?.background)) &&
          Date.now() < deadline
        )
          await Bun.sleep(20);
        expect(childStarted).toBe(true);
        expect(states().some((u) => u._meta?.["cycle/subagent"]?.background)).toBe(true);
        expect(states().some((u) => u.state?.state === "idle")).toBe(false);
        await Bun.sleep(350);
        expect(states().some((u) => u.state?.state === "idle")).toBe(false);
        held.release();
        const end = Date.now() + 12_000;
        while (!states().some((u) => u.state?.state === "idle") && Date.now() < end)
          await Bun.sleep(20);
        expect(states().some((u) => u.state?.state === "idle")).toBe(true);
      },
    );
  } finally {
    held.release();
    mock.stop();
    await config.dispose();
  }
}, 45_000);

// Plugins (docs/protocol.md §15, CYCL-83): Claude's own command line in a configuration directory of the test's, and
// a session that is given a server under the plugin's name for it. No model is asked anything.
test("a plugin is added from a source, installed, loaded by a session with its http server stood in for, and removed", async () => {
  const mock = startMock(() => textReply("ok"));
  const config = await tempConfigDir();
  const market = await mkdtemp(join(tmpdir(), "cycle-v1-claude-market-"));
  const hits = { plugin: 0, given: 0 };
  // What the plugin declares: never to be reached once something stands in for it.
  const declared = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      hits.plugin += 1;
      return new Response("no", { status: 401 });
    },
  });
  // What the session is given in its place (in Cycle: the daemon's gateway).
  const given = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      hits.given += 1;
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = (await request.json()) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "given", version: "1" },
            }
          : { tools: [] };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  try {
    const plugin = join(market, "plugins", "demo");
    await mkdir(join(market, ".claude-plugin"), { recursive: true });
    await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
    await mkdir(join(plugin, "skills", "hello"), { recursive: true });
    await writeFile(
      join(market, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "local-market",
        owner: { name: "Test" },
        plugins: [
          { name: "demo", source: "./plugins/demo", description: "Demo plugin", version: "1.0.0" },
        ],
      }),
    );
    await writeFile(
      join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "demo", description: "Demo plugin", version: "1.0.0" }),
    );
    await writeFile(
      join(plugin, "skills", "hello", "SKILL.md"),
      "---\nname: hello\ndescription: Say hello\n---\nSay hello.\n",
    );
    await writeFile(
      join(plugin, ".mcp.json"),
      JSON.stringify({
        mcpServers: { remote: { type: "http", url: `http://127.0.0.1:${declared.port}/mcp` } },
      }),
    );

    const plugins = new ClaudePlugins({
      env: { PATH: process.env.PATH ?? "", HOME: config.dir, CLAUDE_CONFIG_DIR: config.dir },
      cwd: join(config.dir, "no-project"),
    });
    expect(await plugins.addSource(market)).toBe("local-market");
    const before = await plugins.snapshot();
    expect(before.sources).toContainEqual({
      id: "local-market",
      name: "local-market",
      kind: "directory",
      removable: true,
      location: market,
    });
    expect(before.installed).toEqual([]);
    expect(before.available.find((p) => p.id === "demo@local-market")).toMatchObject({
      name: "demo",
      description: "Demo plugin",
      installed: false,
    });

    await plugins.install("demo@local-market");
    const [installed] = (await plugins.snapshot()).installed;
    expect(installed).toMatchObject({
      id: "demo@local-market",
      enabled: true,
      scope: "user",
      contents: { skills: 1, commands: 0, agents: 0, hooks: 0, mcpServers: 1 },
      servers: [
        {
          name: "remote",
          agentName: "plugin:demo:remote",
          http: { url: `http://127.0.0.1:${declared.port}/mcp`, headers: {} },
        },
      ],
    });
    const agentName = installed?.servers?.[0]?.agentName ?? "";

    // A session loads the plugin by itself; the server it is given under the plugin's name is the one it reaches.
    await withAdapter(
      { mockUrl: mock.url, configDir: config.dir, adapter: { warmStart: true } },
      async ({ agent, updates }) => {
        await agent.request(methods.agent.session.new, {
          cwd,
          mcpServers: [
            {
              type: "http",
              name: agentName,
              url: `http://127.0.0.1:${given.port}/mcp`,
              headers: [],
            },
          ],
          _meta: { "cycle/sessionId": "9e304152-3333-4444-8555-b66677788899" },
        } as never);
        const started = Date.now();
        const commands = () =>
          updates.flatMap((u) =>
            u.sessionUpdate === "available_commands_update"
              ? (u as { availableCommands: { name: string }[] }).availableCommands.map(
                  (c) => c.name,
                )
              : [],
          );
        while (hits.given === 0 || !commands().includes("demo:hello")) {
          if (Date.now() - started > 30_000)
            throw new Error(`timed out: given=${hits.given} commands=${commands().join(",")}`);
          await Bun.sleep(50);
        }
      },
    );
    expect(hits.plugin).toBe(0);

    await plugins.setEnabled("demo@local-market", false);
    expect((await plugins.snapshot()).installed[0]?.enabled).toBe(false);
    expect(await plugins.update("demo@local-market")).toEqual({ updated: false });
    await plugins.uninstall("demo@local-market");
    expect((await plugins.snapshot()).installed).toEqual([]);
    await plugins.removeSource("local-market");
    await expect(plugins.install("demo@local-market")).rejects.toMatchObject({
      reason: "not_found",
    });
  } finally {
    declared.stop(true);
    given.stop(true);
    mock.stop();
    await config.dispose();
    await rm(market, { recursive: true, force: true });
  }
}, 80_000);

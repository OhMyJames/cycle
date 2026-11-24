import { expect, test } from "bun:test";
import { client, methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { type AdapterConfig, createAgent } from "../src/index.ts";
import { fakeQuery, textTurn } from "./fake-query.ts";

const ID = "5b0c3a3e-8a52-4d3f-9a0e-1c2d3e4f5a6b";

/** An ACP client wired straight to the adapter in this process. */
const connect = async <T>(
  runQuery: ReturnType<typeof fakeQuery>["run"],
  body: (api: {
    agent: Parameters<Parameters<ReturnType<typeof client>["connectWith"]>[1]>[0];
    updates: SessionUpdate[];
    waitForIdle: () => Promise<SessionUpdate>;
  }) => Promise<T>,
  onPermission?: () => "allow" | "deny" | "cancel" | Promise<never>,
  config: Partial<AdapterConfig> = {},
): Promise<T> => {
  const updates: SessionUpdate[] = [];
  const waiting: ((u: SessionUpdate) => void)[] = [];
  const app = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
      const update = params.update as { sessionUpdate: string; state?: string };
      if (update.sessionUpdate === "state_update" && update.state === "idle") {
        for (const resolve of waiting.splice(0)) resolve(params.update);
      }
    })
    .onRequest(methods.client.session.requestPermission, async () => {
      const answer = (await onPermission?.()) ?? "allow";
      return answer === "cancel"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: answer } };
    });
  const adapter = createAgent({ env: {}, ...config }, runQuery);
  return app.connectWith(adapter, async (agent) => {
    await agent.request(methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "test", version: "0" },
    } as never);
    return body({
      agent,
      updates,
      waitForIdle: () => new Promise((resolve) => waiting.push(resolve)),
    });
  });
};

const kinds = (updates: SessionUpdate[]) => updates.map((u) => u.sessionUpdate);

test("a prompt answers at once, then streams, and ends with an idle state_update", async () => {
  const fake = fakeQuery(() => textTurn(ID, "msg_1", "Hello there"));
  await connect(fake.run, async ({ agent, updates, waitForIdle }) => {
    const created = await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    // The agent took the id the daemon proposed.
    expect(created.sessionId).toBe(ID);

    const idle = waitForIdle();
    const answer = await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "Say hello" }],
    });
    expect(answer.messageId).toBeString();
    const end = await idle;
    expect(end).toMatchObject({ state: "idle", stopReason: "end_turn" });

    expect(kinds(updates)).toEqual([
      "user_message",
      "state_update",
      "agent_message_chunk",
      "agent_message_chunk",
      "state_update",
    ]);
    // The user message carries the id the prompt answered with.
    expect(updates[0]).toMatchObject({ messageId: answer.messageId });
    expect(updates[1]).toMatchObject({ state: "running" });
  });
  // First turn creates the session under the proposed id.
  expect(fake.calls[0]?.options).toMatchObject({ sessionId: ID });
  expect(fake.calls[0]?.options.resume).toBeUndefined();
  expect(fake.calls[0]?.options.env).toEqual({});
});

const prompt = async (
  agent: { request: (...args: never[]) => Promise<unknown> },
  waitForIdle: () => Promise<SessionUpdate>,
  text: string,
) => {
  const idle = waitForIdle();
  await ask(agent, methods.agent.session.prompt, {
    sessionId: ID,
    prompt: [{ type: "text", text }],
  });
  return idle;
};

const ask = (agent: unknown, method: unknown, params: unknown) =>
  (agent as { request: (m: unknown, p: unknown) => Promise<unknown> }).request(method, params);
const tell = (agent: unknown, method: unknown, params: unknown) =>
  (agent as { notify: (m: unknown, p: unknown) => Promise<void> }).notify(method, params);

const open = (agent: unknown) =>
  ask(agent, methods.agent.session.new, { cwd: "/work", _meta: { "cycle/sessionId": ID } });

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("later turns use the same process: one query, many prompts", async () => {
  const fake = fakeQuery(() => textTurn(ID, "msg_1", "Hi there"));
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await open(agent);
    await prompt(agent as never, waitForIdle, "one");
    await prompt(agent as never, waitForIdle, "two");
  });
  expect(fake.calls).toHaveLength(1);
  expect(fake.prompts).toEqual(["one", "two"]);
});

test("when the process dies between turns, the next turn starts another and resumes the session", async () => {
  const fake = fakeQuery(() => textTurn(ID, "msg_1", "Hi there"));
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await open(agent);
    await prompt(agent as never, waitForIdle, "one");
    fake.state.kill();
    await settle(20);
    await prompt(agent as never, waitForIdle, "two");
  });
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[0]?.options).toMatchObject({ sessionId: ID });
  expect(fake.calls[1]?.options).toMatchObject({ resume: ID });
  expect(fake.calls[1]?.options.sessionId).toBeUndefined();
});

test("when the process dies during a turn, that turn ends with an error, and the session goes on", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "one" ? new Promise(() => {}) : textTurn(ID, "m", "ok"),
  );
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await open(agent);
    const idle = waitForIdle();
    await ask(agent, methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "one" }],
    });
    await settle(20);
    fake.state.kill(new Error("the Claude process died"));
    expect(await idle).toMatchObject({
      stopReason: "error",
      error: { message: "the Claude process died" },
    });
    expect(await prompt(agent as never, waitForIdle, "two")).toMatchObject({
      stopReason: "end_turn",
    });
  });
  expect(fake.calls).toHaveLength(2);
});

test("an idle process is let go, and the next prompt resumes the session", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(
    fake.run,
    async ({ agent, waitForIdle }) => {
      await open(agent);
      await prompt(agent as never, waitForIdle, "one");
      expect(fake.state.inputClosed).toBe(false);
      await settle(120);
      expect(fake.state.inputClosed).toBe(true);
      await prompt(agent as never, waitForIdle, "two");
    },
    undefined,
    { idleMs: 40 },
  );
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]?.options).toMatchObject({ resume: ID });
});

test("a process is kept while a cron the Stop hook told is due within the hour, and let go for one further off (CYCL-145)", async () => {
  // The cron is in local time, as Claude Code reads it: the minute and hour this far from now.
  const cronIn = (ms: number) => {
    const d = new Date(Date.now() + ms);
    return `${d.getMinutes()} ${d.getHours()} * * *`;
  };
  for (const [schedule, kept] of [
    [cronIn(20 * 60_000), true],
    [cronIn(3 * 60 * 60_000), false],
  ] as const) {
    const fake = fakeQuery(async (call) => {
      // What the SDK does at the end of the turn, before its result: the Stop hook, with what is set to wake it.
      const stop = call.options.hooks?.Stop?.[0]?.hooks[0];
      expect(stop).toBeDefined();
      expect(
        await stop?.(
          {
            hook_event_name: "Stop",
            session_crons: [{ id: "c1", schedule, recurring: false, prompt: "check back" }],
          } as never,
          undefined,
          { signal: new AbortController().signal },
        ),
      ).toEqual({});
      return textTurn(ID, "m", "ok");
    });
    await connect(
      fake.run,
      async ({ agent, waitForIdle }) => {
        await open(agent);
        await prompt(agent as never, waitForIdle, "remind me");
        await settle(150);
        expect(fake.state.inputClosed).toBe(!kept);
      },
      undefined,
      { idleMs: 40 },
    );
  }
});

test("a wakeup set in a turn that ends without the Stop hook keeps the process too", async () => {
  const fake = fakeQuery(() => {
    const turn = textTurn(ID, "m", "ok");
    // The call's result, as the SDK gives it; then a result, with no hook in between (a stopped turn has none).
    const wakeup = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
      parent_tool_use_id: null,
      tool_use_result: { scheduledFor: Date.now() + 20 * 60_000, clampedDelaySeconds: 1200 },
    } as unknown as SDKMessage;
    return [...turn.slice(0, -1), wakeup, ...turn.slice(-1)];
  });
  await connect(
    fake.run,
    async ({ agent, waitForIdle }) => {
      await open(agent);
      await prompt(agent as never, waitForIdle, "check back in 20 minutes");
      await settle(150);
      expect(fake.state.inputClosed).toBe(false);
    },
    undefined,
    { idleMs: 40 },
  );
});

test("a process in the middle of a turn is not let go for being quiet", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeQuery(async () => {
    await gate;
    return textTurn(ID, "m", "late");
  });
  await connect(
    fake.run,
    async ({ agent, waitForIdle }) => {
      await open(agent);
      const idle = waitForIdle();
      await ask(agent, methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [{ type: "text", text: "slow" }],
      });
      await settle(120);
      expect(fake.state.inputClosed).toBe(false);
      release();
      expect(await idle).toMatchObject({ stopReason: "end_turn" });
    },
    undefined,
    { idleMs: 40 },
  );
});

test("makes its own id when the proposed one is not a UUID", async () => {
  const fake = fakeQuery(() => []);
  await connect(fake.run, async ({ agent }) => {
    const created = await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": "not-a-uuid" },
    });
    expect(created.sessionId).not.toBe("not-a-uuid");
    expect(created.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

test("resuming in a new process sends the state before it answers, and no replay", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "again"));
  await connect(fake.run, async ({ agent, updates, waitForIdle }) => {
    const before = updates.length;
    await agent.request(methods.agent.session.resume, { sessionId: ID, cwd: "/work" });
    expect(kinds(updates.slice(before))).toEqual(["state_update"]);
    expect(updates.at(-1)).toMatchObject({ state: "idle" });
    // It was not created in this process, so the first turn resumes it.
    const idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "go on" }],
    });
    await idle;
  });
  // Nothing on record says otherwise: it was made when new sessions asked first, so it still does.
  expect(fake.calls[0]?.options).toMatchObject({ resume: ID, permissionMode: "default" });
});

test("refuses to replay: the daemon owns the history", async () => {
  const fake = fakeQuery(() => []);
  await connect(fake.run, async ({ agent }) => {
    await expect(
      agent.request(methods.agent.session.resume, {
        sessionId: ID,
        cwd: "/work",
        replayFrom: { type: "start" },
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

test("a turn that throws ends idle with an error", async () => {
  const fake = fakeQuery(() => {
    throw new Error("the model fell over");
  });
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    const idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "x" }],
    });
    expect(await idle).toMatchObject({
      state: "idle",
      stopReason: "error",
      error: { message: "the model fell over" },
    });
  });
});

test("changes the permission mode, and refuses one it does not know", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    const set = await agent.request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "mode",
      type: "id",
      value: "plan",
    } as never);
    expect(JSON.stringify(set.configOptions)).toContain('"currentValue":"plan"');
    await expect(
      agent.request(methods.agent.session.setConfigOption, {
        sessionId: ID,
        configId: "mode",
        type: "id",
        value: "alwaysAsk",
      } as never),
    ).rejects.toMatchObject({ code: -32602 });
    const idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "x" }],
    });
    await idle;
  });
  expect(fake.calls[0]?.options.permissionMode).toBe("plan");
});

test("a new session starts in auto, the suggested mode", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    const created = await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    const mode = (
      created.configOptions as {
        configId: string;
        currentValue: string;
        options: { value: string; _meta?: Record<string, unknown> }[];
      }[]
    ).find((o) => o.configId === "mode");
    expect(mode?.currentValue).toBe("auto");
    expect(mode?.options.filter((o) => o._meta?.["cycle/recommended"] === true)).toEqual([
      expect.objectContaining({ value: "auto" }),
    ]);
    expect(mode?.options.filter((o) => o._meta?.["cycle/danger"] === true)).toEqual([
      expect.objectContaining({ value: "bypassPermissions" }),
    ]);
    const idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "x" }],
    });
    await idle;
  });
  expect(fake.calls[0]?.options.permissionMode).toBe("auto");
});

test("offers every SDK permission mode, each with a name and a description", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    const created = await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    const mode = (created.configOptions as { configId: string; options: unknown[] }[]).find(
      (o) => o.configId === "mode",
    );
    const options = mode?.options as { value: string; name: string; description: string }[];
    expect(options.map((o) => o.value)).toEqual([
      "auto",
      "default",
      "acceptEdits",
      "plan",
      "dontAsk",
      "bypassPermissions",
    ]);
    for (const o of options) {
      expect(o.name.length).toBeGreaterThan(0);
      expect(o.description.length).toBeGreaterThan(0);
    }
    await agent.request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "mode",
      type: "id",
      value: "bypassPermissions",
    } as never);
    const idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "x" }],
    });
    await idle;
  });
  // The SDK refuses bypassPermissions without its guard flag.
  expect(fake.calls[0]?.options.permissionMode).toBe("bypassPermissions");
  expect(fake.calls[0]?.options.allowDangerouslySkipPermissions).toBe(true);
  // Without it Claude Code omits thinking's text, and every thought arrives empty.
  expect(fake.calls[0]?.options.settings).toMatchObject({ showThinkingSummaries: true });
  // Newer models get no task list unless its tools are named: without it there is no plan to show.
  expect(fake.calls[0]?.options.allowedTools).toEqual(
    expect.arrayContaining(["TaskCreate", "TaskUpdate"]),
  );
});

test("a second prompt right after the first is refused: the turn exists before anything is awaited", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeQuery(async () => {
    await gate;
    return textTurn(ID, "m", "done");
  });
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    const idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "one" }],
    });
    await expect(
      agent.request(methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [{ type: "text", text: "two" }],
      }),
    ).rejects.toMatchObject({ code: -32600 });
    release();
    await idle;
  });
  expect(fake.calls).toHaveLength(1);
});

test("a cancel sent straight after the prompt ends the turn as cancelled, and stops the query", async () => {
  const fake = fakeQuery(() => new Promise(() => {}));
  await connect(fake.run, async ({ agent, updates, waitForIdle }) => {
    await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    const idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "go" }],
    });
    // No await between the answer and the cancel: it may beat the query's start.
    await agent.notify(methods.agent.session.cancel, { sessionId: ID });
    expect(await idle).toMatchObject({ state: "idle", stopReason: "cancelled" });
    expect(updates.at(-1)).toMatchObject({ stopReason: "cancelled" });
  });
  // Either it never started, or it was interrupted: it did not run on.
  expect(fake.calls.length === 0 || fake.state.interrupts === 1).toBe(true);
});

test("after a cancel the session can take another prompt", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "first" ? new Promise(() => {}) : textTurn(ID, "m", "ok"),
  );
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    let idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "first" }],
    });
    await agent.notify(methods.agent.session.cancel, { sessionId: ID });
    await idle;
    idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "second" }],
    });
    expect(await idle).toMatchObject({ stopReason: "end_turn" });
  });
});

test("a mode or model set while the process runs is sent to it; one that cannot be sent lets the process go", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await open(agent);
    await prompt(agent as never, waitForIdle, "one");
    const request = (m: unknown, p: unknown) => ask(agent, m, p);
    await request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "mode",
      type: "id",
      value: "acceptEdits",
    });
    await request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "model",
      type: "id",
      value: "haiku",
    });
    await settle(10);
    expect(fake.state.permissionModes).toEqual(["acceptEdits"]);
    expect(fake.state.models).toEqual(["haiku"]);
    expect(fake.calls).toHaveLength(1);

    fake.state.failSetters = true;
    await request(methods.agent.session.setConfigOption, {
      sessionId: ID,
      configId: "mode",
      type: "id",
      value: "plan",
    });
    await settle(20);
    await prompt(agent as never, waitForIdle, "two");
  });
  // The second process has the new mode and the model in its options.
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]?.options).toMatchObject({
    permissionMode: "plan",
    model: "haiku",
    resume: ID,
  });
});

test("a cancel keeps the process: the next prompt goes to the same one", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "first" ? new Promise(() => {}) : textTurn(ID, "m", "ok"),
  );
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await open(agent);
    const idle = waitForIdle();
    const request = (m: unknown, p: unknown) => ask(agent, m, p);
    await request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "first" }],
    });
    await settle(20);
    await tell(agent, methods.agent.session.cancel, { sessionId: ID });
    expect(await idle).toMatchObject({ stopReason: "cancelled" });
    expect(await prompt(agent as never, waitForIdle, "second")).toMatchObject({
      stopReason: "end_turn",
    });
  });
  expect(fake.calls).toHaveLength(1);
  expect(fake.state.interrupts).toBe(1);
});

test("a process that ignores the interrupt is killed after the grace period, and the next prompt starts another", async () => {
  const fake = fakeQuery((call) =>
    // It has started (init) and then says nothing: a hung process.
    call.prompt === "first" ? textTurn(ID, "m", "x").slice(0, 1) : textTurn(ID, "m", "ok"),
  );
  fake.state.ignoreInterrupt = true;
  await connect(
    fake.run,
    async ({ agent, waitForIdle }) => {
      await open(agent);
      const idle = waitForIdle();
      const request = (m: unknown, p: unknown) => ask(agent, m, p);
      await request(methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [{ type: "text", text: "first" }],
      });
      await settle(20);
      await tell(agent, methods.agent.session.cancel, { sessionId: ID });
      expect(await idle).toMatchObject({ stopReason: "cancelled" });
      fake.state.ignoreInterrupt = false;
      expect(await prompt(agent as never, waitForIdle, "second")).toMatchObject({
        stopReason: "end_turn",
      });
    },
    undefined,
    { cancelGraceMs: 50 },
  );
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]?.options).toMatchObject({ resume: ID });
});

test("a cancel while a permission is waiting for an answer ends the question and the turn", async () => {
  let asked: Promise<unknown> | undefined;
  const fake = fakeQuery(async (call) => {
    asked = call.options.canUseTool?.("Bash", { command: "touch x" }, {
      signal: new AbortController().signal,
      toolUseID: "tool_1",
    } as never);
    await asked;
    return textTurn(ID, "m", "done");
  });
  await connect(
    fake.run,
    async ({ agent, waitForIdle }) => {
      await open(agent);
      const idle = waitForIdle();
      const request = (m: unknown, p: unknown) => ask(agent, m, p);
      await request(methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [{ type: "text", text: "go" }],
      });
      await settle(30);
      await tell(agent, methods.agent.session.cancel, { sessionId: ID });
      expect(await idle).toMatchObject({ stopReason: "cancelled" });
      // The question was answered as cancelled, not left hanging.
      expect(await asked).toMatchObject({ behavior: "deny" });
    },
    () => new Promise<never>(() => {}),
  );
});

/** The adapter, told by a stand-in for the SDK's `getSessionInfo` whether Claude has the session on disk. */
const resumed = async (
  record: "found" | "none" | "fails" | "cannot look",
  meta: Record<string, unknown> = {},
) => {
  const fake = fakeQuery(() => textTurn(ID, "m", "again"));
  let outcome: unknown;
  const sessionInfo =
    record === "cannot look"
      ? {}
      : {
          sessionInfo: async (sessionId: string, cwd: string) => {
            // It is asked about this session, in the directory it was made in.
            expect([sessionId, cwd]).toEqual([ID, "/work"]);
            if (record === "fails") throw new Error("cannot read the config directory");
            return record === "found" ? ({ summary: "s", firstPrompt: "s" } as never) : undefined;
          },
        };
  await connect(
    fake.run,
    async ({ agent, waitForIdle }) => {
      try {
        await agent.request(methods.agent.session.resume, {
          sessionId: ID,
          cwd: "/work",
          _meta: meta,
        });
      } catch (error) {
        outcome = error;
        return;
      }
      const idle = waitForIdle();
      await agent.request(methods.agent.session.prompt, {
        sessionId: ID,
        prompt: [{ type: "text", text: "first" }],
      });
      await idle;
    },
    undefined,
    sessionInfo,
  );
  return { fake, outcome };
};

test("a session Claude has on disk is resumed", async () => {
  const { fake } = await resumed("found");
  expect(fake.calls[0]?.options).toMatchObject({ resume: ID });
});

test("a session Claude never wrote (made, and no prompt sent) is started, not resumed", async () => {
  const { fake, outcome } = await resumed("none");
  expect(outcome).toBeUndefined();
  expect(fake.calls[0]?.options.resume).toBeUndefined();
  expect(fake.calls[0]?.options).toMatchObject({ sessionId: ID });
});

test("a session that had a turn answered and has no record any more is not started over: the resume says so", async () => {
  const { fake, outcome } = await resumed("none", { "cycle/hadTurn": true });
  expect(outcome).toMatchObject({ code: -32603 });
  expect(String((outcome as Error).message)).toContain("no record");
  expect(fake.calls).toHaveLength(0);
});

test("a session that had a turn answered and is on disk is resumed", async () => {
  const { fake } = await resumed("found", { "cycle/hadTurn": true });
  expect(fake.calls[0]?.options).toMatchObject({ resume: ID });
});

test("where the record cannot be looked at, the session is taken to be there, as it was before", async () => {
  for (const record of ["fails", "cannot look"] as const) {
    const { fake } = await resumed(record);
    expect(fake.calls[0]?.options).toMatchObject({ resume: ID });
  }
});

// ---- steer: a prompt put into the turn that is running (docs/protocol.md §8) ----

const steer = (agent: unknown, text: string) =>
  ask(agent, methods.agent.session.prompt, {
    sessionId: ID,
    prompt: [{ type: "text", text }],
    _meta: { "cycle/steer": true },
  }) as Promise<{ messageId: string }>;

/** A first turn that waits for `release`, then a plain answer to anything else. */
const gated = () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeQuery(async (call) => {
    if (call.prompt === "work") await gate;
    return textTurn(ID, `m-${call.prompt}`, "ok");
  });
  return { fake, release: () => release() };
};

test("a prompt steered into a running turn is taken by it: one turn, one idle, its user message in the middle", async () => {
  const { fake, release } = gated();
  fake.state.fold = true;
  await connect(fake.run, async ({ agent, updates, waitForIdle }) => {
    await open(agent);
    const idle = waitForIdle();
    await ask(agent, methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "work" }],
    });
    await settle(20);
    const { messageId } = await steer(agent, "mind this");
    await settle(20);
    release();
    expect(await idle).toMatchObject({ stopReason: "end_turn" });
    await settle(20);
    const users = updates.filter((u) => u.sessionUpdate === "user_message");
    expect(users.at(-1)).toMatchObject({ messageId, content: [{ text: "mind this" }] });
    expect(updates.filter((u) => (u as { state?: string }).state === "idle")).toHaveLength(1);
  });
  expect(fake.state.folded).toEqual(["mind this"]);
});

test("a steered prompt the turn ended without taking is answered before the turn ends", async () => {
  const { fake, release } = gated();
  await connect(fake.run, async ({ agent, updates, waitForIdle }) => {
    await open(agent);
    const idle = waitForIdle();
    await ask(agent, methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "work" }],
    });
    await settle(20);
    await steer(agent, "mind this");
    release();
    expect(await idle).toMatchObject({ stopReason: "end_turn" });
    // Claude answered it as a turn of its own in the same process; for the client it is the same turn.
    expect(fake.prompts).toEqual(["work", "mind this"]);
    await settle(20);
    expect(updates.filter((u) => (u as { state?: string }).state === "idle")).toHaveLength(1);
  });
  expect(fake.calls).toHaveLength(1);
});

test("a steer with no turn running is refused, for the daemon to send or queue", async () => {
  const fake = fakeQuery(() => textTurn(ID, "m", "ok"));
  await connect(fake.run, async ({ agent }) => {
    await open(agent);
    await expect(steer(agent, "hello")).rejects.toMatchObject({ code: -32600 });
  });
  expect(fake.prompts).toEqual([]);
});

test("a stop with a steered prompt not yet taken lets the process go, so Claude does not answer it unseen", async () => {
  const fake = fakeQuery((call) =>
    call.prompt === "work" ? new Promise(() => {}) : textTurn(ID, "m", "ok"),
  );
  await connect(fake.run, async ({ agent, waitForIdle }) => {
    await open(agent);
    const idle = waitForIdle();
    await ask(agent, methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "work" }],
    });
    await settle(20);
    await steer(agent, "mind this");
    await tell(agent, methods.agent.session.cancel, { sessionId: ID });
    expect(await idle).toMatchObject({ stopReason: "cancelled" });
    // The next prompt starts another process.
    expect(await prompt(agent as never, waitForIdle, "again")).toMatchObject({
      stopReason: "end_turn",
    });
  });
  // Another process took the next prompt; the first never got to answer what was put in.
  expect(fake.calls).toHaveLength(2);
  expect(fake.prompts).toEqual(["work", "again"]);
});

test("a result that does not say what it took ends the turn, and the process goes with what was put in", async () => {
  const { fake, release } = gated();
  fake.state.dropUuids = true;
  await connect(fake.run, async ({ agent, updates, waitForIdle }) => {
    await open(agent);
    const idle = waitForIdle();
    await ask(agent, methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "work" }],
    });
    await settle(20);
    await steer(agent, "mind this");
    release();
    expect(await idle).toMatchObject({ stopReason: "end_turn" });
    await settle(50);
    expect(updates.filter((u) => (u as { state?: string }).state === "idle")).toHaveLength(1);
    // The next prompt starts another process: the first never answered the steer unseen.
    expect(await prompt(agent as never, waitForIdle, "again")).toMatchObject({
      stopReason: "end_turn",
    });
  });
  expect(fake.calls).toHaveLength(2);
  expect(fake.prompts).toEqual(["work", "again"]);
});

test("a background sub-agent's own talk and calls stay out of the session, and a call the turn left ends with it", async () => {
  const sub = "toolu_agent";
  const fake = fakeQuery(
    () =>
      [
        { type: "system", subtype: "init", session_id: ID },
        {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            id: "m1",
            content: [
              { type: "tool_use", id: sub, name: "Agent", input: { run_in_background: true } },
              { type: "tool_use", id: "toolu_left", name: "Bash", input: { command: "ls" } },
            ],
          },
        },
        {
          type: "user",
          parent_tool_use_id: null,
          message: { content: [{ type: "tool_result", tool_use_id: sub, content: "launched" }] },
        },
        {
          type: "stream_event",
          parent_tool_use_id: sub,
          event: { type: "message_start", message: { id: "msg_sub" } },
        },
        {
          type: "stream_event",
          parent_tool_use_id: sub,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Now icons" },
          },
        },
        {
          type: "assistant",
          parent_tool_use_id: sub,
          message: {
            id: "msg_sub",
            content: [
              { type: "tool_use", id: "toolu_sub", name: "Bash", input: { command: "sed" } },
            ],
          },
        },
        { type: "result", subtype: "success", stop_reason: "end_turn", session_id: ID },
      ] as unknown as SDKMessage[],
  );
  await connect(fake.run, async ({ agent, updates, waitForIdle }) => {
    await agent.request(methods.agent.session.new, {
      cwd: "/work",
      _meta: { "cycle/sessionId": ID },
    });
    const idle = waitForIdle();
    await agent.request(methods.agent.session.prompt, {
      sessionId: ID,
      prompt: [{ type: "text", text: "go" }],
    });
    await idle;
    const calls = updates.filter((u) => u.sessionUpdate === "tool_call_update") as unknown as {
      toolCallId: string;
      status: string;
    }[];
    expect(calls.some((c) => c.toolCallId === "toolu_sub")).toBe(false);
    expect(kinds(updates)).not.toContain("agent_message_chunk");
    expect(calls.map((c) => [c.toolCallId, c.status])).toEqual([
      [sub, "in_progress"],
      ["toolu_left", "in_progress"],
      [sub, "completed"],
      ["toolu_left", "cancelled"],
    ]);
    // Each ends before the turn does.
    const end = updates.findIndex((u) => (u as { state?: string }).state === "idle");
    const ended = updates.flatMap((u, i) =>
      (u as { status?: string }).status === "cancelled" ? [i] : [],
    );
    expect(ended.length).toBe(1);
    expect(ended.every((i) => i < end)).toBe(true);
  });
});

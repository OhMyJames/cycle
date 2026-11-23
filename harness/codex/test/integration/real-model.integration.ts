// The Codex adapter against a real model. Not part of `bun run test:integration`: it spends a little of an
// account's quota, so it only runs when asked, with the login given on purpose:
//
//   CYCLE_CODEX_AUTH=<path to a Codex auth.json> bun run test:real     (in harness/codex)
//
// The login file is copied into a temporary CODEX_HOME for each test and read by the Codex process only; the file
// given is never written. A ChatGPT login's tokens are refreshed by whichever Codex holds them, and a refresh
// replaces the refresh token: give a login that nothing else is using at the same time (Cycle's own,
// `<data dir>/codex/auth.json` after `cycle login codex`, is one). The model is the account's default unless
// CYCLE_REAL_MODEL says otherwise, at low effort. The assertions are loose, because a real model is not
// deterministic; what this is for is the printed report of what really happened.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  client,
  methods,
  ndJsonStream,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";

const auth = process.env.CYCLE_CODEX_AUTH;
const model = process.env.CYCLE_REAL_MODEL;
const enabled = auth !== undefined && auth !== "" && existsSync(auth);

let root: string;
let cwd: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cycle-codex-real-"));
  cwd = join(root, "project");
  await mkdir(cwd);
  await writeFile(join(cwd, "notes.txt"), "The secret word in this file is MARMALADE.\n");
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** A CODEX_HOME of its own, with a copy of the login. */
async function codexHome() {
  const home = await mkdtemp(join(root, "home-"));
  await copyFile(auth as string, join(home, "auth.json"));
  return home;
}

/** The agent side of an ACP connection, as `connectWith` gives it. */
type Agent = Parameters<Parameters<ReturnType<typeof client>["connectWith"]>[1]>[0];
type Run = {
  agent: Agent;
  updates: (SessionUpdate & { _in: string })[];
  forms: { message: string; requestedSchema: { properties: Record<string, unknown> } }[];
  asked: { sessionId: string; title?: string }[];
  /** The next end of a turn of `sessionId`'s own. */
  ended: (sessionId: string) => Promise<{ stopReason: string; error?: unknown }>;
};

/** Runs `cycle adapter codex` from source with only the Codex environment, and talks ACP to it. */
async function withAdapter(
  home: string,
  answers: {
    permission?: (title: string) => "allow" | "deny";
    form?: (message: string) => Record<string, unknown>;
  },
  body: (run: Run) => Promise<void>,
) {
  const entry = new URL("../../../../apps/daemon/src/main.ts", import.meta.url).pathname;
  const proc = Bun.spawn([process.execPath, entry, "adapter", "codex"], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      CYCLE_ADAPTER_CONFIG: JSON.stringify({
        env: { HOME: home, CODEX_HOME: home, PATH: "/usr/bin:/bin" },
      }),
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const updates: Run["updates"] = [];
  const forms: Run["forms"] = [];
  const asked: Run["asked"] = [];
  const waiting: { sessionId: string; resolve: (u: never) => void }[] = [];
  const input = new WritableStream<Uint8Array>({
    write(chunk) {
      proc.stdin.write(chunk);
      proc.stdin.flush();
    },
    close() {
      proc.stdin.end();
    },
  });
  const acp = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      const update = { ...params.update, _in: params.sessionId } as Run["updates"][number];
      updates.push(update);
      if (
        update.sessionUpdate === "state_update" &&
        (update as { stopReason?: string }).stopReason !== undefined
      ) {
        const i = waiting.findIndex((w) => w.sessionId === params.sessionId);
        if (i >= 0) waiting.splice(i, 1)[0]?.resolve(update as never);
      }
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      const title = (params as { title?: string }).title ?? "";
      asked.push({ sessionId: params.sessionId, title });
      const choice = answers.permission?.(title) ?? "deny";
      return { outcome: { outcome: "selected", optionId: choice } };
    })
    .onRequest(methods.client.elicitation.create, ({ params }) => {
      const form = params as unknown as Run["forms"][number];
      forms.push(form);
      const content = answers.form?.(form.message);
      return (content ? { action: "accept", content } : { action: "decline" }) as never;
    });
  try {
    await acp.connectWith(ndJsonStream(input, proc.stdout), async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "real", version: "1" },
        capabilities: { elicitation: { form: {} } },
      } as never);
      await body({
        agent,
        updates,
        forms,
        asked,
        ended: (sessionId) =>
          new Promise((resolve) => waiting.push({ sessionId, resolve: resolve as never })),
      });
    });
  } finally {
    proc.stdin.end();
    await Promise.race([proc.exited, Bun.sleep(2000)]);
    proc.kill();
    await proc.exited;
  }
}

async function open(run: Run, extra: Record<string, unknown> = {}) {
  const opened = await run.agent.request(methods.agent.session.new, { cwd, ...extra } as never);
  await run.agent.request(methods.agent.session.setConfigOption, {
    sessionId: opened.sessionId,
    configId: "effort",
    type: "id",
    value: "low",
  } as never);
  if (model)
    await run.agent.request(methods.agent.session.setConfigOption, {
      sessionId: opened.sessionId,
      configId: "model",
      type: "id",
      value: model,
    } as never);
  return opened;
}
async function turn(run: Run, sessionId: string, text: string, meta?: Record<string, unknown>) {
  const done = run.ended(sessionId);
  const started = Date.now();
  await run.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text }],
    ...(meta ? { _meta: meta } : {}),
  });
  const end = await done;
  return { ...end, ms: Date.now() - started };
}
const kinds = (updates: SessionUpdate[]) => {
  const count: Record<string, number> = {};
  for (const u of updates) count[u.sessionUpdate] = (count[u.sessionUpdate] ?? 0) + 1;
  return count;
};
const agentText = (updates: Run["updates"], sessionId: string) =>
  updates
    .filter(
      (u) =>
        u._in === sessionId &&
        (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_message"),
    )
    .map((u) => {
      const c = (u as unknown as { content: { text?: string } | { text?: string }[] }).content;
      return Array.isArray(c) ? c.map((b) => b.text ?? "").join("") : (c.text ?? "");
    })
    .join("");
const report = (name: string, value: unknown) =>
  console.log(`[codex real] ${name}: ${JSON.stringify(value)}`);

test.skipIf(!enabled)(
  "a real turn: streamed text, thinking, a file read, usage, plan usage, skills, and every kind of update seen",
  async () => {
    const home = await codexHome();
    await withAdapter(home, {}, async (run) => {
      const { sessionId } = await open(run);
      const first = await turn(run, sessionId, "Reply with the single word hello.");
      report("hello", {
        stopReason: first.stopReason,
        ms: first.ms,
        text: agentText(run.updates, sessionId),
      });
      expect(first.stopReason).toBe("end_turn");
      expect(agentText(run.updates, sessionId).toLowerCase()).toContain("hello");
      const read = await turn(
        run,
        sessionId,
        "Read notes.txt in the current folder with a shell command and tell me the secret word in it.",
      );
      const tools = run.updates.filter((u) => u.sessionUpdate === "tool_call_update");
      report("read", {
        stopReason: read.stopReason,
        ms: read.ms,
        tools: tools.map((u) => [
          (u as { toolCallId?: string }).toolCallId?.slice(-6),
          (u as { kind?: string }).kind,
          (u as { status?: string }).status,
        ]),
      });
      expect(read.stopReason).toBe("end_turn");
      expect(agentText(run.updates, sessionId)).toContain("MARMALADE");
      expect(tools.some((u) => (u as { status?: string }).status === "completed")).toBe(true);
      // Codex's own clients name a thread; a session's title is told if it does.
      await Bun.sleep(3000);
      const usage = run.updates.filter((u) => (u.sessionUpdate as string) === "_cycle/plan_usage");
      const commands = run.updates
        .filter((u) => u.sessionUpdate === "available_commands_update")
        .at(-1) as { availableCommands?: { name: string }[] } | undefined;
      report("kinds", kinds(run.updates));
      report("usage", run.updates.filter((u) => u.sessionUpdate === "usage_update").at(-1));
      report("planUsage", usage.at(-1));
      report(
        "commands",
        commands?.availableCommands?.map((c) => c.name),
      );
      report(
        "title",
        run.updates.filter((u) => u.sessionUpdate === "session_info_update"),
      );
      expect(run.updates.some((u) => u.sessionUpdate === "usage_update")).toBe(true);
      // A ChatGPT login has limits; an API key's has none.
      if (JSON.parse(await Bun.file(auth as string).text()).auth_mode === "chatgpt")
        expect(usage.length).toBeGreaterThan(0);
      expect(commands?.availableCommands?.length ?? 0).toBeGreaterThan(1);
    });
  },
  240_000,
);

test.skipIf(!enabled)(
  "approvals: allowed, the command runs; refused, it does not and the turn still ends",
  async () => {
    const home = await codexHome();
    const outside = (name: string) => join(root, name);
    let choice: "allow" | "deny" = "allow";
    await withAdapter(home, { permission: () => choice }, async (run) => {
      const { sessionId } = await open(run);
      const ask = (name: string) =>
        `Create the empty file ${outside(name)} with the shell command touch. It is outside the workspace, so ask for approval to run it outside the sandbox. Do nothing else.`;
      const allowed = await turn(run, sessionId, ask("allowed.txt"));
      choice = "deny";
      const denied = await turn(run, sessionId, ask("denied.txt"));
      report("approvals", {
        asked: run.asked,
        allowed: [allowed.stopReason, existsSync(outside("allowed.txt"))],
        denied: [denied.stopReason, existsSync(outside("denied.txt"))],
      });
      expect(run.asked.length).toBeGreaterThanOrEqual(2);
      expect(existsSync(outside("allowed.txt"))).toBe(true);
      expect(existsSync(outside("denied.txt"))).toBe(false);
      expect(denied.stopReason).toBe("end_turn");
    });
  },
  240_000,
);

test.skipIf(!enabled)(
  "a cancel mid-command ends the turn soon, the next prompt works, and a new process resumes the conversation",
  async () => {
    const home = await codexHome();
    let sessionId = "";
    await withAdapter(home, {}, async (run) => {
      ({ sessionId } = await open(run));
      await turn(run, sessionId, "Remember this word for later: PERSIMMON. Reply only with ok.");
      const done = run.ended(sessionId);
      await run.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "Run the shell command `sleep 60` and then say done." }],
      });
      for (let i = 0; i < 600; i++) {
        if (run.updates.some((u) => u.sessionUpdate === "tool_call_update")) break;
        await Bun.sleep(50);
      }
      const asked = Date.now();
      await run.agent.notify(methods.agent.session.cancel, { sessionId });
      const cancelled = await done;
      const ms = Date.now() - asked;
      const after = await turn(run, sessionId, "Reply with the single word again.");
      report("cancel", { stopReason: cancelled.stopReason, ms, after: after.stopReason });
      expect(cancelled.stopReason).toBe("cancelled");
      expect(ms).toBeLessThan(5000);
      expect(after.stopReason).toBe("end_turn");
    });
    await withAdapter(home, {}, async (run) => {
      await run.agent.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        _meta: { "cycle/hadTurn": true },
      } as never);
      const resumed = await turn(
        run,
        sessionId,
        "What word did I ask you to remember? Reply with it only.",
      );
      report("resume", { stopReason: resumed.stopReason, text: agentText(run.updates, sessionId) });
      expect(agentText(run.updates, sessionId).toUpperCase()).toContain("PERSIMMON");
    });
  },
  240_000,
);

test.skipIf(!enabled)(
  "a sub-agent: announced in the parent's session, its words in its own, and its end",
  async () => {
    const home = await codexHome();
    await withAdapter(home, { permission: () => "allow" }, async (run) => {
      const { sessionId } = await open(run);
      const end = await turn(
        run,
        sessionId,
        "Spawn exactly one sub-agent. Its task: reply with the single word pong. Wait for it to finish, then tell me what it said.",
      );
      const subs = run.updates.filter((u) => u.sessionUpdate === "subagent_update") as unknown as {
        _in: string;
        sessionId: string;
        title?: string;
        state?: { state: string; stopReason?: string };
      }[];
      const child = subs[0]?.sessionId ?? "";
      report("subagent", {
        stopReason: end.stopReason,
        subs: subs.map((s) => [s._in === sessionId, s.title, s.state?.state, s.state?.stopReason]),
        childKinds: kinds(run.updates.filter((u) => u._in === child)),
        childText: agentText(run.updates, child),
      });
      expect(end.stopReason).toBe("end_turn");
      expect(subs.length).toBeGreaterThan(0);
      expect(subs.every((s) => s._in === sessionId)).toBe(true);
      expect(subs[0]?.state?.state).toBe("running");
      expect(subs.at(-1)?.state).toMatchObject({ state: "idle", stopReason: "end_turn" });
      expect(agentText(run.updates, child).toLowerCase()).toContain("pong");
    });
  },
  240_000,
);

test.skipIf(!enabled)(
  "Codex's question in plan mode is a form, and the answer reaches the model; /compact compacts",
  async () => {
    const home = await codexHome();
    await withAdapter(home, { form: () => ({ q0: "Blue", q0_other: "" }) }, async (run) => {
      const { sessionId } = await open(run);
      await run.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "mode",
        type: "id",
        value: "plan",
      } as never);
      const asked = await turn(
        run,
        sessionId,
        "Before anything else, use your request_user_input tool to ask me which color I prefer, with the options Red and Blue. Then reply with only the color I chose.",
      );
      report("question", {
        stopReason: asked.stopReason,
        forms: run.forms.map((f) => [f.message, Object.keys(f.requestedSchema.properties)]),
        text: agentText(run.updates, sessionId),
      });
      expect(run.forms.length).toBe(1);
      expect(agentText(run.updates, sessionId).toLowerCase()).toContain("blue");
      await run.agent.request(methods.agent.session.setConfigOption, {
        sessionId,
        configId: "mode",
        type: "id",
        value: "default",
      } as never);
      const compacted = await turn(run, sessionId, "/compact");
      const compactions = run.updates
        .filter((u) => u.sessionUpdate === "compaction_update")
        .map((u) => (u as { status?: string }).status);
      report("compact", { stopReason: compacted.stopReason, ms: compacted.ms, compactions });
      expect(compacted.stopReason).toBe("end_turn");
      expect(compactions).toEqual(["in_progress", "completed"]);
    });
  },
  240_000,
);

test.skipIf(!enabled)("no test left a login anywhere but its own folder", async () => {
  // Each CODEX_HOME is under `root`, removed after; the file given was only read.
  expect(
    (await readdir(root)).every(
      (name) => name === "project" || name.startsWith("home-") || name.endsWith(".txt"),
    ),
  ).toBe(true);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHarness } from "@cycle/harness-codex";
import { type SessionEvent, type SessionState, reduceSession } from "@cycle/protocol";
import {
  type Daemon,
  diskFile,
  type OpenProviders,
  openProviders,
  Harnesses,
  startDaemon,
} from "../../src/index.ts";
import { type MockModel, type MockReply, startMockModel } from "./mock-model.ts";
import { connect } from "./wire-client.ts";

let model: MockModel;
let daemon: Daemon;
let providers: OpenProviders;
let root: string;
let project: string;
/** What the model answers next, by the text of the latest prompt. */
let script: (prompt: string, sawToolOutput: boolean) => MockReply;

function git(...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: project,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** The window codex last reported for a session, if it has. */
function contextWindow(events: SessionEvent[], sessionId: string): number | null {
  const usage = events.findLast(
    (event) => event.type === "usage.updated" && event.sessionId === sessionId,
  );
  return usage?.type === "usage.updated" ? usage.usage.contextWindow : null;
}

/** The instructions codex opens a request with, when it reaches the model with no gateway between. */
function instructionsOf(body: unknown): string | null {
  const input = (body as { input?: { role?: string; content?: { text?: unknown }[] }[] }).input;
  const text = input?.find((item) => item.role === "developer")?.content?.[0]?.text;
  return typeof text === "string" && text.length ? text : null;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-e2e-"));
  project = join(root, "project");
  Bun.spawnSync(["mkdir", "-p", project, join(root, "codex")]);
  writeFileSync(join(project, "hello.txt"), "hello\n");
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  script = () => ({ text: ["Hello", " from", " cycle"] });
  model = startMockModel((_index, body) => {
    const text = JSON.stringify(body);
    const prompts = [...text.matchAll(/"input_text","text":"(PROMPT:[^"]*)"/g)];
    return script(prompts.at(-1)?.[1] ?? "", text.includes("function_call_output"));
  });
  providers = await openProviders(
    diskFile(join(root, "home", "providers.json")),
    "gateway-token",
    join(root, "home", "provider-models.json"),
  );
  daemon = await startDaemon({
    harness: new Harnesses(
      new CodexHarness({
        config: model.codexConfig,
        env: { CODEX_HOME: join(root, "codex") },
        provider: providers.provider,
      }),
      [],
    ),
    providers: providers.store,
    home: join(root, "home"),
  });
});

afterAll(async () => {
  await daemon?.stop();
  providers?.stop();
  model?.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a connection needs the token", async () => {
  const stranger = connect(daemon.url.replace(/token=.*/, "token=wrong"));
  expect(stranger.opened).rejects.toThrow("closed");
});

test("a turn streams to a client, and a late client gets the same state", async () => {
  const client = connect(daemon.url);
  await client.opened;
  const info = await client.call("daemon.info", {});
  expect(info.harness).toBe("codex");

  const session = await client.call("session.create", { cwd: project, mode: "fullAccess" });
  expect(session).toMatchObject({ model: "mock-model", status: "idle", mode: "fullAccess" });
  const opened = await client.call("session.open", { sessionId: session.id });
  if (!("state" in opened)) throw new Error("expected a snapshot");
  let state: SessionState = opened.state;

  await client.call("session.send", { sessionId: session.id, text: "PROMPT:hello" });
  await client.until(() => client.events().some((event) => event.type === "turn.completed"));
  for (const frame of client.frames) {
    expect(frame.seq).toBe(state.seq + 1);
    state = { ...frame.events.reduce(reduceSession, state), seq: frame.seq };
  }
  const items = state.turns.flatMap((turn) => turn.items);
  expect(items.map((item) => [item.kind, "text" in item ? item.text : ""])).toEqual([
    ["userMessage", "PROMPT:hello"],
    ["agentMessage", "Hello from cycle"],
  ]);
  expect(state.turns[0]?.status).toBe("completed");
  expect(state.usage?.total.total).toBeGreaterThan(0);

  // A second client sees what the first folded, and can catch up from a frame.
  const late = connect(daemon.url);
  await late.opened;
  const snapshot = await late.call("session.open", { sessionId: session.id });
  if (!("state" in snapshot)) throw new Error("expected a snapshot");
  expect(snapshot.state.turns).toEqual(state.turns);
  const replay = await late.call("session.open", {
    sessionId: session.id,
    after: { seq: 1, epoch: snapshot.state.epoch },
  });
  if (!("frames" in replay)) throw new Error("expected frames");
  expect(replay.frames.map((frame) => frame.seq)).toEqual(client.frames.slice(1).map((f) => f.seq));

  // The list knows it, with the first prompt as its preview, and it can be renamed.
  const { sessions } = await client.call("session.list", { archived: false });
  expect(sessions.find((row) => row.id === session.id)).toMatchObject({
    preview: "PROMPT:hello",
    status: "idle",
  });
  const renamed = await client.call("session.update", { sessionId: session.id, title: "Greeting" });
  expect(renamed.title).toBe("Greeting");
  const usage = await client.call("usage.daily", {});
  expect(usage.days.at(-1)?.turns).toBeGreaterThan(0);
  client.close();
  late.close();
}, 60_000);

test("an approval waits for the owner, and a queued prompt runs after the turn", async () => {
  script = (prompt, sawToolOutput) => {
    if (prompt === "PROMPT:write" && !sawToolOutput) {
      return {
        call: {
          name: "exec_command",
          arguments: {
            cmd: "echo made > made.txt",
            sandbox_permissions: "require_escalated",
            justification: "needs to write",
          },
        },
      };
    }
    return { text: [`answer to ${prompt}`] };
  };
  const client = connect(daemon.url);
  await client.opened;
  const session = await client.call("session.create", { cwd: project, mode: "readOnly" });
  await client.call("session.open", { sessionId: session.id });
  await client.call("session.send", { sessionId: session.id, text: "PROMPT:write" });
  await client.until(() => client.events().some((event) => event.type === "approval.requested"));
  const request = client.events().find((event) => event.type === "approval.requested");
  if (request?.type !== "approval.requested") throw new Error("no approval");
  expect(request.approval).toMatchObject({ kind: "command", reason: "needs to write" });
  await client.until(() =>
    client.pushes.some(
      (push) => push.type === "sessions.changed" && push.sessions[0]?.status === "waiting",
    ),
  );

  // Sent while the turn is blocked, so it waits behind it.
  const queued = await client.call("session.send", { sessionId: session.id, text: "PROMPT:next" });
  expect(queued.queued).toBe(true);
  await client.call("approval.respond", {
    sessionId: session.id,
    approvalId: request.approval.id,
    response: { decision: "accept" },
  });
  await client.until(
    () => client.events().filter((event) => event.type === "turn.completed").length === 2,
  );
  const texts = client
    .events()
    .flatMap((event) =>
      event.type === "item.completed" && event.item.kind === "agentMessage"
        ? [event.item.text]
        : [],
    );
  expect(texts).toEqual(["answer to PROMPT:write", "answer to PROMPT:next"]);

  // The command really ran, and git sees what it made.
  const status = await client.call("git.status", { cwd: project });
  expect(status.repo?.branch).toBe("main");
  expect(status.files).toEqual([
    { path: "made.txt", oldPath: null, status: "U", additions: 1, deletions: 0, binary: false },
  ]);
  const diff = await client.call("git.diff", {
    cwd: project,
    from: status.repo?.from ?? "",
    path: "made.txt",
    status: "U",
  });
  expect(diff.patch).toContain("+made");

  // Committing takes everything, and leaves nothing uncommitted.
  const done = await client.call("git.commit", { cwd: project, message: "Add made" });
  expect(done.commit).toMatch(/^[0-9a-f]{7,}$/);
  expect((await client.call("git.status", { cwd: project })).files).toEqual([]);
  client.close();
}, 60_000);

test("files, search and a terminal reach the agent's machine", async () => {
  const client = connect(daemon.url);
  await client.opened;
  const listing = await client.call("files.list", { path: project });
  expect(listing.entries.map((entry) => entry.name)).toContain("hello.txt");
  const file = await client.call("files.read", { path: join(project, "hello.txt") });
  expect(file).toMatchObject({ text: "hello\n", binary: false, truncated: false });
  expect(client.call("files.read", { path: "/etc/hostname" })).rejects.toThrow("inside a folder");
  const found = await client.call("files.search", { root: project, query: "hello" });
  expect(found.files[0]?.path).toBe("hello.txt");

  const terminal = await client.call("terminal.create", {
    sessionId: null,
    cwd: project,
    cols: 80,
    rows: 24,
  });
  await client.call("terminal.attach", { id: terminal.id });
  await client.call("terminal.write", { id: terminal.id, data: "echo term-$((40+2))\n" });
  const printed = () =>
    client.pushes
      .flatMap((push) => (push.type === "terminal.output" ? [atob(push.data)] : []))
      .join("");
  await client.until(() => printed().includes("term-42"));
  // Whoever attaches later is shown what was printed before.
  const again = await client.call("terminal.attach", { id: terminal.id });
  expect(atob(again.data)).toContain("term-42");
  await client.call("terminal.close", { id: terminal.id });
  expect((await client.call("terminal.list", { sessionId: null })).terminals).toEqual([]);
  client.close();
}, 60_000);

test("a worktree session starts on its own branch, and archiving hides it", async () => {
  const client = connect(daemon.url);
  await client.opened;
  const session = await client.call("session.create", {
    cwd: project,
    mode: "fullAccess",
    worktree: { branch: "feature/x" },
  });
  expect(session.worktree).toMatchObject({ repo: project, branch: "feature/x" });
  expect(session.cwd).toContain("feature-x");
  const branches = await client.call("git.branches", { cwd: project });
  expect(branches.local).toContain("feature/x");

  script = () => ({ text: ["ok"] });
  await client.call("session.open", { sessionId: session.id });
  await client.call("session.send", { sessionId: session.id, text: "PROMPT:hi" });
  await client.until(() => client.events().some((event) => event.type === "turn.completed"));
  const fork = await client.call("session.fork", { sessionId: session.id });
  expect(fork.forkedFrom).toBe(session.id);
  const forked = await client.call("session.open", { sessionId: fork.id });
  if (!("state" in forked)) throw new Error("expected a snapshot");
  expect(forked.state.turns.length).toBe(1);

  await client.call("session.update", { sessionId: session.id, archived: true });
  const active = await client.call("session.list", { archived: false });
  expect(active.sessions.some((row) => row.id === session.id)).toBe(false);
  const archived = await client.call("session.list", { archived: true });
  expect(archived.sessions.some((row) => row.id === session.id)).toBe(true);
  client.close();
}, 60_000);

test("a model of the owner's own provider answers through the gateway", async () => {
  script = (prompt) => ({ text: [`provider says ${prompt}`] });
  const client = connect(daemon.url);
  await client.opened;
  const { kinds } = await client.call("providers.kinds", {});
  expect(kinds.map((kind) => kind.id)).toContain("anthropic");

  // The mock model speaks the Responses API, so it stands in for an endpoint of the owner's.
  const saved = await client.call("providers.save", {
    name: "My endpoint",
    kind: "custom",
    api: "openai-responses",
    baseUrl: model.url,
    apiKey: "secret-key",
    models: [
      {
        id: "mock-model",
        name: "Mock",
        reasoning: false,
        images: false,
        // Beyond the 272k codex allows a model it does not know.
        contextWindow: 1_000_000,
        maxTokens: 4_000,
      },
    ],
  });
  expect(saved).toMatchObject({ id: "my-endpoint", hasKey: true });
  // The key went in and does not come back out.
  expect(JSON.stringify(await client.call("providers.list", {}))).not.toContain("secret-key");
  await client.until(() => client.pushes.some((push) => push.type === "models.changed"));
  const { models } = await client.call("models.list", {});
  const mine = models.find((entry) => entry.id === "my-endpoint/mock-model");
  expect(mine?.provider).toEqual({ id: "my-endpoint", name: "My endpoint" });

  // What codex itself sends a model it does not know, to hold the catalog's instructions to.
  const own = await client.call("session.create", { cwd: project, mode: "readOnly" });
  await client.call("session.open", { sessionId: own.id });
  const direct = model.requests.length;
  await client.call("session.send", { sessionId: own.id, text: "PROMPT:own" });
  await client.until(() => contextWindow(client.events(), own.id) !== null);
  const ownInstructions = model.requests.slice(direct).map(instructionsOf).find(Boolean);

  const before = model.requests.length;
  const session = await client.call("session.create", {
    cwd: project,
    model: "my-endpoint/mock-model",
    mode: "readOnly",
  });
  expect(session.model).toBe("my-endpoint/mock-model");
  await client.call("session.open", { sessionId: session.id });
  await client.call("session.send", { sessionId: session.id, text: "PROMPT:hi" });
  const ofSession = () => client.events().filter((event) => event.sessionId === session.id);
  await client.until(() => ofSession().some((event) => event.type === "turn.completed"));
  const said = ofSession()
    .flatMap((event) => (event.type === "item.completed" ? [event.item] : []))
    .find((item) => item.kind === "agentMessage");
  expect(said).toMatchObject({ text: "provider says PROMPT:hi" });
  // The provider was asked for the model by its own name, not by Cycle's.
  expect(model.requests.slice(before).at(-1)).toMatchObject({ model: "mock-model" });
  // Codex reads as far as the owner said the model can, less its 5% margin.
  await client.until(() => contextWindow(client.events(), session.id) !== null);
  expect(contextWindow(client.events(), session.id)).toBe(950_000);
  // The catalog gives the model the instructions codex gives one it does not know. When an
  // upgrade of codex changes them, copy its prompt.md to harness/codex/src again.
  expect(ownInstructions).toBeTruthy();
  expect(JSON.stringify(model.requests.slice(before).at(-1))).toContain(
    JSON.stringify(ownInstructions).slice(1, -1),
  );

  // A window changed later reaches the next session, once the extra process starts again.
  await client.call("providers.save", {
    id: saved.id,
    name: "My endpoint",
    kind: "custom",
    api: "openai-responses",
    baseUrl: model.url,
    models: [
      {
        id: "mock-model",
        name: "Mock",
        reasoning: false,
        images: false,
        contextWindow: 400_000,
        maxTokens: 4_000,
      },
    ],
  });
  const second = await client.call("session.create", {
    cwd: project,
    model: "my-endpoint/mock-model",
    mode: "readOnly",
  });
  await client.call("session.open", { sessionId: second.id });
  await client.call("session.send", { sessionId: second.id, text: "PROMPT:again" });
  await client.until(() => contextWindow(client.events(), second.id) !== null);
  expect(contextWindow(client.events(), second.id)).toBe(380_000);

  // The session is listed beside codex's own, and stays with its kind of model.
  const { sessions } = await client.call("session.list", { archived: false });
  expect(sessions.some((row) => row.id === session.id)).toBe(true);
  const codexOwn = models.find((entry) => entry.provider === null);
  if (!codexOwn) throw new Error("codex offers no model of its own");
  expect(
    client.call("session.update", { sessionId: session.id, model: codexOwn.id }),
  ).rejects.toThrow("stays with that kind");

  await client.call("providers.delete", { id: saved.id });
  expect((await client.call("providers.list", {})).providers).toEqual([]);
  client.close();
}, 60_000);

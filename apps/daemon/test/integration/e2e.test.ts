import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHarness } from "@cycle/harness-codex";
import { type SessionState, reduceSession } from "@cycle/protocol";
import { type Daemon, startDaemon } from "../../src/index.ts";
import { type MockModel, type MockReply, startMockModel } from "./mock-model.ts";
import { connect } from "./wire-client.ts";

let model: MockModel;
let daemon: Daemon;
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
  daemon = await startDaemon({
    harness: new CodexHarness({
      config: model.codexConfig,
      env: { CODEX_HOME: join(root, "codex") },
    }),
    home: join(root, "home"),
  });
});

afterAll(async () => {
  await daemon?.stop();
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

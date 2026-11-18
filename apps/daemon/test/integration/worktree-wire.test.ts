import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHarness } from "@cycle/harness-codex";
import {
  type Daemon,
  type OpenProviders,
  Harnesses,
  diskFile,
  openProviders,
  startDaemon,
} from "../../src/index.ts";
import { type MockModel, type MockReply, startMockModel } from "./mock-model.ts";
import { type WireClient, connect } from "./wire-client.ts";

/** `worktree.list` and `worktree.remove` over the wire, in a scratch repository, with real git and codex. */
let model: MockModel;
let daemon: Daemon;
let providers: OpenProviders;
let client: WireClient;
let root: string;
let project: string;
let byHand: string;
/** What the model answers next. */
let next: MockReply = { text: ["done"] };
/** The fork of the first session: codex does not delete a conversation another was forked from. */
let forkId = "";

const BY_HAND = "Cycle removes only the worktrees it made. Remove this one with git.";
const NOT_LISTED = "That folder is not a worktree of this repository.";

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: project,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

const list = async () => (await client.call("worktree.list", { workspace: project })).worktrees;
const find = async (path: string) => (await list()).find((entry) => entry.path === path);

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cycle-worktree-wire-")));
  project = join(root, "project");
  byHand = join(root, "by-hand");
  Bun.spawnSync(["mkdir", "-p", project, join(root, "codex")]);
  writeFileSync(join(project, "hello.txt"), "hello\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  model = startMockModel(() => next);
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
  client = connect(daemon.url);
  await client.opened;
});

afterAll(async () => {
  client?.close();
  await daemon?.stop();
  providers?.stop();
  model?.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a session's worktree is listed as managed, with the session and its record, and forks share it", async () => {
  const first = await client.call("session.create", {
    cwd: project,
    mode: "readOnly",
    worktree: { branch: "feature/one" },
  });
  const path = first.worktree?.path ?? "";
  expect(path).toBe(join(project, ".agents", "worktree", "feature-one"));
  const answer = await client.call("worktree.list", { workspace: project });
  expect(answer.workspace).toBe(project);
  expect(answer.worktrees).toHaveLength(1);
  expect(answer.worktrees[0]).toMatchObject({
    path,
    branch: "feature/one",
    base: first.worktree?.base,
    origin: "owner",
    managed: true,
    locked: false,
    missing: false,
    dirty: false,
  });
  expect(answer.worktrees[0]?.sessions.map((session) => session.id)).toEqual([first.id]);

  // The same repository from inside the worktree: the answer is of the main checkout.
  const inside = await client.call("worktree.list", { workspace: path });
  expect(inside.workspace).toBe(project);
  expect(inside.worktrees.map((entry) => entry.path)).toEqual([path]);

  // A fork shares the worktree: two sessions use it.
  await client.call("session.open", { sessionId: first.id });
  await client.call("session.send", { sessionId: first.id, text: "go" });
  await client.until(() => client.events().some((event) => event.type === "turn.completed"));
  const fork = await client.call("session.fork", { sessionId: first.id });
  const both = (await find(path))?.sessions.map((session) => session.id).toSorted();
  expect(both).toEqual([first.id, fork.id].toSorted());
  forkId = fork.id;
}, 60_000);

test("a worktree made by hand is listed, not managed, and cannot be removed", async () => {
  git("worktree", "add", "-q", "-b", "by-hand", byHand);
  const entry = await find(byHand);
  expect(entry).toMatchObject({ branch: "by-hand", managed: false, sessions: [] });
  await expect(
    client.call("worktree.remove", { workspace: project, path: byHand }),
  ).rejects.toThrow(BY_HAND);
  expect(existsSync(byHand)).toBe(true);
  expect(git("branch", "--list", "by-hand")).toContain("by-hand");
});

test("a worktree with uncommitted work says so", async () => {
  const path = join(project, ".agents", "worktree", "feature-one");
  expect((await find(path))?.dirty).toBe(false);
  writeFileSync(join(path, "scratch.txt"), "not committed\n");
  expect((await find(path))?.dirty).toBe(true);
});

test("paths that are not a listed worktree are refused, and nothing is removed", async () => {
  const path = join(project, ".agents", "worktree", "feature-one");
  const refused = [
    project,
    `${path}/`,
    `${path}/../feature-one`,
    join(path, "..", "..", "..", "x"),
    join(root, "elsewhere"),
    "../x",
    "",
  ];
  for (const candidate of refused) {
    await expect(
      client.call("worktree.remove", { workspace: project, path: candidate }),
    ).rejects.toThrow(NOT_LISTED);
  }
  await expect(
    client.call("worktree.remove", { workspace: join(root, "nowhere"), path }),
  ).rejects.toThrow();
  expect(existsSync(path)).toBe(true);
  expect(existsSync(join(project, "hello.txt"))).toBe(true);
});

test("a locked worktree is refused, and git's own lock stays", async () => {
  const path = join(project, ".agents", "worktree", "feature-one");
  git("worktree", "lock", path);
  expect((await find(path))?.locked).toBe(true);
  await expect(client.call("worktree.remove", { workspace: project, path })).rejects.toThrow(
    "This worktree is locked. Unlock it with git (git worktree unlock) to remove it.",
  );
  expect(existsSync(path)).toBe(true);
  git("worktree", "unlock", path);
});

test("deleted without the box, a worktree stays with no session, and removing it keeps the branch", async () => {
  const path = join(project, ".agents", "worktree", "feature-one");
  const users = (await find(path))?.sessions ?? [];
  expect(users).toHaveLength(2);
  const ids = [forkId, ...users.map((user) => user.id).filter((id) => id !== forkId)];
  for (const sessionId of ids) await client.call("session.delete", { sessionId });
  expect(await find(path)).toMatchObject({ sessions: [], origin: null, base: null, dirty: true });
  await client.call("worktree.remove", { workspace: project, path });
  expect(existsSync(path)).toBe(false);
  expect(await find(path)).toBeUndefined();
  expect(git("branch", "--list", "feature/one")).toContain("feature/one");
  expect(git("worktree", "list", "--porcelain")).not.toContain(path);
  // Asked again, it is not a worktree any more.
  await expect(client.call("worktree.remove", { workspace: project, path })).rejects.toThrow(
    NOT_LISTED,
  );
});

test("a worktree whose folder was deleted by hand is listed missing and removed from git's list", async () => {
  const made = await client.call("session.create", {
    cwd: project,
    mode: "readOnly",
    worktree: { branch: "feature/two" },
  });
  const path = made.worktree?.path ?? "";
  rmSync(path, { recursive: true, force: true });
  expect(await find(path)).toMatchObject({ missing: true, dirty: null, managed: true });
  await client.call("worktree.remove", { workspace: project, path });
  expect(git("worktree", "list", "--porcelain")).not.toContain(path);
  expect(git("branch", "--list", "feature/two")).toContain("feature/two");
  await client.call("session.delete", { sessionId: made.id });
}, 60_000);

test("a worktree a session is working in is refused, and once it is idle the removal goes ahead", async () => {
  next = { text: ["slow", " answer"], delayMs: 1500 };
  const made = await client.call("session.create", {
    cwd: project,
    mode: "readOnly",
    worktree: { branch: "feature/three" },
  });
  const path = made.worktree?.path ?? "";
  await client.call("session.open", { sessionId: made.id });
  const done = client.events().filter((event) => event.type === "turn.completed").length;
  await client.call("session.send", { sessionId: made.id, text: "wait" });
  await client.until(() =>
    client.pushes.some(
      (push) =>
        push.type === "sessions.changed" &&
        push.sessions.some((session) => session.id === made.id && session.activity === "running"),
    ),
  );
  expect((await find(path))?.sessions).toMatchObject([{ id: made.id, activity: "running" }]);
  await expect(client.call("worktree.remove", { workspace: project, path })).rejects.toThrow(
    "A session is working in this worktree",
  );
  expect(existsSync(path)).toBe(true);

  await client.until(
    () => client.events().filter((event) => event.type === "turn.completed").length > done,
  );
  // Idle, it does not block: the owner confirmed with the list's names in front of them.
  await client.call("worktree.remove", { workspace: project, path });
  expect(existsSync(path)).toBe(false);
  await client.call("session.delete", { sessionId: made.id });
}, 60_000);

test("a worktree whose .git file is gone is not removed through the checkout above it", async () => {
  const made = await client.call("session.create", {
    cwd: project,
    mode: "readOnly",
    worktree: { branch: "feature/broken" },
  });
  const path = made.worktree?.path ?? "";
  writeFileSync(join(path, "work.txt"), "uncommitted\n");
  const link = readFileSync(join(path, ".git"), "utf8");
  rmSync(join(path, ".git"));
  // Git takes the folder for part of the main checkout, whose own tracked file must stay too.
  await expect(client.call("worktree.remove", { workspace: project, path })).rejects.toThrow(
    "This folder is not the root of its worktree",
  );
  expect(existsSync(join(path, "work.txt"))).toBe(true);
  expect(existsSync(join(project, "hello.txt"))).toBe(true);
  expect(git("worktree", "list", "--porcelain")).toContain(path);

  // With its link back it is a worktree again, and goes.
  writeFileSync(join(path, ".git"), link);
  await client.call("worktree.remove", { workspace: project, path });
  expect(existsSync(path)).toBe(false);
  await client.call("session.delete", { sessionId: made.id });
}, 60_000);

test("a worktree inside another is not managed, and the one holding it is not removed until it is gone", async () => {
  const made = await client.call("session.create", {
    cwd: project,
    mode: "readOnly",
    worktree: { branch: "feature/outer" },
  });
  const outer = made.worktree?.path ?? "";
  const sub = join(outer, "sub");
  const entered = join(outer, ".claude", "worktrees", "entered");
  git("worktree", "add", "-q", "-b", "inner-sub", sub);
  git("worktree", "add", "-q", "-b", "inner-entered", entered);
  writeFileSync(join(sub, "subwork.txt"), "uncommitted\n");
  writeFileSync(join(entered, "enteredwork.txt"), "uncommitted\n");
  expect((await list()).map((entry) => [entry.path, entry.managed])).toEqual([
    [outer, true],
    [byHand, false],
    [entered, false],
    [sub, false],
  ]);

  await expect(client.call("worktree.remove", { workspace: project, path: sub })).rejects.toThrow(
    BY_HAND,
  );
  await expect(client.call("worktree.remove", { workspace: project, path: outer })).rejects.toThrow(
    "Another worktree is inside this one",
  );
  expect(existsSync(join(sub, "subwork.txt"))).toBe(true);
  expect(existsSync(join(entered, "enteredwork.txt"))).toBe(true);

  git("worktree", "remove", "--force", sub);
  git("worktree", "remove", "--force", entered);
  await client.call("worktree.remove", { workspace: project, path: outer });
  expect(existsSync(outer)).toBe(false);
  expect(git("branch", "--list", "inner-sub")).toContain("inner-sub");
  await client.call("session.delete", { sessionId: made.id });
}, 60_000);

test("a locked worktree asked for with the delete: the conversation goes, the folder stays, and the answer says so", async () => {
  const made = await client.call("session.create", {
    cwd: project,
    mode: "readOnly",
    worktree: { branch: "feature/locked" },
  });
  const path = made.worktree?.path ?? "";
  git("worktree", "lock", path);
  await expect(
    client.call("session.delete", { sessionId: made.id, removeWorktree: true }),
  ).rejects.toThrow("The session is deleted, but its worktree could not be removed");
  // A partial failure, not a refusal before anything changed: the page's dialog must say it first.
  expect(existsSync(path)).toBe(true);
  expect(await find(path)).toMatchObject({ locked: true, sessions: [] });
  git("worktree", "unlock", path);
  await client.call("worktree.remove", { workspace: project, path });
}, 60_000);

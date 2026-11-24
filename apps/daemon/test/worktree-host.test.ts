import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWorktreeMcp } from "../src/connectors/worktree-mcp.ts";
import type { SessionEntry } from "../src/index-file.ts";
import type { SessionLog } from "../src/log/types.ts";
import { Session } from "../src/session.ts";
import { worktreeHost } from "../src/worktree-host.ts";

let root: string;
const git = async (dir: string, ...args: string[]) => {
  const child = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  await child.exited;
};

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "cycle-host-")));
  await git(root, "init", "-q", "-b", "main");
  await writeFile(join(root, "a.txt"), "a");
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "first");
});
afterAll(() => rm(root, { recursive: true, force: true }));

const setup = () => {
  const entry: SessionEntry = {
    agent: "codex",
    agentSessionId: "s",
    cwd: root,
    createdAt: new Date().toISOString(),
  };
  const session = new Session("s", entry, {} as SessionLog);
  const host = worktreeHost({
    session: (id) => (id === "s" ? session : undefined),
    remember: (target, patch) => {
      target.entry = { ...target.entry, ...patch };
      if ("worktree" in patch && patch.worktree === undefined) delete target.entry.worktree;
    },
    warn: () => {},
  });
  return { session, host };
};

const call = async (host: ReturnType<typeof setup>["host"], method: string, params: unknown) => {
  const response = await handleWorktreeMcp(
    host,
    "s",
    new Request("http://127.0.0.1/mcp/cycle-worktree", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return (await response.json()) as {
    result?: { tools?: unknown[]; content?: { text: string }[]; isError?: boolean };
    error?: unknown;
  };
};

test("the server lists the two tools Claude has, under the same names", async () => {
  const { host } = setup();
  const listed = await call(host, "tools/list", {});
  expect(((listed.result?.tools ?? []) as { name: string }[]).map((tool) => tool.name)).toEqual([
    "EnterWorktree",
    "ExitWorktree",
  ]);
});

test("entering moves the session's folder, and the agent is marked to start again there", async () => {
  const { session, host } = setup();
  const answer = await call(host, "tools/call", {
    name: "EnterWorktree",
    arguments: { name: "host-one" },
  });
  const out = JSON.parse(answer.result?.content?.[0]?.text ?? "{}");
  expect(out.worktreePath).toBe(join(root, ".agents", "worktree", "host-one"));
  expect(out.worktreeBranch).toBe("worktree-host-one");
  expect(session.entry.cwd).toBe(out.worktreePath);
  expect(session.entry.worktree).toMatchObject({ managed: true, root });
  expect(session.isStaleFor("cwd")).toBe(true);

  // Not twice.
  const again = await call(host, "tools/call", { name: "EnterWorktree", arguments: {} });
  expect(again.result?.isError).toBe(true);
});

test("name and path together are refused", async () => {
  const { host } = setup();
  const answer = await call(host, "tools/call", {
    name: "EnterWorktree",
    arguments: { name: "a", path: "/x" },
  });
  expect(answer.result?.isError).toBe(true);
});

test("removing refuses unsaved work unless discard_changes, then removes the worktree and goes back", async () => {
  const { session, host } = setup();
  await call(host, "tools/call", { name: "EnterWorktree", arguments: { name: "host-two" } });
  const path = session.entry.cwd;
  await writeFile(join(path, "dirty.txt"), "x");

  const refused = await call(host, "tools/call", {
    name: "ExitWorktree",
    arguments: { action: "remove" },
  });
  expect(refused.result?.isError).toBe(true);
  expect(refused.result?.content?.[0]?.text).toContain("dirty.txt");
  expect(session.entry.cwd).toBe(path);

  const done = await call(host, "tools/call", {
    name: "ExitWorktree",
    arguments: { action: "remove", discard_changes: true },
  });
  const out = JSON.parse(done.result?.content?.[0]?.text ?? "{}");
  expect(out).toMatchObject({
    action: "remove",
    originalCwd: root,
    worktreePath: path,
    discardedFiles: 1,
  });
  expect(session.entry.cwd).toBe(root);
  expect(session.entry.worktree).toBeUndefined();
});

test("keeping leaves the worktree on disk; outside a worktree there is nothing to exit", async () => {
  const { session, host } = setup();
  const none = await call(host, "tools/call", {
    name: "ExitWorktree",
    arguments: { action: "keep" },
  });
  expect(none.result?.isError).toBe(true);
  await call(host, "tools/call", { name: "EnterWorktree", arguments: { name: "host-three" } });
  const path = session.entry.cwd;
  await call(host, "tools/call", { name: "ExitWorktree", arguments: { action: "keep" } });
  expect(session.entry.cwd).toBe(root);
  const back = await call(host, "tools/call", { name: "EnterWorktree", arguments: { path } });
  expect(JSON.parse(back.result?.content?.[0]?.text ?? "{}").worktreePath).toBe(path);
});

test("a batch is refused, not answered with nothing", async () => {
  const batch = new Request("http://gateway/mcp", {
    method: "POST",
    body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
  });
  const response = await handleWorktreeMcp({} as never, "s1", batch);
  expect(response.status).toBe(200);
  expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32600);
});

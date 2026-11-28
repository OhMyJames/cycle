import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleWorktreeMcp } from "../src/connectors/worktree-mcp.ts";
import type { SessionEntry } from "../src/index-file.ts";
import type { SessionLog } from "../src/log/types.ts";
import { Session } from "../src/session.ts";
import { createWorktree } from "../src/worktree.ts";
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

// Claude's own EnterWorktree and ExitWorktree, told by the harness's hooks (docs/protocol.md §6 "中途进出").
const claude = (scripts: { setup?: string; cleanup?: string }) => {
  const entry: SessionEntry = {
    agent: "claude",
    agentSessionId: "c",
    cwd: root,
    createdAt: new Date().toISOString(),
    environment: {
      id: "e",
      name: "e",
      variables: [{ name: "LITERAL", value: "v" }],
      secrets: [],
      actions: [],
      ...(scripts.setup !== undefined ? { setup: { default: scripts.setup } } : {}),
      ...(scripts.cleanup !== undefined ? { cleanup: { default: scripts.cleanup } } : {}),
    },
  };
  const session = new Session("c", entry, {} as SessionLog);
  const warned: string[] = [];
  const host = worktreeHost({
    session: (id) => (id === "c" ? session : undefined),
    remember: () => {},
    warn: (event) => warned.push(event),
  });
  const tool = async (
    name: string,
    id: string,
    input: unknown,
    act: () => Promise<unknown>,
  ): Promise<unknown> => {
    await host.native("c", { phase: "before", tool: name, toolUseId: id, input });
    const response = await act();
    return host.native("c", { phase: "after", tool: name, toolUseId: id, input, response });
  };
  // A call Claude refuses fails, and a failed tool has no `after`.
  const exit = async (
    input: unknown,
    id: string,
    remove: () => Promise<unknown>,
    refused = false,
  ) => {
    await host.native("c", { phase: "before", tool: "ExitWorktree", toolUseId: id, input });
    await remove();
    if (!refused)
      await host.native("c", { phase: "after", tool: "ExitWorktree", toolUseId: id, input });
  };
  return { host, warned, tool, exit };
};

const lines = async (file: string) =>
  (await readFile(file, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");

test("Claude's EnterWorktree that makes a worktree runs setup there once; entering an existing one does not", async () => {
  const marks = join(root, "claude-setup.log");
  const { tool, warned } = claude({ setup: `pwd -P >> ${marks}; echo "$LITERAL" >> ${marks}` });
  const made = await tool("EnterWorktree", "t1", { name: "native-one" }, async () => {
    const tree = await createWorktree(root, { name: "native-one" });
    return { worktreePath: tree.path, worktreeBranch: tree.branch, message: "ok" };
  });
  expect(made).toEqual({});
  const path = join(root, ".agents", "worktree", "native-one");
  expect(await lines(marks)).toEqual([path, "v"]);

  // Entered again by name (the repository's hook reuses the directory) and by path: nothing runs.
  for (const [id, input] of [
    ["t2", { name: "native-one" }],
    ["t3", { path }],
  ] as const) {
    await tool("EnterWorktree", id, input, async () => ({ worktreePath: path, message: "ok" }));
  }
  expect(await lines(marks)).toEqual([path, "v"]);
  expect(warned).toEqual([]);
});

test("a failed setup is logged and told to Claude, not raised", async () => {
  const { tool, warned } = claude({ setup: "echo broken >&2; exit 3" });
  const answer = (await tool("EnterWorktree", "t1", {}, async () => {
    const tree = await createWorktree(root, { name: "native-failing" });
    return { worktreePath: tree.path, message: "ok" };
  })) as { note?: string };
  expect(answer.note).toContain("broken");
  expect(warned).toEqual(["worktree_setup_failed"]);
});

test("Claude's ExitWorktree remove runs cleanup first, in the worktree; a failing cleanup does not stop it", async () => {
  const marks = join(root, "claude-cleanup.log");
  const { tool, exit, warned } = claude({
    cleanup: `pwd -P >> ${marks}; test -f a.txt && echo present >> ${marks}; exit 1`,
  });
  const path = join(root, ".agents", "worktree", "native-two");
  await tool("EnterWorktree", "t1", { name: "native-two" }, async () => {
    await createWorktree(root, { name: "native-two" });
    return { worktreePath: path, message: "ok" };
  });
  let there = false;
  await exit({ action: "remove" }, "t2", async () => {
    there = (await lines(marks)).length === 2;
    await git(root, "worktree", "remove", "--force", path);
  });
  expect(there).toBe(true);
  expect(await lines(marks)).toEqual([path, "present"]);
  expect(warned).toEqual(["worktree_cleanup_failed"]);
  // Once, and not again for the worktree that is gone.
  await exit({ action: "remove" }, "t3", async () => {});
  expect(await lines(marks)).toEqual([path, "present"]);
});

test("cleanup does not run for keep, for unsaved work Claude will refuse to remove, or for a worktree Claude did not make", async () => {
  const marks = join(root, "claude-untouched.log");
  const { tool, exit } = claude({ cleanup: `echo ran >> ${marks}` });
  // One Cycle or a person made before: Claude only enters it.
  const other = await createWorktree(root, { name: "native-other" });
  await tool("EnterWorktree", "t1", { path: other.path }, async () => ({
    worktreePath: other.path,
    message: "ok",
  }));
  await exit({ action: "remove" }, "t2", async () => {});
  expect(await lines(marks)).toEqual([]);

  const path = join(root, ".agents", "worktree", "native-three");
  await tool("EnterWorktree", "t3", { name: "native-three" }, async () => {
    await createWorktree(root, { name: "native-three" });
    return { worktreePath: path, message: "ok" };
  });
  await exit({ action: "keep" }, "t4", async () => {});
  expect(await lines(marks)).toEqual([]);

  await tool("EnterWorktree", "t5", { path }, async () => ({ worktreePath: path, message: "ok" }));
  await writeFile(join(path, "dirty.txt"), "x");
  await exit({ action: "remove" }, "t6", async () => {}, true);
  expect(await lines(marks)).toEqual([]);
  await exit({ action: "remove", discard_changes: true }, "t7", async () => {});
  expect(await lines(marks)).toEqual(["ran"]);
});

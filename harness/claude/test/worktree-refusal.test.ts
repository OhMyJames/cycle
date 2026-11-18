import { expect, test } from "bun:test";
import { settle } from "./fake-sdk.ts";
import {
  call,
  create,
  fakePort,
  init,
  refusedWith,
  remove,
  setup,
  signal,
} from "./worktree-fakes.ts";

// What a refusal says to the model, which Claude Code shows only as the path it did not find; and
// the edges of what is told a helper's from an agent's own, and where its commands show they ran.

/** What the hook answers when the port refuses with `why`. */
async function refused(why: string) {
  const { port } = fakePort();
  port.fail = why;
  const { hooks } = await setup(port);
  const answer = await hooks.WorktreeCreate?.[0]?.hooks[0]?.(create("x"), undefined, { signal });
  return answer && "hookSpecificOutput" in answer ? answer.hookSpecificOutput.worktreePath : "";
}

test("a message of many lines is one line, as git's stderr is", async () => {
  expect(await refused("fatal: 'cycle/x.lock' is not\na valid branch name\r\n\n  Usage: git")).toBe(
    "/cycle-refused: fatal: 'cycle/x.lock' is not a valid branch name Usage: git",
  );
});

test("a NUL is no part of a path, and what is left is words", async () => {
  expect(await refused("a\0b")).toBe("/cycle-refused: a b");
  expect(await refused("\0\0")).toBe(
    refusedWith("Cycle could not make a worktree.").hookSpecificOutput.worktreePath,
  );
});

test("a message that is the name of a folder is no path of one", async () => {
  // Alone it was `/etc`, which Claude Code entered as a worktree.
  for (const name of ["etc", "tmp", "usr/bin", "/"]) {
    const path = await refused(name);
    expect(path.startsWith("/cycle-refused: ")).toBe(true);
    expect(path).not.toBe(`/${name}`);
  }
});

test("a long message is cut so that its path stays a name that can be looked for", async () => {
  const path = await refused("word ".repeat(100));
  expect(path.length).toBeLessThanOrEqual("/cycle-refused: ".length + 200);
  expect(path.startsWith("/cycle-refused: word word")).toBe(true);
  expect(path.endsWith(" ")).toBe(false);
});

test("no part of a message is a segment that moves a path, whether it was cut there or not", async () => {
  for (const why of [
    "x/../etc",
    "../..",
    "a/./b/.",
    `${"y".repeat(198)}/..z`,
    `${"y".repeat(199)}/..`,
  ]) {
    const parts = (await refused(why)).split("/");
    expect(parts).not.toContain("..");
    expect(parts).not.toContain(".");
  }
});

test("a helper's name is `agent-` and at least eight hex digits, and no fewer", async () => {
  const { port, calls } = fakePort();
  const { hooks } = await setup(port);
  const hook = hooks.WorktreeCreate?.[0]?.hooks[0];
  for (const name of ["agent-1234567", "agent-12345678", "agent-12345678x", "agent-"]) {
    await hook?.(create(name), undefined, { signal });
  }
  expect(calls).toEqual([
    "enter id1 agent-1234567 helper=false",
    "enter id1 agent-12345678 helper=true",
    "enter id1 agent-12345678x helper=false",
    "enter id1 agent- helper=false",
  ]);
});

test("a command run just after the agent began in a worktree shows that folder", async () => {
  const { query, events } = await setup();
  events.length = 0;
  query.say(init("/repo/.agents/worktree/cycle-x"));
  query.say(call("t1"));
  await settle();
  expect(events.filter((event) => event.type === "item.started")).toMatchObject([
    { item: { kind: "command", cwd: "/repo/.agents/worktree/cycle-x" } },
  ]);
});

test("a helper's removal leaves the folder the session's own agent is in", async () => {
  const { hooks, query, events } = await setup();
  await hooks.WorktreeCreate?.[0]?.hooks[0]?.(create("x"), undefined, { signal });
  await hooks.WorktreeRemove?.[0]?.hooks[0]?.(
    remove("/repo/.agents/worktree/agent-a7133ce6ec288d86b", { agent_id: "a1" }),
    undefined,
    { signal },
  );
  events.length = 0;
  query.say(call("t1"));
  await settle();
  expect(events).toMatchObject([
    { type: "item.started", item: { cwd: "/repo/.agents/worktree/cycle-x" } },
  ]);
});

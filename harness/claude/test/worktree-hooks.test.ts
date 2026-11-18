import { expect, test } from "bun:test";
import { type HarnessEvent, declares } from "@cycle/protocol";
import { ClaudeHarness } from "../src/index.ts";
import { fakeSbx } from "./fake-sbx.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";
import {
  call,
  create,
  fakePort,
  init,
  options,
  prompt,
  refusedWith,
  remove,
  setup,
  signal,
} from "./worktree-fakes.ts";

// Claude Code asks Cycle for a worktree by a callback in this process, and Cycle answers.

test("a worktree asked for goes to the port under the session's own id, and its root is the answer", async () => {
  const { port, calls } = fakePort();
  const { hooks } = await setup(port);
  const hook = hooks.WorktreeCreate?.[0]?.hooks[0];
  expect(await hook?.(create("fix-it"), undefined, { signal })).toEqual({
    hookSpecificOutput: {
      hookEventName: "WorktreeCreate",
      worktreePath: "/repo/.agents/worktree/cycle-fix-it",
    },
  });
  // Not the id Claude Code gave in its input: the process knows which session it runs.
  expect(calls).toEqual(["enter id1 fix-it helper=false"]);
  // Making one may wait for its repository's lock and then check out for two minutes.
  expect(hooks.WorktreeCreate?.[0]?.timeout).toBe(180);
  expect(hooks.WorktreeRemove?.[0]?.timeout).toBe(180);
});

test("a helper agent's worktree is told apart by its id or by the name Claude Code gives it", async () => {
  const { port, calls } = fakePort();
  const { hooks } = await setup(port);
  const hook = hooks.WorktreeCreate?.[0]?.hooks[0];
  await hook?.(create("by-id", { agent_id: "a1" }), undefined, { signal });
  await hook?.(create("agent-a7133ce6ec288d86b"), undefined, { signal });
  // A name only looks like it when it is `agent-` and the helper's hex id.
  await hook?.(create("agent-notes"), undefined, { signal });
  expect(calls).toEqual([
    "enter id1 by-id helper=true",
    "enter id1 agent-a7133ce6ec288d86b helper=true",
    "enter id1 agent-notes helper=false",
  ]);
});

test("a port that refuses is answered with the words the model reads", async () => {
  const { port, calls } = fakePort();
  port.fail = "This session already works in a worktree.";
  const { hooks } = await setup(port);
  const hook = hooks.WorktreeCreate?.[0]?.hooks[0];
  // Claude Code names a path that is not there in its error, and carries nothing else of a refusal.
  expect(await hook?.(create("again"), undefined, { signal })).toEqual(
    refusedWith("This session already works in a worktree."),
  );
  port.fail = " ";
  expect(await hook?.(create("again"), undefined, { signal })).toEqual(
    refusedWith("Cycle could not make a worktree."),
  );
  expect(calls).toHaveLength(2);
});

test("a name that is no branch's reaches no port and is refused", async () => {
  const { port, calls } = fakePort();
  const { hooks } = await setup(port);
  const hook = hooks.WorktreeCreate?.[0]?.hooks[0];
  const bad = "A worktree's name is letters, digits, dots, dashes and slashes, 64 at most.";
  for (const name of ["../x", "a..b", "a b", "a;rm", "/abs", "x".repeat(65), ""]) {
    expect(await hook?.(create(name), undefined, { signal })).toEqual(refusedWith(bad));
  }
  // The longest and the plainest are allowed.
  await hook?.(create("x".repeat(64)), undefined, { signal });
  await hook?.(create("team/fix_1.2"), undefined, { signal });
  expect(calls).toEqual([
    `enter id1 ${"x".repeat(64)} helper=false`,
    "enter id1 team/fix_1.2 helper=false",
  ]);
});

test("a removal asked for is told to the port and answered with nothing, so Cycle keeps the folder", async () => {
  const { port, calls } = fakePort();
  const { hooks, logged } = await setup(port);
  const hook = hooks.WorktreeRemove?.[0]?.hooks[0];
  expect(await hook?.(remove("/repo/.agents/worktree/cycle-x"), undefined, { signal })).toEqual({});
  expect(await hook?.(remove("/repo/w", { agent_id: "a1" }), undefined, { signal })).toEqual({});
  port.fail = "nope";
  expect(await hook?.(remove("/repo/w"), undefined, { signal })).toEqual({});
  expect(calls).toEqual([
    "leave id1 /repo/.agents/worktree/cycle-x helper=false",
    "leave id1 /repo/w helper=true",
    "leave id1 /repo/w helper=false",
  ]);
  expect(logged).toEqual(["WorktreeRemove: nope"]);
});

test("a harness with no port registers nothing, and one with it declares what the agent may do", async () => {
  const without = await setup(false);
  expect(without.sdk.last.options).not.toHaveProperty("hooks");
  expect(declares(without.harness.declaration, "worktree.enter")).toBe(false);
  const given = await setup();
  expect(declares(given.harness.declaration, "worktree.enter")).toBe(true);
  expect(Object.keys(given.hooks)).toEqual(["WorktreeCreate", "WorktreeRemove"]);
  // Claude Code's own tools stay on machine: the hooks answer them.
  expect(given.query.options.disallowedTools).toBeUndefined();
});

test("a session in a sandbox gets no hooks even with the port, and may not use the built-in tools", async () => {
  const sbx = fakeSbx();
  const sdk = new FakeSdk();
  const harness = new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
    bin: "/opt/claude",
    sandboxes: sbx.sandboxes,
    files: { move: async () => true },
    worktrees: fakePort().port,
    schedule: () => () => {},
    now: () => 1000,
    newId: () => "id1",
  });
  const session = await harness.createSession({
    cwd: "/Users/me/app",
    environment: "standard",
    ...options,
  });
  await harness.send(session.id, prompt("hello"), { ...options, environment: "standard" });
  await settle();
  expect(sdk.last.options).not.toHaveProperty("hooks");
  expect(sdk.last.options.disallowedTools).toEqual(["EnterWorktree", "ExitWorktree"]);
  // Its folder is the sandbox's, which says nothing of this machine's.
  const events: HarnessEvent[] = [];
  harness.onEvent((event) => events.push(event));
  sdk.last.say(init("/home/agent/workspace/app"));
  await settle();
  expect(events).toEqual([]);
});

test("each turn's init says where the agent is, and the session is told when that changes", async () => {
  const { query, events } = await setup();
  events.length = 0;
  const told = () => events.splice(0).filter((event) => event.type === "session.changed");
  query.say(init("/project"));
  await settle();
  // The first is told whatever it is: a process that starts again says where it began.
  expect(told()).toEqual([
    { type: "session.changed", sessionId: "id1", patch: { workingDir: "/project" } },
  ]);
  query.say(init("/project"));
  await settle();
  expect(told()).toEqual([]);
  query.say(init("/repo/.agents/worktree/cycle-x"));
  await settle();
  expect(told()).toEqual([
    {
      type: "session.changed",
      sessionId: "id1",
      patch: { workingDir: "/repo/.agents/worktree/cycle-x" },
    },
  ]);
  query.say(init("/project"));
  await settle();
  expect(told()).toMatchObject([{ patch: { workingDir: "/project" } }]);
});

test("a command run after the agent entered a worktree shows the worktree's folder, and its own again after leaving", async () => {
  const { hooks, query, events } = await setup();
  const shown = () =>
    events
      .splice(0)
      .flatMap((event) =>
        event.type === "item.started" && event.item.kind === "command" ? [event.item.cwd] : [],
      );
  events.length = 0;
  query.say(call("t1"));
  await settle();
  expect(shown()).toEqual(["/project"]);
  await hooks.WorktreeCreate?.[0]?.hooks[0]?.(create("x"), undefined, { signal });
  query.say(call("t2"));
  await settle();
  expect(shown()).toEqual(["/repo/.agents/worktree/cycle-x"]);
  await hooks.WorktreeRemove?.[0]?.hooks[0]?.(remove("/repo/.agents/worktree/cycle-x"), undefined, {
    signal,
  });
  query.say(call("t3"));
  await settle();
  expect(shown()).toEqual(["/project"]);
});

test("a helper's worktree leaves the session's own folder where it was", async () => {
  const { hooks, query, events } = await setup();
  await hooks.WorktreeCreate?.[0]?.hooks[0]?.(create("agent-a7133ce6ec288d86b"), undefined, {
    signal,
  });
  events.length = 0;
  query.say({
    type: "assistant",
    uuid: "a1",
    message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
  });
  await settle();
  expect(events).toMatchObject([{ type: "item.started", item: { cwd: "/project" } }]);
});

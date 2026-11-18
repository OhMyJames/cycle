/**
 * What happens when Claude Code's agent enters a worktree: the real Claude Code, driven by the
 * Claude Agent SDK against a scripted model, in a scratch repository, with `Git` as the port's
 * maker. No daemon: the harness is driven direct. Each result of the 2026-11-18 experiments that
 * a decision rests on is a case here, so a Claude Code that answers otherwise fails them.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Rig,
  SONNET,
  begin,
  enters,
  leaves,
  makeRig,
  modelSaw,
  portOf,
  runs,
  scripted,
  turn,
  workingDirs,
} from "./claude-worktree-rig.ts";

let rig: Rig | null = null;
afterEach(() => {
  rig?.stop();
  rig = null;
});

const folderOf = (repo: string, name: string) => join(repo, ".agents", "worktree", name);

test("with no port, Claude Code makes its own worktree under .claude, on its own branch, locked", async () => {
  rig = makeRig();
  rig.script = scripted({ enter: [enters("own")] });
  const harness = rig.harness();
  const session = await begin(rig, harness, rig.repo);
  await turn(harness, session.id, "enter");
  const folder = join(rig.repo, ".claude", "worktrees", "own");
  expect(existsSync(folder)).toBe(true);
  expect(rig.git("branch", "--list", "worktree-own")).toContain("worktree-own");
  const listed = rig.git("worktree", "list", "--porcelain");
  expect(listed).toContain(`worktree ${folder}`);
  expect(listed).toContain("locked");
  expect(modelSaw(rig)).toContain("Created worktree at");
  await harness.dispose();
});

test("with the port, the worktree is Cycle's: under .agents, on cycle/<name>, unlocked, and none is made under .claude", async () => {
  rig = makeRig();
  const { port, calls } = portOf(rig.sessions);
  rig.script = scripted({ enter: [enters("fix-it"), runs("pwd")] });
  const harness = rig.harness({ worktrees: port });
  const session = await begin(rig, harness, rig.repo);
  const events = await turn(harness, session.id, "enter");
  const folder = folderOf(rig.repo, "cycle-fix-it");
  expect(calls).toEqual(["enter fix-it helper=false"]);
  expect(existsSync(folder)).toBe(true);
  expect(rig.git("branch", "--list", "cycle/fix-it")).toContain("cycle/fix-it");
  const listed = rig.git("worktree", "list", "--porcelain");
  expect(listed).toContain(`worktree ${folder}`);
  expect(listed).not.toContain("locked");
  expect(existsSync(join(rig.repo, ".claude", "worktrees"))).toBe(false);
  // The folder ignores itself: the repository stays clean.
  expect(rig.git("status", "--porcelain")).toBe("");
  const saw = modelSaw(rig);
  expect(saw).toContain(`Created worktree at`);
  // The agent's own command ran there.
  expect(saw).toContain(JSON.stringify(folder));
  // The command was shown in the worktree's folder, not the project's.
  const shown = events.flatMap((event) =>
    event.type === "item.started" && event.item.kind === "command" ? [event.item.cwd] : [],
  );
  expect(shown).toEqual([folder]);
  await harness.dispose();
});

test("a process begun again, from the project's folder, starts in the worktree and says so; once left, it says the project's", async () => {
  rig = makeRig();
  const { port } = portOf(rig.sessions);
  const folder = folderOf(rig.repo, "cycle-x");
  rig.script = scripted({
    enter: [enters("x")],
    where: [runs("pwd")],
    leave: [leaves("keep")],
  });
  const first = rig.harness({ worktrees: port });
  const session = await begin(rig, first, rig.repo);
  // The first turn begins in the project's folder: the agent has not entered yet.
  expect(workingDirs(await turn(first, session.id, "enter"))).toEqual([rig.repo]);
  await first.dispose();
  // Claude Code remembers where it was: its store is by the project's folder, and it begins there.
  const second = rig.harness({ worktrees: port });
  expect(workingDirs(await turn(second, session.id, "where"))).toEqual([folder]);
  expect(modelSaw(rig)).toContain(JSON.stringify(folder));
  // Leaving with `keep` calls no hook: the next turn of the same process says it.
  expect(workingDirs(await turn(second, session.id, "leave"))).toEqual([]);
  expect(workingDirs(await turn(second, session.id, "where"))).toEqual([rig.repo]);
  await second.dispose();
  const third = rig.harness({ worktrees: port });
  expect(workingDirs(await turn(third, session.id, "where"))).toEqual([rig.repo]);
  // Nothing was removed.
  expect(existsSync(folder)).toBe(true);
  await third.dispose();
});

test("a refusal is carried to the model as the path that does not exist, and the agent goes on", async () => {
  rig = makeRig();
  const why = "This session already works in a worktree.";
  const { port, calls } = portOf(rig.sessions, { nope: why });
  rig.script = scripted({
    enter: [enters("nope"), enters("a..b"), enters("fine"), runs("pwd")],
  });
  const harness = rig.harness({ worktrees: port });
  const session = await begin(rig, harness, rig.repo);
  await turn(harness, session.id, "enter");
  const saw = modelSaw(rig);
  // Claude Code carries a hook's words nowhere else (tried: throw, continue, decision, onFailure).
  expect(saw).toContain(`Path \\"/${why}\\" does not exist`);
  expect(saw).toContain(
    `Path \\"/A worktree's name is letters, digits, dots, dashes and slashes, 64 at most.\\" does not exist`,
  );
  // A name that is no branch's never reaches the port; the one after the refusals is made.
  expect(calls).toEqual(["enter nope helper=false", "enter fine helper=false"]);
  expect(existsSync(join(rig.repo, ".claude", "worktrees"))).toBe(false);
  const listed = rig.git("worktree", "list", "--porcelain");
  expect(listed).toContain(`worktree ${folderOf(rig.repo, "cycle-fine")}`);
  expect(listed).not.toContain("nope");
  expect(saw).toContain(JSON.stringify(folderOf(rig.repo, "cycle-fine")));
  await harness.dispose();
});

test("a second EnterWorktree is refused by Claude Code itself, before any hook", async () => {
  rig = makeRig();
  const { port, calls } = portOf(rig.sessions);
  rig.script = scripted({ enter: [enters("one"), enters("two")] });
  const harness = rig.harness({ worktrees: port });
  const session = await begin(rig, harness, rig.repo);
  await turn(harness, session.id, "enter");
  expect(calls).toEqual(["enter one helper=false"]);
  expect(modelSaw(rig)).toContain("Already in a worktree session");
  await harness.dispose();
});

test("a helper agent's isolated worktree goes through the port as a helper's, and the session's folder stays", async () => {
  rig = makeRig();
  const { port, calls } = portOf(rig.sessions);
  rig.script = scripted({
    helper: [
      {
        call: {
          name: "Agent",
          input: {
            description: "isolated helper",
            prompt: "subtask",
            subagent_type: "general-purpose",
            isolation: "worktree",
          },
        },
      },
    ],
    subtask: [runs("pwd")],
  });
  const harness = rig.harness({ worktrees: port });
  const session = await begin(rig, harness, rig.repo);
  const events = await turn(harness, session.id, "helper");
  // Claude Code names it `agent-<the helper's id>` and gives the hook no `agent_id`.
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatch(/^enter agent-[0-9a-f]+ helper=true$/);
  expect(workingDirs(events)).toEqual([rig.repo]);
  await harness.dispose();
});

test("the model can enter a worktree of the owner's by its path, which asks the port nothing", async () => {
  rig = makeRig();
  const { port, calls } = portOf(rig.sessions);
  const path = folderOf(rig.repo, "mine");
  rig.git("worktree", "add", "--no-track", "-b", "mine", path, "HEAD");
  rig.script = scripted({ enter: [{ call: { name: "EnterWorktree", input: { path } } }] });
  const harness = rig.harness({ worktrees: port });
  const session = await begin(rig, harness, rig.repo);
  await turn(harness, session.id, "enter");
  expect(calls).toEqual([]);
  expect(modelSaw(rig)).toContain("Entered worktree at");
  await harness.dispose();
});

test("the agent's edits in the main checkout are not blocked by its being in a session of Cycle's", async () => {
  rig = makeRig();
  const { port } = portOf(rig.sessions);
  const file = join(rig.repo, "a.txt");
  rig.script = scripted({
    edit: [
      {
        call: { name: "Write", input: { file_path: join(rig.repo, "new.txt"), content: "new\n" } },
      },
      { call: { name: "Edit", input: { file_path: file, old_string: "hi", new_string: "ho" } } },
    ],
  });
  const harness = rig.harness({ worktrees: port });
  const session = await begin(rig, harness, rig.repo);
  await turn(harness, session.id, "edit");
  expect(await Bun.file(file).text()).toBe("ho\n");
  expect(await Bun.file(join(rig.repo, "new.txt")).text()).toBe("new\n");
  await harness.dispose();
});

test("the history of a session that entered a worktree is read from the project's folder, and the model is kept", async () => {
  rig = makeRig();
  const { port } = portOf(rig.sessions);
  rig.script = scripted({ enter: [enters("hist")], more: [runs("echo edit > e.txt && pwd")] });
  const first = rig.harness({ worktrees: port });
  const session = await begin(rig, first, rig.repo);
  await turn(first, session.id, "enter");
  await turn(first, session.id, "more");
  await first.dispose();
  const folder = folderOf(rig.repo, "cycle-hist");
  expect(await Bun.file(join(folder, "e.txt")).exists()).toBe(true);
  // A daemon that starts later finds it by the project's folder, with both turns.
  const later = rig.harness({ worktrees: port });
  const found = await later.loadSession(session.id, { model: SONNET });
  expect(found.session.cwd).toBe(rig.repo);
  expect(found.turns).toHaveLength(2);
  expect((await later.listSessions({ archived: false })).map((each) => each.cwd)).toEqual([
    rig.repo,
  ]);
  await later.dispose();
});

test("a project that is a subfolder gets the worktree's root, not the same subfolder inside it", async () => {
  rig = makeRig();
  const { port, calls } = portOf(rig.sessions);
  const pkg = join(rig.repo, "pkg");
  rig.script = scripted({ enter: [enters("sub")], where: [runs("pwd")] });
  const first = rig.harness({ worktrees: port });
  const session = await begin(rig, first, pkg);
  await turn(first, session.id, "enter");
  await first.dispose();
  const root = folderOf(rig.repo, "cycle-sub");
  expect(calls).toEqual(["enter sub helper=false"]);
  const second = rig.harness({ worktrees: port });
  expect(workingDirs(await turn(second, session.id, "where"))).toEqual([root]);
  await second.dispose();
});

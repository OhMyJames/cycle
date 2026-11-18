/**
 * How a worktree the agent entered ends and is seen: a removal asked of Claude Code reaches the
 * port and removes nothing, and the page's file search leaves the worktree out. The real Claude
 * Code, driven by the Claude Agent SDK against a scripted model, in a scratch repository.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexHarness } from "@cycle/harness-codex";
import { Files } from "../../src/index.ts";
import {
  type Rig,
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
import { startMockModel } from "./mock-model.ts";

let rig: Rig | null = null;
afterEach(() => {
  rig?.stop();
  rig = null;
});

const folderOf = (repo: string, name: string) => join(repo, ".agents", "worktree", name);

test("a removal the agent asks for reaches the port, which removes nothing, and the agent is back in its folder", async () => {
  rig = makeRig();
  const { port, calls } = portOf(rig.sessions);
  const folder = folderOf(rig.repo, "cycle-gone");
  rig.script = scripted({
    leave: [enters("gone"), leaves("remove"), leaves("remove", true), runs("pwd")],
    where: [runs("pwd")],
  });
  const first = rig.harness({ worktrees: port });
  const session = await begin(rig, first, rig.repo);
  const events = await turn(first, session.id, "leave");
  // Claude Code asks first for the owner's word that its changes may go, since it cannot read a
  // worktree it did not make; only the second asks the hook, with the worktree's root.
  expect(calls).toEqual(["enter gone helper=false", `leave ${folder} helper=false`]);
  const saw = modelSaw(rig);
  expect(saw).toContain("Could not verify worktree state");
  // Claude Code tells its model it was removed, whatever the hook did.
  expect(saw).toContain("Exited and removed worktree");
  expect(existsSync(folder)).toBe(true);
  expect(rig.git("branch", "--list", "cycle/gone")).toContain("cycle/gone");
  // The command after it ran in the project's folder, and was shown there.
  const shown = events.flatMap((event) =>
    event.type === "item.started" && event.item.kind === "command" ? [event.item.cwd] : [],
  );
  expect(shown.at(-1)).toBe(rig.repo);
  await first.dispose();
  // A process begun again starts in the project's folder.
  const second = rig.harness({ worktrees: port });
  expect(workingDirs(await turn(second, session.id, "where"))).toEqual([rig.repo]);
  await second.dispose();
});

test("a session that entered a worktree begun again with its folder gone starts in the project, with no error", async () => {
  rig = makeRig();
  const { port } = portOf(rig.sessions);
  rig.script = scripted({ enter: [enters("lost")], where: [runs("pwd")] });
  const first = rig.harness({ worktrees: port });
  const session = await begin(rig, first, rig.repo);
  await turn(first, session.id, "enter");
  await first.dispose();
  const folder = folderOf(rig.repo, "cycle-lost");
  rig.git("worktree", "remove", "--force", folder);
  const second = rig.harness({ worktrees: port });
  expect(workingDirs(await turn(second, session.id, "where"))).toEqual([rig.repo]);
  await second.dispose();
});

test("a file in an entered worktree is not found from the project's root, and is from the worktree's", async () => {
  rig = makeRig();
  const { port } = portOf(rig.sessions);
  rig.script = scripted({ enter: [enters("seen")] });
  const harness = rig.harness({ worktrees: port });
  const session = await begin(rig, harness, rig.repo);
  await turn(harness, session.id, "enter");
  await harness.dispose();
  const folder = folderOf(rig.repo, "cycle-seen");
  writeFileSync(join(folder, "only-in-the-worktree.txt"), "x\n");
  mkdirSync(join(rig.repo, "docs"));
  writeFileSync(join(rig.repo, "docs", "only-in-the-checkout.txt"), "x\n");
  // codex is the machine the page's search runs on.
  const model = startMockModel(() => ({ text: ["ok"] }));
  mkdirSync(join(rig.root, "codex"));
  const codex = new CodexHarness({
    config: model.codexConfig,
    env: { CODEX_HOME: join(rig.root, "codex") },
  });
  try {
    await codex.start();
    const files = new Files(codex, () => [rig?.repo ?? ""]);
    expect(await files.search(rig.repo, "only-in-the")).toEqual([
      { path: "docs/only-in-the-checkout.txt", directory: false },
    ]);
    expect((await files.search(folder, "only-in-the-worktree")).map((match) => match.path)).toEqual(
      ["only-in-the-worktree.txt"],
    );
  } finally {
    await codex.dispose();
    model.stop();
  }
});

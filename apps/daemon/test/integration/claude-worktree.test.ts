/**
 * What happens when Claude Code's agent enters a worktree: the real Claude Code, driven by the
 * Claude Agent SDK against a scripted model, in a scratch repository. No daemon: the harness is
 * driven direct.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Rig,
  begin,
  enters,
  makeRig,
  scripted,
  toolResults,
  turn,
} from "./claude-worktree-rig.ts";

let rig: Rig;

beforeAll(() => {
  rig = makeRig();
});
afterAll(() => rig.stop());

test("with no port, Claude Code makes its own worktree under .claude, on its own branch, locked", async () => {
  rig.script = scripted({ enter: [enters("own")] });
  const harness = rig.harness();
  const session = await begin(harness, rig.repo);
  await turn(harness, session.id, "enter");
  const folder = join(rig.repo, ".claude", "worktrees", "own");
  expect(existsSync(folder)).toBe(true);
  expect(rig.git("branch", "--list", "worktree-own")).toContain("worktree-own");
  const listed = rig.git("worktree", "list", "--porcelain");
  expect(listed).toContain(`worktree ${folder}`);
  expect(listed).toContain("locked");
  expect(toolResults(rig.claude.requests).join("\n")).toContain("Created worktree at");
  await harness.dispose();
});

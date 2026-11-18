import { expect, test } from "bun:test";
import { heldGit, settle, type World } from "./held-git.ts";

/** Makes one worktree in a world, and answers with what it made and what was run. */
async function makeIn(world: World, cwd: string) {
  const held = heldGit(world);
  const made = held.git.addWorktree({ cwd, branch: "x" });
  const settled = made.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await settle();
  held.releases[0]?.();
  return { ...held, result: await settled };
}

test("an ordinary repository gets its worktree in its own .agents/worktree", async () => {
  const { result } = await makeIn({}, "/repo");
  expect(result).toMatchObject({
    value: { worktree: { repo: "/repo", path: "/repo/.agents/worktree/x" } },
  });
});

test("a worktree made from inside another goes to the main checkout, not into the linked one", async () => {
  const linked = "/repo/.agents/worktree/one";
  const { result } = await makeIn({ roots: { [linked]: linked } }, linked);
  expect(result).toMatchObject({
    value: { worktree: { repo: "/repo", path: "/repo/.agents/worktree/x" } },
  });
});

test("a submodule, whose common dir is not named .git, gets it in its own root", async () => {
  const world = {
    roots: { "/super/sub": "/super/sub" },
    commons: { "/super/sub": "/super/.git/modules/sub" },
  };
  const { result } = await makeIn(world, "/super/sub");
  expect(result).toMatchObject({
    value: { worktree: { repo: "/super/sub", path: "/super/sub/.agents/worktree/x" } },
  });
});

test("a repository with its git dir elsewhere gets it in the folder's root", async () => {
  const world = {
    roots: { "/proj/pkg": "/proj" },
    commons: { "/proj": "/elsewhere/proj.git" },
  };
  const { result, adds } = await makeIn(world, "/proj/pkg");
  expect(result).toMatchObject({
    value: {
      cwd: "/proj/.agents/worktree/x/pkg",
      worktree: { repo: "/proj", path: "/proj/.agents/worktree/x" },
    },
  });
  expect(adds()[0]).toContain(" /proj/.agents/worktree/x ");
});

test("a git too old to say its common dir falls back to the folder's root", async () => {
  const { result } = await makeIn({ old: true }, "/repo");
  expect(result).toMatchObject({ value: { worktree: { path: "/repo/.agents/worktree/x" } } });
});

test("a bare repository is refused as having no checkout, and nothing is run in it", async () => {
  const { result, adds, runs } = await makeIn({ bare: new Set(["/bare.git"]) }, "/bare.git");
  expect(result).toMatchObject({ error: { message: "A worktree needs a git checkout." } });
  expect(adds()).toEqual([]);
  expect(runs.some((run) => run.key.startsWith("sh "))).toBe(false);
});

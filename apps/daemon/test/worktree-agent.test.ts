import { expect, test } from "bun:test";
import { type Placement, isWithin, placeOf, worktreeNameProblem } from "../src/worktree-agent.ts";
import { WorktreeDesk } from "../src/worktree-desk.ts";

test("names a model may give are letters, digits, dots, dashes and slashes, kept clear of what git or a folder reads", () => {
  for (const name of ["x", "fix-bug", "a/b", "v1.2", "feature/v1.2_x", "A9"]) {
    expect({ name, problem: worktreeNameProblem(name) }).toEqual({ name, problem: null });
  }
  for (const name of ["x".repeat(64), "a.b", "a/b/c/d"]) {
    expect(worktreeNameProblem(name)).toBeNull();
  }
});

test("a hostile name has a reason of its own, in words the model reads", () => {
  const reasons: [string, string][] = [
    ["", "letters, digits"],
    ["x".repeat(65), "64 at most"],
    ["a b", "letters, digits"],
    ["é", "letters, digits"],
    ["a\nb", "letters, digits"],
    ["-x", "begin with a dash"],
    ["--force", "begin with a dash"],
    ["a//b", "no empty part"],
    ["a/", "no empty part"],
    ["/a", "no empty part"],
    [".x", "begins with a dot"],
    ["a/.b", "begins with a dot"],
    ["..", "begins with a dot"],
    ["../x", "begins with a dot"],
    ["x.lock", "in .lock"],
    ["a/x.lock/b", "in .lock"],
    ["a.", "in .lock"],
    ["a..b", "two dots"],
  ];
  for (const [name, reason] of reasons) {
    expect({ name, problem: worktreeNameProblem(name) }).toEqual({
      name,
      problem: expect.stringContaining(reason),
    });
  }
});

test("a folder is within another by whole parts", () => {
  expect(isWithin("/a/b", "/a/b")).toBe(true);
  expect(isWithin("/a/b/c", "/a/b")).toBe(true);
  expect(isWithin("/a/bc", "/a/b")).toBe(false);
  expect(isWithin("/a", "/a/b")).toBe(false);
  expect(isWithin("/a/b", "/")).toBe(true);
});

const own: Placement = { path: "/r/.agents/worktree/cycle-x", repo: "/r", cwd: "/r/pkg" };

test("the agent in its worktree is in; back in its folder or below it is left", () => {
  expect(placeOf("/r/.agents/worktree/cycle-x", own)).toBe("in");
  expect(placeOf("/r/.agents/worktree/cycle-x/pkg/deep", own)).toBe("in");
  expect(placeOf("/r/pkg", own)).toBe("left");
  expect(placeOf("/r/pkg/src", own)).toBe("left");
});

test("every worktree is inside its repository, so being under the project proves nothing of one", () => {
  const atRoot: Placement = { ...own, cwd: "/r" };
  expect(placeOf("/r", atRoot)).toBe("left");
  expect(placeOf("/r/src", atRoot)).toBe("left");
  expect(placeOf("/r/.agents/worktree/cycle-y", atRoot)).toBe("elsewhere");
  expect(placeOf("/r/.claude/worktrees/z", atRoot)).toBe("elsewhere");
  expect(placeOf("/r/.claude/worktrees", atRoot)).toBe("elsewhere");
  expect(placeOf("/r/.agents/worktree/cycle-x-2", atRoot)).toBe("elsewhere");
});

test("a folder that is neither is elsewhere, as one a hook of the owner's makes", () => {
  expect(placeOf("/other/place", own)).toBe("elsewhere");
  expect(placeOf("/r", own)).toBe("elsewhere");
  expect(placeOf("/rx", own)).toBe("elsewhere");
});

test("the desk refuses until the daemon serves it, and then forwards what is asked", async () => {
  const desk = new WorktreeDesk();
  const request = { sessionId: "s1", name: "x", helper: false };
  await expect(desk.enter(request)).rejects.toThrow("Cycle is not ready to make worktrees.");
  // Leaving before there is a hub removes nothing and asks nothing of anyone.
  await desk.leave({ sessionId: "s1", path: "/p", helper: false });
  const seen: unknown[] = [];
  desk.serve({
    enter: async (asked) => {
      seen.push(["enter", asked]);
      return { path: "/made" };
    },
    leave: async (asked) => {
      seen.push(["leave", asked]);
    },
  });
  expect(await desk.enter(request)).toEqual({ path: "/made" });
  await desk.leave({ sessionId: "s1", path: "/p", helper: true });
  expect(seen).toEqual([
    ["enter", request],
    ["leave", { sessionId: "s1", path: "/p", helper: true }],
  ]);
});

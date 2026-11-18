import { expect, test } from "bun:test";
import { LEGACY, MADE, MAIN, listing, record, repo, user } from "./worktree-repo.ts";

const main = record(MAIN, { branch: "main" });

test("the main checkout and a bare record are not listed, and the answer names the main checkout", async () => {
  const { worktrees } = repo({
    porcelain: listing(
      main,
      record("/repo.git", { bare: true }),
      record(`${MADE}/a`, { branch: "a" }),
    ),
  });
  // Asked from inside a linked worktree, it is the same repository.
  const answer = await worktrees.list(`${MADE}/a`);
  expect(answer.workspace).toBe(MAIN);
  expect(answer.worktrees.map((entry) => entry.path)).toEqual([`${MADE}/a`]);
});

test("worktrees under the new place and the old are managed, and the rest are not", async () => {
  const outside = [
    "/repo/.claude/worktrees/entered",
    "/elsewhere",
    `${MAIN}/.agents/worktree-x/sibling`,
    `${MAIN}/.agents/worktree`,
    `${MADE}/../../out`,
    `${MADE}/a/../../out`,
    `${LEGACY}`,
    `${LEGACY}-other/x`,
  ];
  const { worktrees } = repo({
    porcelain: listing(
      main,
      record(`${MADE}/new`, { branch: "new" }),
      record(`${LEGACY}/repo/old`, { branch: "old" }),
      ...outside.map((path) => record(path, { branch: "x" })),
    ),
  });
  const { worktrees: entries } = await worktrees.list(MAIN);
  expect(entries.filter((entry) => entry.managed).map((entry) => entry.path)).toEqual([
    `${LEGACY}/repo/old`,
    `${MADE}/new`,
  ]);
  expect(
    entries
      .filter((entry) => !entry.managed)
      .map((entry) => entry.path)
      .toSorted(),
  ).toEqual(outside.toSorted());
});

test("managed ones come first, then by path", async () => {
  const { worktrees } = repo({
    porcelain: listing(
      main,
      record("/b-by-hand"),
      record(`${MADE}/z`, { branch: "z" }),
      record("/a-by-hand"),
      record(`${MADE}/b`, { branch: "b" }),
    ),
  });
  expect((await worktrees.list(MAIN)).worktrees.map((entry) => entry.path)).toEqual([
    `${MADE}/b`,
    `${MADE}/z`,
    "/a-by-hand",
    "/b-by-hand",
  ]);
});

test("an entry says its branch, head, lock, and a detached head has no branch", async () => {
  const { worktrees } = repo({
    porcelain: listing(
      main,
      record(`${MADE}/a`, { branch: "feature/a", locked: "on a drive" }),
      record(`${MADE}/b`),
    ),
  });
  const [a, b] = (await worktrees.list(MAIN)).worktrees;
  expect(a).toMatchObject({ branch: "feature/a", head: "abc1234", locked: true });
  expect(b).toMatchObject({ branch: null, locked: false });
});

test("dirty is told by status, null when git cannot, and a missing folder is not asked", async () => {
  const { worktrees, runs } = repo({
    porcelain: listing(
      main,
      record(`${MADE}/clean`, { branch: "clean" }),
      record(`${MADE}/dirty`, { branch: "dirty" }),
      record(`${MADE}/gone`, { branch: "gone" }),
    ),
    gone: [`${MADE}/gone`],
    status: { [`${MADE}/dirty`]: "?? new.txt\n" },
  });
  const entries = (await worktrees.list(MAIN)).worktrees;
  expect(
    entries.map((entry) => [entry.path.split("/").at(-1), entry.missing, entry.dirty]),
  ).toEqual([
    ["clean", false, false],
    ["dirty", false, true],
    ["gone", true, null],
  ]);
  expect(runs.filter((run) => run.key === "status --porcelain").map((run) => run.cwd)).toEqual([
    `${MADE}/clean`,
    `${MADE}/dirty`,
  ]);
});

test("the sessions that use a worktree are listed with the first record's base and origin", async () => {
  const path = `${MADE}/a`;
  const { worktrees } = repo({
    porcelain: listing(main, record(path, { branch: "a" }), record(`${MADE}/b`, { branch: "b" })),
    users: {
      [path]: [
        user("s1", { title: "Fix it", preview: "p", base: "base1", origin: "agent" }),
        user("s2", { archived: true, activity: "running", base: "base2" }),
        user("s3", { named: false, base: null, origin: null }),
      ],
    },
  });
  const [a, b] = (await worktrees.list(MAIN)).worktrees;
  expect(a?.sessions).toEqual([
    { id: "s1", title: "Fix it", preview: "p", activity: "idle", archived: false },
    { id: "s2", title: null, preview: "", activity: "running", archived: true },
    { id: "s3", title: null, preview: "", activity: "idle", archived: false },
  ]);
  expect(a).toMatchObject({ base: "base1", origin: "agent" });
  expect(b).toMatchObject({ base: null, origin: null, sessions: [] });
});

test("a folder in no repository, and a bare repository, are told apart", async () => {
  const none = repo({ porcelain: "" });
  await expect(none.worktrees.list("/nowhere")).rejects.toThrow(
    "A worktree needs a git repository.",
  );
  const bare = repo({ porcelain: listing(record("/repo.git", { bare: true })) });
  await expect(bare.worktrees.list("/repo.git")).rejects.toThrow(
    "A worktree needs a git checkout.",
  );
});

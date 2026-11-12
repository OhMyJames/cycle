import { expect, test } from "bun:test";
import { Git, branchSlug, parseBranches, parseNameStatus, parseNumstat } from "../src/index.ts";
import { FakeHarness } from "./fake-harness.ts";

test("numstat gives counts per path, with a rename's old name", () => {
  const out = "3\t1\tsrc/a.ts\0-\t-\tlogo.png\x000\t0\t\0old name.ts\0new name.ts\0";
  expect([...parseNumstat(out)]).toEqual([
    ["src/a.ts", { additions: 3, deletions: 1, binary: false, oldPath: null }],
    ["logo.png", { additions: 0, deletions: 0, binary: true, oldPath: null }],
    ["new name.ts", { additions: 0, deletions: 0, binary: false, oldPath: "old name.ts" }],
  ]);
});

test("name-status gives the kind of change per path", () => {
  const out = "M\0a.ts\0A\0b.ts\0D\0c.ts\0R100\0old.ts\0new.ts\0T\0link\0";
  expect([...parseNameStatus(out)]).toEqual([
    ["a.ts", "M"],
    ["b.ts", "A"],
    ["c.ts", "D"],
    ["new.ts", "R"],
    ["link", "M"],
  ]);
});

test("branches are split into local and remote, without a remote's HEAD", () => {
  const out =
    "refs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\nrefs/heads/fix/x\n";
  expect(parseBranches(out)).toEqual({ local: ["main", "fix/x"], remote: ["origin/main"] });
});

test.each([
  ["feature/login form", "feature-login-form"],
  ["--x--", "x"],
  ["///", "worktree"],
])("a branch %p is the folder %p", (branch, slug) => {
  expect(branchSlug(branch)).toBe(slug);
});

function gitWith(results: FakeHarness["execResults"]) {
  const harness = new FakeHarness();
  harness.execResults = results;
  return { harness, git: new Git((argv, options) => harness.exec(argv, options)) };
}

test("a folder outside any repository has no status", async () => {
  const { git } = gitWith({ "rev-parse --show-toplevel": { exitCode: 128, stdout: "" } });
  expect(await git.status("/tmp/x")).toEqual({ repo: null, files: [], truncated: false });
});

test("status joins tracked changes with new files, read against the worktree's base", async () => {
  const diff = "diff --no-ext-diff --no-textconv -M -z";
  const { git, harness } = gitWith({
    "rev-parse --show-toplevel": { exitCode: 0, stdout: "/repo\n" },
    "symbolic-ref --short -q HEAD": { exitCode: 0, stdout: "feature\n" },
    "rev-parse -q --verify HEAD": { exitCode: 0, stdout: "head1\n" },
    "merge-base base0 HEAD": { exitCode: 0, stdout: "fork0\n" },
    [`${diff} --numstat fork0`]: { exitCode: 0, stdout: "2\t1\tb.ts\0" },
    [`${diff} --name-status fork0`]: { exitCode: 0, stdout: "M\0b.ts\0" },
    "ls-files --others --exclude-standard -z": { exitCode: 0, stdout: "a.txt\0" },
    "diff --no-index --numstat -z -- /dev/null a.txt": {
      exitCode: 1,
      stdout: "4\t0\t/dev/null\0a.txt\0",
    },
  });
  const status = await git.status("/repo/sub", "base0");
  expect(status.repo).toEqual({ root: "/repo", branch: "feature", head: "head1", from: "fork0" });
  expect(status.files).toEqual([
    { path: "a.txt", oldPath: null, status: "U", additions: 4, deletions: 0, binary: false },
    { path: "b.ts", oldPath: null, status: "M", additions: 2, deletions: 1, binary: false },
  ]);
  expect(harness.calls).toContain("git merge-base base0 HEAD");
});

test("a new file's diff is read against nothing, and a failure says what git said", async () => {
  const { git } = gitWith({
    "rev-parse --show-toplevel": { exitCode: 0, stdout: "/repo\n" },
    "diff --no-color --no-ext-diff --no-index -- /dev/null a.txt": {
      exitCode: 1,
      stdout: "+new\n",
    },
    "switch --no-guess gone": {
      exitCode: 1,
      stdout: "",
      stderr: "fatal: invalid reference: gone\n",
    },
  });
  expect(await git.diff("/repo", "HEAD", "a.txt", "U")).toEqual({
    patch: "+new\n",
    truncated: false,
  });
  expect(git.checkout("/repo", "gone")).rejects.toThrow("invalid reference: gone");
});

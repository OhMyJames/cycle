import { expect, test } from "bun:test";
import { answerFor, decide, splitCommand } from "../src/policy.ts";

const W = "/repo/.agents/worktree/auto/cyc-1";
type Ctx = { role: "dev" | "qa" | "review"; worktree: string };
const dev: Ctx = { role: "dev", worktree: W };
const qa: Ctx = { role: "qa", worktree: W };
const review: Ctx = { role: "review", worktree: W };

const request = (toolCall: Record<string, unknown>) => ({
  sessionId: "s",
  title: "t",
  subject: { type: "tool_call", toolCall },
  options: [
    { optionId: "a", kind: "allow_once", name: "Allow" },
    { optionId: "r", kind: "reject_once", name: "Reject" },
  ],
});
const run = (command: string) => request({ kind: "execute", rawInput: { command } });
const edit = (...paths: string[]) =>
  request({ kind: "edit", locations: paths.map((path) => ({ path })) });
const read = (path: string) => request({ kind: "read", locations: [{ path }] });
const d = (req: Record<string, unknown>, ctx = dev) => decide(req, ctx).decision;

test("splits simple commands and refuses shell syntax it does not read", () => {
  expect(splitCommand("git status && bun run check; ls | head")).toEqual([
    ["git", "status"],
    ["bun", "run", "check"],
    ["ls"],
    ["head"],
  ]);
  expect(splitCommand("git commit -m 'a b; c'")).toEqual([["git", "commit", "-m", "a b; c"]]);
  for (const bad of [
    "echo $(id)",
    "echo `id`",
    "ls > f",
    "ls < f",
    "echo $HOME",
    "sleep 1 &",
    "a\nb",
    "echo 'x",
  ]) {
    expect(splitCommand(bad)).toBeUndefined();
  }
});

test("dev: reads in the worktree are allowed, reads outside are left to a person", () => {
  expect(d(read(`${W}/a.ts`))).toBe("allow");
  expect(d(read("src/a.ts"))).toBe("allow");
  expect(d(read("/Users/me/.ssh/id_rsa"))).toBe("ask");
  expect(d(read(`${W}/../../etc/passwd`))).toBe("ask");
});

test("dev: edits in the worktree are allowed; outside it or in .git they are not", () => {
  expect(d(edit(`${W}/a.ts`, `${W}/b/c.ts`))).toBe("allow");
  expect(d(edit(`${W}/a.ts`, "/tmp/x"))).toBe("ask");
  expect(d(edit(`${W}/.git/config`))).toBe("ask");
  expect(d(edit())).toBe("ask");
});

test("dev: allowlisted commands run; others wait for a person", () => {
  for (const ok of [
    "bun run check",
    "bun test tools/a.test.ts",
    "git status",
    "git diff origin/main...HEAD",
    "git add -A && git commit -m 'fix a'",
    "ls -la src | head",
    "bun install",
  ]) {
    expect(d(run(ok))).toBe("allow");
  }
  for (const ask of [
    "git push origin HEAD",
    "git reset --hard",
    "git branch -D x",
    "rm -rf node_modules",
    "curl https://example.com",
    "bun run build",
    "cat ~/.ssh/id_rsa",
    "cat /etc/passwd",
    "ls ../..",
    "bun run check && curl x",
    "echo $HOME",
  ]) {
    expect(d(run(ask))).toBe("ask");
  }
});

test("a request it cannot read is never allowed", () => {
  expect(d({ sessionId: "s", options: [] })).toBe("ask");
  expect(d(request({ kind: "execute" }))).toBe("ask");
  expect(d(request({ kind: "fetch", rawInput: { url: "https://x" } }))).toBe("ask");
  expect(d(request({}))).toBe("ask");
});

test("qa: reads and read-only commands are allowed; everything that writes is denied, not left waiting", () => {
  expect(d(read(`${W}/a.ts`), qa)).toBe("allow");
  expect(d(run("git diff origin/main...HEAD"), qa)).toBe("allow");
  expect(d(run("rg foo src"), qa)).toBe("allow");
  expect(d(edit(`${W}/a.ts`), qa)).toBe("deny");
  expect(d(request({ kind: "delete", locations: [{ path: `${W}/a.ts` }] }), qa)).toBe("deny");
  expect(d(run("git commit -am x"), qa)).toBe("deny");
  expect(d(run("bun run check"), qa)).toBe("deny");
  expect(d(run("rm -rf ."), qa)).toBe("deny");
  expect(d(request({ kind: "fetch" }), qa)).toBe("deny");
  expect(d(read("/etc/passwd"), qa)).toBe("deny");
});

test("the answer picks the matching option; a request left to a person has none", () => {
  const req = run("git status");
  expect(answerFor(req, decide(req, dev))).toEqual({ outcome: "selected", optionId: "a" });
  const denied = edit(`${W}/a.ts`);
  expect(answerFor(denied, decide(denied, qa))).toEqual({ outcome: "selected", optionId: "r" });
  const asked = run("rm -rf x");
  expect(answerFor(asked, decide(asked, dev))).toBeUndefined();
  // No reject option: refusing is cancelling. No allow option: it is left to a person.
  const bare = { ...denied, options: [] };
  expect(answerFor(bare, { decision: "deny", reason: "" })).toEqual({ outcome: "cancelled" });
  expect(answerFor(bare, { decision: "allow", reason: "" })).toBeUndefined();
});

test("commands that run another program or write a file are not read-only, whatever the path", () => {
  expect(d(run("rg --pre sh foo ."), qa)).toBe("deny");
  expect(d(run("git diff --output=/tmp/x"), qa)).toBe("deny");
  expect(d(run("git diff --ext-diff"), qa)).toBe("deny");
  expect(d(run("cat {/etc/passwd,x}"), qa)).toBe("deny");
  expect(d(run("rg --file=/etc/passwd x"), qa)).toBe("deny");
});

test("a read that names no path is not shown to be inside the worktree", () => {
  expect(d(request({ kind: "read", rawInput: { uri: "file:///etc/passwd" } }), qa)).toBe("deny");
  expect(d(request({ kind: "search", rawInput: { pattern: "/etc/*" } }))).toBe("ask");
});

test("review role is strictly read-only like QA", () => {
  expect(d(read(`${W}/REVIEW.md`), review)).toBe("allow");
  expect(d(run("git diff origin/main...HEAD"), review)).toBe("allow");
  expect(d(edit(`${W}/REVIEW.md`), review)).toBe("deny");
  expect(d(run("gh pr merge --auto --squash"), review)).toBe("deny");
  expect(d(run("git commit -am x"), review)).toBe("deny");
  expect(d(request({ kind: "fetch" }), review)).toBe("deny");
  expect(d(read("/etc/passwd"), review)).toBe("deny");
});

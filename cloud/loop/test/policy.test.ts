import { expect, test } from "bun:test";
import { answerFor, commandPrefix, decide, splitCommand } from "../src/policy.ts";

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
    "bun run format",
    "bun run lint",
    "bun run typecheck",
    "bun run test:browser",
    "bun run test:integration",
    "bun run test:integration web",
    "bun test",
    "bun test ./tools/a.test.ts",
    "bun test ./cloud/loop/test/policy.test.ts -t allowlisted",
    "git status",
    "git diff origin/main...HEAD",
    "git add -A && git commit -m 'fix a'",
    "git add src/a.ts src/b.ts && git commit -F msg.txt",
    "git branch --show-current",
    "ls -la src | head",
    "bun install",
    "bun install --frozen-lockfile",
  ]) {
    expect(d(run(ok))).toBe("allow");
  }
  for (const ask of [
    "git push origin HEAD",
    "git reset --hard",
    "git branch -D x",
    "git branch --show-current --no-show-current -D other",
    "git branch --show-current -f master HEAD",
    "git add -f .env",
    "git add -f src/a.ts",
    "git add .git/config",
    "git commit --template=/tmp/x -m hi",
    "git commit --template=./x -m hi",
    "git commit -F /etc/passwd",
    "git commit --no-verify -m hi",
    "git commit -am hi",
    "bun install -g evil-pkg",
    "bun install --global evil-pkg",
    "bun test --preload ./x.ts",
    "bun test tools/a.test.ts",
    "bun test ./a.test.ts --bail",
    "bun run check --extra",
    "bun run test:integration --strict",
    "bun run build",
    "rm -rf node_modules",
    "curl https://example.com",
    "cat ~/.ssh/id_rsa",
    "cat /etc/passwd",
    "cat .?/.?/.?/.cycle/loop.json",
    "ls src/*.ts",
    "ls ../..",
    "bun run check && curl x",
    "echo $HOME",
  ]) {
    expect(d(run(ask))).toBe("ask");
  }
  // QA and review also refuse unquoted globs (CYC-472).
  expect(d(run("cat .?/.?/.?/.cycle/loop.json"), qa)).toBe("deny");
  expect(d(run("cat .?/.?/.?/.cycle/loop.json"), review)).toBe("deny");
  expect(d(run("ls src/*.ts"), qa)).toBe("deny");
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

const ROOT = "/repo";
// The planning node's roles (CYC-322) are under exactly the research rules: every `research:` test runs them too.
const researchers = (
  ["research", "design", "research_qa", "triage", "shape", "shape_qa", "graph_planner"] as const
).map((role) => ({ role, worktree: W, readRoots: [ROOT, "/data/runs/"] }));
type ResearchCtx = (typeof researchers)[number];
const each = (check: (ctx: ResearchCtx) => void) => {
  for (const ctx of researchers) check(ctx);
};
const r = (req: Record<string, unknown>, ctx: ResearchCtx) => decide(req, ctx).decision;

test("research: reads and searches in the worktree or a read root are allowed", () => {
  each((ctx) => {
    expect(r(read(`${W}/src/a.ts`), ctx)).toBe("allow");
    expect(r(read("src/a.ts"), ctx)).toBe("allow");
    expect(r(read(`${ROOT}/apps/daemon/src/daemon.ts`), ctx)).toBe("allow");
    expect(r(read(`${ROOT}/.agents/worktree/auto/cyc-2/README.md`), ctx)).toBe("allow");
    // A read root given with a trailing slash still counts.
    expect(r(read("/data/runs/CYC-1/events.jsonl"), ctx)).toBe("allow");
    const search = request({ kind: "search", rawInput: { pattern: "foo", path: `${ROOT}/src` } });
    expect(r(search, ctx)).toBe("allow");
  });
});

test("research: reads outside the read roots are denied, and so is one that names no path", () => {
  each((ctx) => {
    expect(r(read("/etc/passwd"), ctx)).toBe("deny");
    expect(r(read(`${W}/../../../../../etc/passwd`), ctx)).toBe("deny");
    expect(r(read("/repository/x"), ctx)).toBe("deny");
    expect(r(read("/Users/me/.cycle/auto-loop/state.json"), ctx)).toBe("deny");
    expect(r(request({ kind: "read", rawInput: { uri: "file:///repo/a" } }), ctx)).toBe("deny");
    expect(r(request({ kind: "search", rawInput: { pattern: "/repo/*" } }), ctx)).toBe("deny");
  });
  // Without read roots only the worktree is readable.
  expect(decide(read(`${ROOT}/README.md`), { role: "research", worktree: W }).decision).toBe(
    "deny",
  );
  expect(decide(read(`${W}/README.md`), { role: "research", worktree: W }).decision).toBe("allow");
});

const SECRETS = [
  ".env",
  ".env.local",
  "server.pem",
  "tls.key",
  "id_rsa",
  "id_ed25519.pub",
  ".netrc",
  ".npmrc",
  "auto-loop.json",
  "loop.json",
  "credentials",
  "credentials.json",
  "app.secret.ts",
  "db.secrets",
  ".ENV",
];

test("research: a file on the secret list is denied wherever it is, as a read or as a command word", () => {
  each((ctx) => {
    for (const name of SECRETS) {
      expect(r(read(`${W}/${name}`), ctx)).toBe("deny");
      expect(r(read(`${ROOT}/sub/${name}`), ctx)).toBe("deny");
      expect(r(run(`cat ${name}`), ctx)).toBe("deny");
      expect(r(run(`head -n 1 ${ROOT}/${name}`), ctx)).toBe("deny");
    }
    // A directory of that name counts too.
    expect(r(read(`${ROOT}/credentials/a.txt`), ctx)).toBe("deny");
    expect(r(read(`${ROOT}/.git/config`), ctx)).toBe("deny");
    expect(r(read(`${ROOT}/.git/worktrees/cyc-1/config`), ctx)).toBe("deny");
    expect(r(read(`${ROOT}/.git/config.worktree`), ctx)).toBe("deny");
    expect(r(run(`cat ${ROOT}/.git/config`), ctx)).toBe("deny");
    expect(r(run("git show HEAD:.env"), ctx)).toBe("deny");
    expect(r(run("rg --ignore-file=.npmrc x"), ctx)).toBe("deny");
    // A config that is not under .git is an ordinary file.
    expect(r(read(`${ROOT}/config/app.ts`), ctx)).toBe("allow");
    expect(r(read(`${ROOT}/.git/HEAD`), ctx)).toBe("allow");
  });
});

test("research: read-only commands, git reads and du, find, stat, file run inside the read roots", () => {
  each((ctx) => {
    for (const ok of [
      "ls -la src",
      "cat README.md | head -n 20",
      "rg 'foo.*bar' src",
      "git status",
      "git log --oneline -n 5",
      "git diff origin/main...HEAD",
      `du -sh ${ROOT}/.agents/worktree`,
      `find ${ROOT}/.agents/worktree -maxdepth 2 -name '*.ts' -type f`,
      "find . -newer package.json",
      "stat -f %z package.json",
      "file bun.lock",
      `ls ${ROOT}/.agents/worktree && du -s ../cyc-2`,
    ]) {
      expect(r(run(ok), ctx)).toBe("allow");
    }
  });
});

test("research: find that runs, deletes or writes is denied, and so is file -C", () => {
  each((ctx) => {
    for (const primary of [
      "-exec cat x ;",
      "-execdir rm x ;",
      "-ok rm x ;",
      "-okdir rm x ;",
      "-delete",
      "-fprint out",
      "-fprint0 out",
      "-fprintf out %p",
      "-fls out",
    ]) {
      expect(r(run(`find . -name x ${primary}`), ctx)).toBe("deny");
    }
    expect(r(run("file -C -m magic"), ctx)).toBe("deny");
  });
});

test("research: grep that recurses and rg that reads ignored or hidden files are denied; the plain forms run", () => {
  each((ctx) => {
    for (const no of [
      `grep -r KEY ${ROOT}`,
      "grep -R KEY .",
      "grep -rn KEY .",
      "grep -inR KEY .",
      "grep --recursive KEY .",
      "grep --dereference-recursive KEY .",
      "grep -d recurse KEY .",
      "grep --directories=recurse KEY .",
      "rg -u KEY .",
      "rg -uu KEY .",
      "rg -uuu KEY .",
      "rg -nu KEY .",
      "rg --no-ignore KEY .",
      "rg --no-ignore-vcs KEY .",
      "rg --hidden KEY .",
      "rg -. KEY .",
      "rg --follow KEY .",
      "rg -L KEY .",
      "rg --unrestricted KEY .",
    ]) {
      expect(r(run(no), ctx)).toBe("deny");
    }
    for (const ok of [
      `rg KEY ${ROOT}`,
      "rg -n -i KEY src",
      "rg -l KEY .",
      "grep -n KEY src/a.ts",
      "grep -il KEY src/a.ts src/b.ts",
      "git log | grep -c x",
    ]) {
      expect(r(run(ok), ctx)).toBe("allow");
    }
  });
  // The other roles keep what they had.
  expect(d(run("grep -rn KEY src"), qa)).toBe("allow");
  expect(d(run("rg --hidden KEY src"), qa)).toBe("allow");
});

test("research: other commands, shell syntax, unquoted globs and paths outside are denied", () => {
  each((ctx) => {
    for (const no of [
      "bun run check",
      "bun install",
      "git add -A",
      "git commit -m x",
      "git push origin HEAD",
      "git fetch origin",
      "rm -rf x",
      "mv a b",
      "touch x",
      "curl https://example.com",
      "wget x",
      "gh pr list",
      "cat ~/.ssh/id_rsa",
      "cat /etc/passwd",
      "du -sh /",
      "find / -name x",
      "ls ../../../../..",
      "cat .e*",
      "ls src/*.ts",
      "cat {a,b}",
      "echo $HOME",
      "ls > f",
      "cat x | sh",
      "rg --pre sh foo .",
      "git diff --output=x",
    ]) {
      expect(r(run(no), ctx)).toBe("deny");
    }
    expect(r(request({ kind: "execute" }), ctx)).toBe("deny");
  });
});

test("research: writes, network, MCP tools and anything unrecognized are denied, never left waiting", () => {
  each((ctx) => {
    expect(r(edit(`${W}/a.ts`), ctx)).toBe("deny");
    expect(r(request({ kind: "delete", locations: [{ path: `${W}/a.ts` }] }), ctx)).toBe("deny");
    expect(r(request({ kind: "move", locations: [{ path: `${W}/a.ts` }] }), ctx)).toBe("deny");
    expect(r(request({ kind: "fetch", rawInput: { url: "https://x" } }), ctx)).toBe("deny");
    // The Claude harness files WebSearch as a search; it names no path.
    const webSearch = { kind: "search", name: "WebSearch", rawInput: { query: "x" } };
    expect(r(request(webSearch), ctx)).toBe("deny");
    // An MCP tool is "other".
    const mcp = { kind: "other", name: "mcp__plan__create_issue", rawInput: { title: "x" } };
    expect(r(request(mcp), ctx)).toBe("deny");
    expect(r(request({ kind: "switch_mode" }), ctx)).toBe("deny");
    expect(r(request({}), ctx)).toBe("deny");
    expect(r({ sessionId: "s", options: [] }, ctx)).toBe("deny");
    expect(r(request({ kind: "think" }), ctx)).toBe("allow");
  });
});

test("research: a refused command is filed under the part that was refused", () => {
  expect(commandPrefix(run("find . -name x && curl y"), "research")).toBe("curl");
  expect(commandPrefix(run("du -s . && git push"), "research_qa")).toBe("git push");
  expect(commandPrefix(run("stat a && rm a"), "shape")).toBe("rm");
  // The other roles do not allow these programs, as before.
  expect(commandPrefix(run("find . -name x && curl y"), "qa")).toBe("find");
});

test("planning: a round's bodies directory given as an extra read root can be read, its neighbours cannot", () => {
  const bodies = "/state/plans/2026-11-26T15-30-00-000Z/bodies";
  for (const role of ["triage", "shape", "shape_qa"] as const) {
    const ctx = { role, worktree: W, readRoots: [ROOT, bodies] };
    expect(decide(read(`${bodies}/CYC-5.md`), ctx).decision).toBe("allow");
    expect(decide(run(`cat ${bodies}/CYC-5.md`), ctx).decision).toBe("allow");
    expect(decide(read("/state/plans/memory.json"), ctx).decision).toBe("deny");
    expect(decide(read("/state/runs/CYC-5/run.json"), ctx).decision).toBe("deny");
    // Without it, only the worktree and the repository.
    expect(decide(read(`${bodies}/CYC-5.md`), { ...ctx, readRoots: [ROOT] }).decision).toBe("deny");
    // Never left for a person.
    expect(decide(run("bun run check"), ctx).decision).toBe("deny");
    expect(decide(edit(`${bodies}/CYC-5.md`), ctx).decision).toBe("deny");
  }
  // The other roles ignore read roots, as before.
  expect(decide(read(`${bodies}/CYC-5.md`), { ...qa, readRoots: [bodies] }).decision).toBe("deny");
  expect(decide(read(`${bodies}/CYC-5.md`), { ...dev, readRoots: [bodies] }).decision).toBe("ask");
});

test("graph_planner is read-only: worktree reads are allowed, writes and mutating commands are denied (CYC-509)", () => {
  const ctx = { role: "graph_planner" as const, worktree: W };
  expect(decide(read(`${W}/src/a.ts`), ctx).decision).toBe("allow");
  expect(decide(read(W), ctx).decision).toBe("allow");
  expect(decide(edit(`${W}/a.ts`), ctx).decision).toBe("deny");
  expect(
    decide(request({ kind: "delete", locations: [{ path: `${W}/a.ts` }] }), ctx).decision,
  ).toBe("deny");
  expect(decide(request({ kind: "move", locations: [{ path: `${W}/a.ts` }] }), ctx).decision).toBe(
    "deny",
  );
  expect(decide(run("git commit -am x"), ctx).decision).toBe("deny");
  expect(decide(run("rm -rf ."), ctx).decision).toBe("deny");
  expect(decide(run("bun run check"), ctx).decision).toBe("deny");
  expect(decide(request({ kind: "fetch" }), ctx).decision).toBe("deny");
  expect(decide(read("/etc/passwd"), ctx).decision).toBe("deny");
});

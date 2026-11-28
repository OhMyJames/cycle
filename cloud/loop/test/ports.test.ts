import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GIT_SAFE, gitDeliverAuthArgs } from "../src/env.ts";
import { gitWorkspace } from "../src/ports/git.ts";
import { githubForge } from "../src/ports/github.ts";
import type { Exec } from "../src/types.ts";

const src = (name: string) => readFile(join(import.meta.dir, "../src", name), "utf8");

test("pipeline.ts and pr.ts no longer build gh or git command arrays", async () => {
  for (const file of ["pipeline.ts", "pr.ts"]) {
    expect(await src(file)).not.toMatch(/\[\s*"(gh|git)"/);
  }
});

const recorder = () => {
  const calls: { argv: string[]; env: Record<string, string>; cwd: string }[] = [];
  const exec: Exec = async (argv, o) => {
    calls.push({ argv, env: o.env, cwd: o.cwd });
    return { code: 0, output: "https://github.com/o/r/pull/1\n", timedOut: false };
  };
  return { calls, exec };
};

test("the forge runs the same gh commands, with the delivery environment only", async () => {
  const r = recorder();
  const forge = githubForge({ exec: r.exec, env: { PATH: "/bin", GH_TOKEN: "t", OTHER: "x" } });
  const at = { cwd: "/wt", timeoutMs: 5 };
  await forge.prFor(at, "b");
  await forge.editPr(at, "b", { title: "T", bodyPath: "/p" });
  await forge.changedPaths(at, "b");
  expect(r.calls.map((c) => c.argv)).toEqual([
    ["gh", "pr", "view", "b", "--json", "url", "--jq", ".url"],
    ["gh", "pr", "edit", "b", "--title", "T", "--body-file", "/p"],
    ["gh", "pr", "diff", "b", "--name-only"],
  ]);
  for (const c of r.calls) {
    expect(c.env.GH_TOKEN).toBe("t");
    expect(c.env.OTHER).toBeUndefined();
  }
});

test("the workspace runs git with GIT_SAFE and keeps credentials for the remote only", async () => {
  const r = recorder();
  const ws = gitWorkspace({
    exec: r.exec,
    env: { PATH: "/bin", GH_TOKEN: "t" },
    repoRoot: "/repo",
    remote: "origin",
  });
  const at = { cwd: "/wt", timeoutMs: 5 };
  await ws.push(at, "br");
  await ws.diff(at, "origin/main");
  expect(r.calls[0]?.argv).toEqual([
    "git",
    ...GIT_SAFE,
    ...gitDeliverAuthArgs({ PATH: "/bin", GH_TOKEN: "t" }),
    "push",
    "origin",
    "HEAD:refs/heads/br",
  ]);
  expect(r.calls[0]?.env.GH_TOKEN).toBe("t");
  expect(r.calls[1]?.env.GH_TOKEN).toBeUndefined();
  expect(await ws.configClean(at)).toEqual({ ok: true });
});

const SHA = "a".repeat(40);

const scripted = (output: string, code = 0) => {
  const calls: { argv: string[]; cwd: string; env: Record<string, string> }[] = [];
  const exec: Exec = async (argv, o) => {
    calls.push({ argv, cwd: o.cwd, env: o.env });
    return { code, output, timedOut: false };
  };
  return { calls, exec };
};

test("openPrs reads number, head, draft, fork and author", async () => {
  const r = scripted(
    JSON.stringify([
      {
        number: 7,
        headRefName: "feat",
        headRefOid: SHA,
        isDraft: false,
        isCrossRepository: true,
        author: { login: "bob" },
      },
    ]),
  );
  const forge = githubForge({ exec: r.exec, env: { GH_TOKEN: "t" }, repo: "o/r" });
  const got = await forge.openPrs({ cwd: "/wt", timeoutMs: 5 });
  expect(got).toEqual({
    ok: true,
    prs: [
      {
        number: 7,
        headBranch: "feat",
        headSha: SHA,
        isDraft: false,
        crossRepository: true,
        author: "bob",
        title: "",
        body: "",
      },
    ],
  });
  expect(r.calls[0]?.argv.slice(-2)).toEqual(["--repo", "o/r"]);
  expect(
    (
      await githubForge({ exec: scripted("nope").exec, env: {} }).openPrs({
        cwd: "/",
        timeoutMs: 5,
      })
    ).ok,
  ).toBe(false);
});

test("authorPermission asks the collaborators API without --repo and refuses odd logins", async () => {
  const r = scripted("write\n");
  const forge = githubForge({ exec: r.exec, env: { GH_TOKEN: "t" }, repo: "o/r" });
  const at = { cwd: "/wt", timeoutMs: 5 };
  expect(await forge.authorPermission(at, "bob")).toEqual({ ok: true, permission: "write" });
  expect(r.calls[0]?.argv).toEqual([
    "gh",
    "api",
    "repos/o/r/collaborators/bob/permission",
    "--jq",
    ".permission",
  ]);
  expect((await forge.authorPermission(at, "../x")).ok).toBe(false);
  expect(r.calls).toHaveLength(1);
});

test("mergeAt squashes pinned to the reviewed commit and never uses auto-merge", async () => {
  const r = scripted("");
  const forge = githubForge({ exec: r.exec, env: { GH_TOKEN: "t" }, repo: "o/r" });
  const at = { cwd: "/wt", timeoutMs: 5 };
  expect(await forge.mergeAt(at, "7", SHA)).toEqual({ ok: true });
  expect(r.calls[0]?.argv).toEqual([
    "gh",
    "pr",
    "merge",
    "7",
    "--squash",
    "--match-head-commit",
    SHA,
    "--repo",
    "o/r",
  ]);
  expect(r.calls[0]?.argv).not.toContain("--auto");
  expect((await forge.mergeAt(at, "7", "--auto")).ok).toBe(false);
  expect(
    (await githubForge({ exec: scripted("head changed", 1).exec, env: {} }).mergeAt(at, "7", SHA))
      .ok,
  ).toBe(false);
});

test("prHead reads the head commit and state", async () => {
  const r = scripted(JSON.stringify({ headRefOid: SHA, state: "OPEN" }));
  const forge = githubForge({ exec: r.exec, env: {} });
  expect(await forge.prHead({ cwd: "/wt", timeoutMs: 5 }, "7")).toEqual({
    ok: true,
    sha: SHA,
    state: "OPEN",
  });
});

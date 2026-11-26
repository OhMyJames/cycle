import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  alphaVersion,
  buildNow,
  CERT_NAME,
  type Deps,
  type Described,
  ensureCert,
  failuresOf,
  folderOf,
  inApp,
  type Run,
  versionsIn,
  watchOnce,
} from "./alpha.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "alpha-test-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const desc = (n: number, over: Partial<Described> = {}): Described => ({
  short: `c${n}`,
  count: n,
  subject: `commit ${n}`,
  dirty: false,
  baseVersion: "0.3.31",
  ...over,
});

type Fake = Deps & { calls: string[]; head: { n: number }; onBuild: (n: number) => void };

const fake = (over: Partial<Deps> = {}): Fake => {
  const calls: string[] = [];
  const head = { n: 100 };
  const state: Fake = {
    calls,
    head,
    onBuild: () => {},
    repo: join(tmp, "alpha"),
    root: join(tmp, "root"),
    git: {
      fetch: () => void calls.push("fetch"),
      remote: () => `full${head.n}`,
      checkout: (c) => {
        calls.push(`checkout ${c}`);
        return join(tmp, "tree", c);
      },
      describe: (dir) => {
        const m = /(\d+)$/.exec(dir);
        return desc(m ? Number(m[1]) : 50);
      },
      changedFiles: () => ["packages/ui/src/a.ts"],
    },
    build: async (dir, version) => {
      calls.push(`build ${version}`);
      const n = Number(/(\d+)$/.exec(dir)?.[1] ?? 50);
      state.onBuild(n);
      return { app: join(tmp, "Cycle.app"), platform: "darwin", arch: "arm64" };
    },
    ensureCert: () => void calls.push("cert"),
    sign: () => void calls.push("sign"),
    archive: (_app, zip) => {
      calls.push("archive");
      // A write goes to a `.partial` folder first.
      expect(zip).toContain(".partial");
      writeFileSync(zip, "zip");
      return { sha256: "a".repeat(64), size: 3 };
    },
    installed: () => undefined,
    isAlive: () => false,
    pid: 4242,
    now: () => new Date("2026-11-26T00:00:00Z"),
    sleep: async () => {},
    log: (l) => void calls.push(`log ${l}`),
    ...over,
  };
  return state;
};

const seed = (repo: string, version: string) => {
  const dir = join(repo, folderOf(version));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), "{}");
};

describe("version", () => {
  test("next patch, commit count, short commit, dirty", () => {
    expect(alphaVersion(desc(895, { short: "abc1234" }))).toBe("0.3.32-alpha.895+abc1234");
    expect(alphaVersion(desc(895, { short: "abc1234", dirty: true }))).toBe(
      "0.3.32-alpha.895+abc1234.dirty",
    );
  });
});

describe("repository", () => {
  test("writes via .partial, then a manifest with commit, subject and builtAt", async () => {
    const d = fake({ root: join(tmp, "root") });
    expect(await buildNow(d)).toBe("built");
    const v = "0.3.32-alpha.50+c50";
    const dir = join(d.repo, folderOf(v));
    expect(readdirSync(d.repo).sort()).toEqual([folderOf(v)]);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(m).toMatchObject({
      version: v,
      commit: "c50",
      subject: "commit 50",
      builtAt: "2026-11-26T00:00:00.000Z",
      file: `Cycle-${v}-darwin-arm64.zip`,
    });
    expect(existsSync(join(dir, m.file))).toBe(true);
    expect(d.calls.indexOf("cert")).toBeLessThan(d.calls.indexOf("sign"));
    expect(d.calls.indexOf("sign")).toBeLessThan(d.calls.indexOf("archive"));
  });

  test("keeps the newest 3 and the installed one", async () => {
    const d = fake({ installed: () => "0.3.31-alpha.1+x" as string });
    for (const n of [1, 2, 3, 4, 5]) seed(d.repo, `0.3.31-alpha.${n}+x`);
    // 0.3.31-alpha.1 is the installed version, and newer than nothing: the manual one is newer.
    expect(await buildNow(d)).toBe("built");
    expect(versionsIn(d.repo).sort()).toEqual(
      ["0.3.31-alpha.1+x", "0.3.31-alpha.5+x", "0.3.31-alpha.4+x", "0.3.32-alpha.50+c50"].sort(),
    );
  });

  test("the version just built is kept even when not among the newest 3", async () => {
    const d = fake();
    for (const n of [200, 201, 202]) seed(d.repo, `0.3.32-alpha.${n}+x`);
    expect(await buildNow(d)).toBe("built");
    expect(versionsIn(d.repo)).toContain("0.3.32-alpha.50+c50");
  });

  test("an empty lock file counts as held", async () => {
    const d = fake();
    mkdirSync(d.repo, { recursive: true });
    writeFileSync(join(d.repo, ".lock"), "");
    expect(await buildNow(d)).toBe("locked");
  });

  test("a stale .partial is swept", async () => {
    const d = fake();
    mkdirSync(join(d.repo, "old.partial"), { recursive: true });
    await buildNow(d);
    expect(existsSync(join(d.repo, "old.partial"))).toBe(false);
  });
});

describe("manual", () => {
  test("older than the installed: no build, both versions said", async () => {
    const d = fake({ installed: () => "0.4.0-alpha.9+zzz" });
    expect(await buildNow(d)).toBe("older");
    expect(d.calls.some((c) => c.startsWith("build"))).toBe(false);
    const said = d.calls.filter((c) => c.startsWith("log")).join("\n");
    expect(said).toContain("0.4.0-alpha.9+zzz");
    expect(said).toContain("0.3.32-alpha.50+c50");
  });

  test("same version: built, and says to reinstall from Cycle", async () => {
    const d = fake({ installed: () => "0.3.32-alpha.50+c50" });
    expect(await buildNow(d)).toBe("built");
    expect(d.calls.filter((c) => c.startsWith("log")).join("\n")).toContain("reinstall");
  });

  test("a second instance does not get the lock and says so", async () => {
    const d = fake({ isAlive: (pid) => pid === 777 });
    mkdirSync(d.repo, { recursive: true });
    writeFileSync(join(d.repo, ".lock"), "777");
    expect(await buildNow(d)).toBe("locked");
    expect(d.calls.some((c) => c.startsWith("build"))).toBe(false);
    expect(d.calls.join("\n")).toContain("Another alpha build is running");
    expect(readFileSync(join(d.repo, ".lock"), "utf8")).toBe("777");
  });

  test("a lock whose process is gone is taken over and released", async () => {
    const d = fake();
    mkdirSync(d.repo, { recursive: true });
    writeFileSync(join(d.repo, ".lock"), "777");
    expect(await buildNow(d)).toBe("built");
    expect(existsSync(join(d.repo, ".lock"))).toBe(false);
  });
});

describe("watch", () => {
  test("a version already in the repository is not built", async () => {
    const d = fake();
    seed(d.repo, "0.3.32-alpha.100+c100");
    expect(await watchOnce(d)).toEqual([]);
    expect(d.calls.some((c) => c.startsWith("build"))).toBe(false);
  });

  test("a recorded failure is not built", async () => {
    const d = fake();
    mkdirSync(d.repo, { recursive: true });
    writeFileSync(
      join(d.repo, "failures.json"),
      JSON.stringify({ full100: { version: "v", error: "e", at: "t" } }),
    );
    expect(await watchOnce(d)).toEqual([]);
    expect(d.calls.some((c) => c.startsWith("build"))).toBe(false);
  });

  test("main moving during a build: only the latest is built next", async () => {
    const d = fake();
    d.onBuild = (n) => {
      if (n === 100) d.head.n = 103; // 101 and 102 came and went
    };
    expect(await watchOnce(d)).toEqual(["0.3.32-alpha.100+c100", "0.3.32-alpha.103+c103"]);
    expect(d.calls.filter((c) => c.startsWith("build"))).toHaveLength(2);
  });

  test("a failed build is recorded and not retried", async () => {
    const d = fake({
      build: async () => {
        throw new Error("boom");
      },
    });
    expect(await watchOnce(d)).toEqual([]);
    expect(failuresOf(d.repo).full100?.error).toBe("boom");
    d.calls.length = 0;
    await watchOnce(d);
    expect(d.calls.some((c) => c.startsWith("log Building"))).toBe(false);
    expect(existsSync(join(d.repo, ".lock"))).toBe(false);
  });
});

describe("watch skips commits that do not change the app", () => {
  const seedWithCommit = (repo: string, version: string, commit: string) => {
    seed(repo, version);
    writeFileSync(join(repo, folderOf(version), "manifest.json"), JSON.stringify({ commit }));
  };
  const built = (d: Fake) => d.calls.some((c) => c.startsWith("build"));

  test("only paths outside the app: no build, logged, not judged again", async () => {
    const asked: string[] = [];
    const d = fake({
      git: {
        ...fake().git,
        changedFiles: (from, to) => {
          asked.push(`${from}..${to}`);
          return ["tools/x.ts", ".agents/notes/a.md", "README.md", "packages/ui/test/a.test.ts"];
        },
      },
    });
    seedWithCommit(d.repo, "0.3.32-alpha.90+c90", "full90");
    expect(await watchOnce(d)).toEqual([]);
    expect(built(d)).toBe(false);
    expect(d.calls.some((c) => c.startsWith("log Skipping full100"))).toBe(true);
    expect(await watchOnce(d)).toEqual([]);
    expect(asked).toEqual(["full90..full100"]);
  });

  for (const path of ["packages/ui/src/a.ts", "apps/daemon/src/a.ts", "bun.lock"]) {
    test(`any app path (${path}) builds`, async () => {
      const d = fake({
        git: { ...fake().git, changedFiles: () => ["tools/x.ts", path] },
      });
      seedWithCommit(d.repo, "0.3.32-alpha.90+c90", "full90");
      expect(await watchOnce(d)).toEqual(["0.3.32-alpha.100+c100"]);
    });
  }

  test("no earlier alpha, no commit in its manifest, or a failed comparison: builds", async () => {
    const none = fake();
    expect(await watchOnce(none)).toHaveLength(1);
    const blank = fake({
      repo: join(tmp, "blank"),
      git: { ...fake().git, changedFiles: () => ["tools/x.ts"] },
    });
    seed(blank.repo, "0.3.32-alpha.90+c90");
    expect(await watchOnce(blank)).toHaveLength(1);
    const broken = fake({
      repo: join(tmp, "broken"),
      git: {
        ...fake().git,
        changedFiles: () => {
          throw new Error("bad object");
        },
      },
    });
    seedWithCommit(broken.repo, "0.3.32-alpha.90+c90", "gone");
    expect(await watchOnce(broken)).toHaveLength(1);
  });

  test("buildNow does not look at the changes", async () => {
    const d = fake({
      git: {
        ...fake().git,
        changedFiles: () => {
          throw new Error("must not be asked");
        },
      },
    });
    seedWithCommit(d.repo, "0.3.32-alpha.40+c40", "full40");
    expect(await buildNow(d)).toBe("built");
  });

  test("the table", () => {
    for (const p of [
      "tools/a",
      ".agents/a",
      ".claude/a",
      ".github/a",
      "docs/a",
      "README.md",
      "a/test/b.ts",
      "test/b.ts",
    ])
      expect(inApp(p)).toBe(false);
    for (const p of [
      "packages/ui/a",
      "apps/daemon/a",
      "bun.lock",
      "apps/desktop/README.md",
      "package.json",
      "scripts/x.ts",
      "latest/a.ts",
    ])
      expect(inApp(p)).toBe(true);
  });
});

describe("certificate", () => {
  const recorder = (existsAfter: boolean[]) => {
    const calls: string[][] = [];
    const run: Run = (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "find-certificate") return { code: existsAfter.shift() ? 0 : 1, out: "" };
      return { code: 0, out: "" };
    };
    return { calls, run };
  };

  test("an existing one is left alone; existence is not asked with find-identity -v", () => {
    const { calls, run } = recorder([true]);
    ensureCert(
      run,
      () => {},
      () => mkdtempSync(join(tmp, "s-")),
    );
    expect(calls).toEqual([["/usr/bin/security", "find-certificate", "-c", CERT_NAME]]);
  });

  test("a missing one is made, then imported for codesign only", () => {
    const { calls, run } = recorder([false, true]);
    const said: string[] = [];
    ensureCert(
      run,
      (l) => said.push(l),
      () => mkdtempSync(join(tmp, "s-")),
      "/home/x",
    );
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "/usr/bin/security find-certificate",
      "/usr/bin/openssl req",
      "/usr/bin/openssl pkcs12",
      "/usr/bin/security import",
      "/usr/bin/security find-certificate",
    ]);
    const req = calls[1]?.join(" ") ?? "";
    expect(req).toContain(`/CN=${CERT_NAME}`);
    expect(req).toContain("extendedKeyUsage=critical,codeSigning");
    expect(calls[2]).not.toContain("-legacy");
    const imp = calls[3] ?? [];
    expect(imp.join(" ")).toContain("-T /usr/bin/codesign");
    expect(imp).toContain("/home/x/Library/Keychains/login.keychain-db");
    expect(calls.flat()).not.toContain("-v");
    expect(said.join("\n")).toContain("login keychain");
  });
});

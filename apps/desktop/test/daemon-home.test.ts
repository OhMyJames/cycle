// The app's daemon outside the app (docs/desktop.md "本机 daemon", CYC-538): the daemon the app carries is put where the
// local daemon runs from when that one is missing or older, staged beside it when it is running, and left alone when it
// is as new. The folders are temporary; the version of a folder is what its `cycle` file says.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stagedDir as daemonStagedDir,
  stagedNote as daemonStagedNote,
} from "../../daemon/src/self-update.ts";
import {
  managedDaemonDir,
  type SeedDeps,
  seedAndReport,
  seedDaemon,
  stagedDir,
  stagedNote,
} from "../src/main/daemon-home.ts";

const tempDir = async () => {
  const at = await mkdtemp(join(tmpdir(), "cycle-daemon-home-"));
  return { dir: at, dispose: () => rm(at, { recursive: true, force: true }) };
};

let dir: string;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(() => dispose());

const folder = async (path: string, version: string) => {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "cycle"), version);
  await writeFile(join(path, "claude"), "claude");
};

const deps = async (over: Partial<SeedDeps> & { installed?: string } = {}): Promise<SeedDeps> => {
  const bundledDir = join(dir, "Cycle.app", "bin");
  await folder(bundledDir, "0.3.1100");
  const managedDir = managedDaemonDir(join(dir, "home"));
  if (over.installed !== undefined) await folder(managedDir, over.installed);
  return {
    bundledDir,
    bundledVersion: "0.3.1100",
    managedDir,
    versionOf: async (d) =>
      readFile(join(d, "cycle"), "utf8").catch(() => undefined) as Promise<string | undefined>,
    running: async () => false,
    // Like `/bin/cp -R`: the folder it copies into must be there.
    copy: async (from, to) => {
      if (!existsSync(join(to, ".."))) throw new Error(`cp: ${to}: No such file or directory`);
      await cp(from, to, { recursive: true });
    },
    ...over,
  };
};

const versionIn = (d: string) => readFile(join(d, "cycle"), "utf8");

test("with no daemon there yet, the app's is put in place", async () => {
  const d = await deps();
  expect(await seedDaemon(d)).toBe("installed");
  expect(await versionIn(d.managedDir)).toBe("0.3.1100");
  expect(existsSync(`${d.managedDir}.seeding`)).toBe(false);
});

test("an older daemon that is not running is replaced; one as new or newer is left alone", async () => {
  const older = await deps({ installed: "0.3.1000" });
  expect(await seedDaemon(older)).toBe("installed");
  expect(await versionIn(older.managedDir)).toBe("0.3.1100");

  await dispose();
  ({ dir, dispose } = await tempDir());
  const newer = await deps({ installed: "0.3.1200" });
  expect(await seedDaemon(newer)).toBe("current");
  expect(await versionIn(newer.managedDir)).toBe("0.3.1200");
});

test("an older daemon that is running is not touched: the app's is staged for it to switch to when idle", async () => {
  const d = await deps({ installed: "0.3.1000", running: async () => true });
  expect(await seedDaemon(d)).toBe("staged");
  expect(await versionIn(d.managedDir)).toBe("0.3.1000");
  expect(await versionIn(stagedDir(d.managedDir))).toBe("0.3.1100");
  expect(JSON.parse(await readFile(stagedNote(d.managedDir), "utf8"))).toEqual({
    version: "0.3.1100",
  });
  // Something as new already staged (from the channel) is kept.
  await folder(stagedDir(d.managedDir), "0.3.1150");
  await writeFile(stagedNote(d.managedDir), JSON.stringify({ version: "0.3.1150" }));
  expect(await seedDaemon(d)).toBe("staged");
  expect(await versionIn(stagedDir(d.managedDir))).toBe("0.3.1150");
});

test("a daemon that does not run is replaced even when it says nothing", async () => {
  const d = await deps({ installed: "garbage", versionOf: async () => undefined });
  expect(await seedDaemon(d)).toBe("installed");
  expect(await versionIn(d.managedDir)).toBe("0.3.1100");
});

test("the folder of a running daemon that would not say its version is never replaced", async () => {
  const d = await deps({
    installed: "0.3.1000",
    versionOf: async () => undefined,
    running: async () => true,
  });
  expect(await seedDaemon(d)).toBe("staged");
  expect(await versionIn(d.managedDir)).toBe("0.3.1000");
  expect(await versionIn(stagedDir(d.managedDir))).toBe("0.3.1100");
});

test("the result is counted as one fixed word, and a failure as `failed`, never its reason", async () => {
  const tracked: unknown[] = [];
  const track = (name: string, props: unknown) => tracked.push([name, props]);
  expect(await seedAndReport(await deps(), track)).toBe("installed");
  const failing = await deps({
    copy: async () => {
      throw new Error("ENOSPC: /Users/someone/.cycle/daemon/bin");
    },
    installed: "0.3.1",
  });
  expect(await seedAndReport(failing, track)).toBe("failed");
  expect(tracked).toEqual([
    ["local_daemon_seeded", { result: "installed" }],
    ["local_daemon_seeded", { result: "failed" }],
  ]);
  expect(JSON.stringify(tracked)).not.toContain("someone");
});

test("the app stages under the names the daemon's self-update reads", () => {
  expect(stagedDir("/x/bin")).toBe(daemonStagedDir("/x/bin"));
  expect(stagedNote("/x/bin")).toBe(daemonStagedNote("/x/bin"));
});

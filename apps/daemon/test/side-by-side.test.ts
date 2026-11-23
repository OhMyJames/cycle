import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// An installed app and a run from source are two daemons on one machine. They are told apart by their
// data directory alone (CYCLE_HOME), so the test is that two of them do not see each other: their own
// pid, socket and state, and stopping one does not stop the other.

const main = join(import.meta.dir, "..", "src", "main.ts");
let root: string;
const started: ReturnType<typeof Bun.spawn>[] = [];
const killAll = (procs: ReturnType<typeof Bun.spawn>[]) => {
  for (const proc of procs) proc.kill(9);
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-side-"));
});
afterEach(async () => {
  const procs = started.splice(0);
  for (const proc of procs) proc.kill();
  // Gone before the directory is: a daemon that is slow to stop must not write into a deleted one.
  const timer = setTimeout(() => killAll(procs), 3_000);
  await Promise.all(procs.map((proc) => proc.exited));
  clearTimeout(timer);
  await rm(root, { recursive: true, force: true });
});

const env = (home: string, data: string) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  CYCLE_HOME: data,
});
const cycle = (home: string, data: string, ...args: string[]) =>
  Bun.spawn(["bun", main, ...args], { env: env(home, data), stdout: "pipe", stderr: "pipe" });
const status = async (home: string, data: string): Promise<number> =>
  await cycle(home, data, "status").exited;
const until = async (what: string, probe: () => Promise<boolean> | boolean, ms = 10_000) => {
  const at = Date.now();
  while (!(await probe())) {
    if (Date.now() - at > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a daemon for the installed app and one for a checkout run side by side, each with its own", async () => {
  const home = join(root, "home");
  const stable = join(home, ".cycle");
  const dev = join(home, ".cycle-dev");
  await mkdir(home, { recursive: true });
  started.push(cycle(home, stable, "serve"), cycle(home, dev, "serve"));
  await until(
    "both to be up",
    async () => (await status(home, stable)) === 0 && (await status(home, dev)) === 0,
  );

  const pids = await Promise.all(
    [stable, dev].map(async (dir) =>
      Number((await readFile(join(dir, "daemon.pid"), "utf8")).trim()),
    ),
  );
  expect(pids[0]).not.toBe(pids[1]);
  expect(pids.every(alive)).toBe(true);
  expect(existsSync(join(stable, "daemon.sock"))).toBe(true);
  expect(existsSync(join(dev, "daemon.sock"))).toBe(true);

  // Stopping the one for the checkout leaves the installed app's where it was.
  expect(await cycle(home, dev, "stop").exited).toBe(0);
  await until("the checkout's daemon to stop", async () => (await status(home, dev)) === 1);
  // Its socket goes a moment before its process does (serve.ts closes it, then the process exits).
  await until("the checkout's daemon to exit", () => !alive(pids[1] as number));
  expect(await status(home, stable)).toBe(0);
  expect(alive(pids[0] as number)).toBe(true);
}, 30_000);

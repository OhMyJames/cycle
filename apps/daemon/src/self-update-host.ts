// What a real daemon process gives its self-update (self-update.ts): the network, the check of a downloaded folder, and
// the start of a new daemon. Kept apart so that self-update.ts stays testable with fakes.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Paths } from "./config.ts";
import { startDetached } from "./proxy.ts";
import { isListening } from "./transport/server.ts";

const run = async (
  argv: string[],
  timeoutMs: number,
): Promise<{ code: number; out: string; err: string }> => {
  const child = Bun.spawn(argv, {
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, out, err };
  } finally {
    clearTimeout(timer);
  }
};

/** The team a macOS program is signed by, or undefined when it has none (ad hoc, unsigned, or not macOS). */
export const teamOf = async (path: string): Promise<string | undefined> => {
  if (process.platform !== "darwin") return undefined;
  const { err } = await run(["/usr/bin/codesign", "-dv", path], 30_000);
  const team = /^TeamIdentifier=(.+)$/m.exec(err)?.[1]?.trim();
  return team === undefined || team === "not set" ? undefined : team;
};

/** Every program (a file anyone may run) in a folder and the folders in it. */
const programsIn = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await programsIn(path)));
    else if (entry.isFile() && ((await stat(path)).mode & 0o111) !== 0) out.push(path);
  }
  return out;
};

/**
 * Checks a downloaded folder before it may be switched to: its daemon runs and says the version it should, and on a Mac
 * where this daemon is signed by a team, every program in it is validly signed by that same team (the keychain knows
 * the programs by it: another team would ask for the person's logins again).
 */
export const checkFolder =
  (runningExecutable: string) =>
  async (dir: string, version: string): Promise<void> => {
    const said = await run([join(dir, "cycle"), "version"], 30_000);
    if (said.code !== 0 || said.out.trim() !== version)
      throw new Error(`The new daemon says it is ${said.out.trim() || "nothing"}, not ${version}.`);
    const team = await teamOf(runningExecutable);
    if (team === undefined) return;
    for (const program of await programsIn(dir)) {
      const verified = await run(["/usr/bin/codesign", "--verify", "--strict", program], 60_000);
      if (verified.code !== 0)
        throw new Error(`A program of the new daemon is not validly signed: ${program}`);
      if ((await teamOf(program)) !== team)
        throw new Error(`A program of the new daemon is not signed by ${team}: ${program}`);
    }
  };

/** Starts a daemon from `executable` and waits until it listens; false when it did not within `ms`. */
export const startAndWait = async (
  paths: Paths,
  executable: string,
  ms = 30_000,
): Promise<boolean> => {
  const child = startDetached(paths, [executable]);
  for (const at = Date.now(); Date.now() - at < ms; await Bun.sleep(100)) {
    if (await isListening(paths.socket)) return true;
    if (child.exited()) break;
  }
  return isListening(paths.socket);
};

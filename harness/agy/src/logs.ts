import { readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/**
 * The log file one adapter's `agy acp` frontend writes: the configured name with the adapter's pid in it
 * (`agy-acp.log` → `agy-acp.1234.log`), so each frontend has a file of its own and none overwrites another's (CYC-297).
 * agy adds its own `.<pid>` to the workers' files beside it.
 */
export const logFileFor = (logFile: string, pid: number = process.pid): string => {
  const ext = extname(logFile);
  return join(dirname(logFile), `${basename(logFile, ext)}.${pid}${ext}`);
};

/** How many of the past runs' logs are kept, and how old the rest may be. */
export const LOG_KEEP = 40;
export const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Removes the logs of earlier runs: those older than `maxAgeMs`, then the oldest past `keep`. A file belongs to the
 * set when it is the configured name with a pid (and agy's `.<pid>` worker suffix) in it. `keep` counts the newest
 * files, the current run's among them; it is never removed.
 */
/** Whether the file is the log of a frontend that is still running: the pid in `<stem>.<pid>…` is alive. */
const runs = (name: string, stem: string, alive: (pid: number) => boolean = isAlive): boolean => {
  const pid = Number(
    new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)\\.`).exec(name)?.[1],
  );
  return Number.isInteger(pid) && pid > 0 && alive(pid);
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const pruneLogs = (
  logFile: string,
  options: {
    current?: string;
    keep?: number;
    maxAgeMs?: number;
    now?: number;
    alive?: (pid: number) => boolean;
  } = {},
): string[] => {
  const dir = dirname(logFile);
  const ext = extname(logFile);
  const stem = basename(logFile, ext);
  const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `agy-acp.log` (an earlier run's), `agy-acp.<pid>.log`, and agy's workers' `….log.<pid>`.
  const own = new RegExp(`^${escapeRe(stem)}(\\.\\d+)?${escapeRe(ext)}(\\.\\d+)*$`);
  const keep = options.keep ?? LOG_KEEP;
  const maxAge = options.maxAgeMs ?? LOG_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files = names
    .filter(
      (name) =>
        own.test(name) && join(dir, name) !== options.current && !runs(name, stem, options.alive),
    )
    .flatMap((name) => {
      try {
        return [{ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  files.forEach((file, index) => {
    // The current run's file is one of the `keep`.
    if (index < keep - 1 && now - file.mtime <= maxAge) return;
    try {
      unlinkSync(file.path);
      removed.push(file.path);
    } catch {}
  });
  return removed;
};

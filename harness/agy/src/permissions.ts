import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { META } from "@cycle/protocol";

/**
 * agy's `toolPermission` (its settings.json, top-level key): how tool calls are approved. Measured on agy 1.5.16 with a
 * real account (2026-11-24): the key is read once, when a session's worker process is created (`session/new`,
 * `session/resume`), not afterwards; and the value wins over a missing `--dangerously-skip-permissions`.
 */
export const TOOL_PERMISSIONS = [
  {
    value: "request-review",
    name: "Ask",
    description: "Ask before edits, commands, web and MCP calls, as agy does by default.",
  },
  {
    value: "proceed-in-sandbox",
    name: "Sandbox",
    description: "Run sandboxed commands without asking; ask before anything outside the sandbox.",
  },
  {
    value: "strict",
    name: "Strict",
    description: "Ask for every call, even where the mode would let it through.",
  },
  {
    value: "always-proceed",
    name: "Allow all",
    description: "Run every edit, command and tool call without asking, whatever the mode.",
    _meta: { [META.danger]: true },
  },
] as const;

export type ToolPermission = (typeof TOOL_PERMISSIONS)[number]["value"];
export const DEFAULT_TOOL_PERMISSION: ToolPermission = "request-review";

export const isToolPermission = (value: unknown): value is ToolPermission =>
  TOOL_PERMISSIONS.some((entry) => entry.value === value);

/** Where agy reads its settings: `<HOME>/.gemini/antigravity-cli/settings.json`. */
export const agySettingsPath = (home: string): string =>
  join(home, ".gemini", "antigravity-cli", "settings.json");

/**
 * Sets the keys Cycle owns in agy's settings.json and leaves every other key as it was. The write is atomic (a temp
 * file renamed over it) and the file is 0600. A file that is not a JSON object is not touched: the error is thrown, so
 * a session never starts under a permission level other than the one asked for.
 */
export const writeManagedSettings = async (
  path: string,
  managed: { toolPermission: ToolPermission },
): Promise<void> => {
  let current: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== undefined && text.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${path} is not valid JSON; fix or remove it`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${path} is not a JSON object; fix or remove it`);
    }
    current = parsed as Record<string, unknown>;
  }
  if (current.toolPermission === managed.toolPermission) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ ...current, ...managed }, null, 2)}\n`, {
      mode: 0o600,
      flush: true,
    });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
};

/** A lock nobody has touched for this long belongs to a process that died; a live holder touches it every few seconds. */
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 5_000;
/** Many sessions resuming at once queue here, each for as long as agy takes to start a worker. */
const LOCK_WAIT_MS = 5 * 60_000;

/**
 * Runs `work` holding a lock shared by every adapter process using the same agy HOME. settings.json is one file for
 * all sessions but each session has its own level, and agy reads it only as a session starts, so "write my level, start
 * my session" must not interleave with another session's. A lock left by a process that died is taken over.
 */
export const withSettingsLock = async <T>(
  path: string,
  work: () => Promise<T>,
  /** Only for tests: shorter timings so they need not wait real seconds. */
  timing: { staleMs?: number; heartbeatMs?: number } = {},
): Promise<T> => {
  const staleMs = timing.staleMs ?? LOCK_STALE_MS;
  const heartbeatMs = timing.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      );
      if (age > staleMs) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for agy's settings lock");
      await Bun.sleep(25);
    }
  }
  // Starting a worker can take longer than the stale limit (a login, a model catalog), so the holder keeps the lock fresh.
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lock, now, now).catch(() => undefined);
  }, heartbeatMs);
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    await rm(lock, { recursive: true, force: true });
  }
};

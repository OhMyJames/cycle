// The session's environment variables (docs/protocol.md §6 "环境") reach the commands Claude runs, and nothing else:
// not the Claude process, whose environment is the daemon's explicit allowlist (AGENTS.md). Claude Code sources the
// file named by CLAUDE_ENV_FILE before each Bash command (checked with the SDK's 0.3.327 binary, 2026-11-24). The
// daemon writes it in its own data directory, beside the index that already keeps the same values (0600), never in
// Claude's config directory, where Claude refuses such a file; it clears the folder each time it starts.
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A name a shell can export. The daemon refuses any other; one that comes anyway is left out, never quoted in. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A value as one single-quoted shell word: nothing in it is expanded. */
export const shellWord = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** The file's text: one `export` per variable, in their order. */
export const envFileText = (variables: Record<string, string>): string =>
  Object.entries(variables)
    .filter(([name]) => NAME.test(name))
    .map(([name, value]) => `export ${name}=${shellWord(value)}\n`)
    .join("");

/** A session id as a file name: the daemon's are UUIDs; anything else is not one to write under. */
const FILE_NAME = /^[A-Za-z0-9-]+$/;

/**
 * Writes this session's variables to `<dir>/<sessionId>.sh` (the folder 0700, the file 0600) and returns its path, or
 * removes it and returns undefined when there are none. Written whole and renamed into place: a Claude command never
 * sources half a file.
 */
export const writeSessionEnvFile = (
  dir: string,
  sessionId: string,
  variables: Record<string, string>,
): string | undefined => {
  if (!FILE_NAME.test(sessionId)) return undefined;
  const file = join(dir, `${sessionId}.sh`);
  const text = envFileText(variables);
  if (text === "") {
    rmSync(file, { force: true });
    return undefined;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, file);
  return file;
};

/** Removes every session's file: when the daemon starts, no Claude process of a former one is left to read them. */
export const clearSessionEnvFiles = (dir: string): void =>
  rmSync(dir, { recursive: true, force: true });

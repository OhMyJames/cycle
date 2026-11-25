// The session's environment variables (docs/protocol.md §6 "环境", CYC-314) reach the shell commands `agy` runs,
// and nothing else: not the `agy` process itself, whose environment stays the daemon's explicit allowlist (AGENTS.md).
// `agy` runs commands through a non-interactive shell (`zsh -c` on macOS without `-f`, `bash -c` on Linux) and passes
// `ZDOTDIR` / `BASH_ENV` through without interpreting them itself. The daemon writes `<dataDir>/agy-env/<sessionId>/.zshenv`
// (folder 0700, file 0600, atomic rename) and clears `<dataDir>/agy-env` each time it starts.
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The startup file inside a session's `ZDOTDIR`, also referenced by `BASH_ENV`. */
export const AGY_ENV_FILE = ".zshenv";

/** A name a shell can export. The daemon refuses any other; one that comes anyway is left out, never quoted in. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A value as one single-quoted shell word: nothing in it is expanded. */
export const shellWord = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The file's text: optionally sources `$HOME/.zshenv` when running under zsh, exports each session variable in order,
 * then unsets `ZDOTDIR` and `BASH_ENV` so interactive/login subshells keep `$HOME` and nested shells can override
 * variables without re-sourcing the file. Empty string when there are no exportable variables.
 */
export const envFileText = (variables: Record<string, string>): string => {
  const exports = Object.entries(variables)
    .filter(([name]) => NAME.test(name))
    .map(([name, value]) => `export ${name}=${shellWord(value)}\n`)
    .join("");
  if (exports === "") return "";
  return (
    'if [ -n "$ZSH_VERSION" ] && [ -r "$HOME/.zshenv" ]; then . "$HOME/.zshenv"; fi\n' +
    exports +
    "unset ZDOTDIR BASH_ENV\n"
  );
};

/** A session id as a directory name: the daemon's are UUIDs; anything else is not one to write under. */
const DIR_NAME = /^[A-Za-z0-9-]+$/;

/**
 * Writes this session's variables to `<root>/<sessionId>/.zshenv` (directories 0700, file 0600) and returns the
 * session directory path (suitable for `ZDOTDIR`), or removes it and returns undefined when there are none.
 */
export const writeSessionEnvDir = (
  root: string,
  sessionId: string,
  variables: Record<string, string>,
): string | undefined => {
  if (!DIR_NAME.test(sessionId)) return undefined;
  const dir = join(root, sessionId);
  const text = envFileText(variables);
  if (text === "") {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, AGY_ENV_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, file);
  return dir;
};

/** Removes every session's directory: when the daemon starts, no agy process of a former one is left to read them. */
export const clearSessionEnvDirs = (root: string): void =>
  rmSync(root, { recursive: true, force: true });

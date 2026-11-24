// The session's environment variables (docs/protocol.md §6 "环境") reach the commands Claude runs, and nothing else:
// not the Claude process, whose environment is the daemon's explicit allowlist (AGENTS.md). Claude Code sources the
// file named by CLAUDE_ENV_FILE before each Bash command (checked with the SDK's 0.3.327 binary, 2026-11-24). The file
// must not be inside Claude's own config directory, which Claude refuses: it goes in a private temporary directory,
// removed when this adapter exits.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const written = new WeakMap<object, string>();

/**
 * The file holding these variables for Claude's commands, written once per adapter (its session's variables do not
 * change), or undefined when there are none. Readable by this user only: the values can be secrets.
 */
export const sessionEnvFile = (
  owner: object,
  variables: Record<string, string> | undefined,
  root: string = tmpdir(),
): string | undefined => {
  const text = envFileText(variables ?? {});
  if (text === "") return undefined;
  const known = written.get(owner);
  if (known !== undefined) return known;
  const dir = mkdtempSync(join(root, "cycle-claude-env-"));
  const file = join(dir, "env.sh");
  writeFileSync(file, text, { mode: 0o600 });
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  written.set(owner, file);
  return file;
};

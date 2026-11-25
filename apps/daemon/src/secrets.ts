// The values of an environment's secrets (docs/protocol.md §6 "环境"): `<dataDir>/secrets.env` on the machine the daemon
// runs on, so a location reached over SSH keeps its own. Read each time they are used, so an edit applies without a
// restart; never written to the index, the log or a reply. A file others could read is closed to them first (the same
// care as `config.json`). Nothing here logs a name or a value.
import { readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseSecretsFile, VARIABLE_NAME } from "@cycle/protocol";
import { secureConfigFile } from "./config.ts";
import { providersPath, secretsPath } from "./data-dir.ts";

/** What the file holds: nothing when there is none or it cannot be read. */
export const readSecrets = async (dataDir: string): Promise<Record<string, string>> => {
  const path = secretsPath(dataDir);
  try {
    await secureConfigFile(path);
    return parseSecretsFile(await Bun.file(path).text());
  } catch {
    return {};
  }
};

/** The names the file does not give a value for (an empty value counts as given). */
export const missingSecrets = async (
  dataDir: string,
  names: readonly string[],
): Promise<string[]> => {
  if (names.length === 0) return [];
  const held = await readSecrets(dataDir);
  return names.filter((name) => held[name] === undefined);
};

/** Values shorter than this are not hidden from output: they would blank out ordinary words. */
const MIN_HIDDEN = 4;

/** The text with every secret's value taken out, for what a script printed before it is shown or told to an agent. */
export const withoutSecrets = (text: string, values: Iterable<string>): string => {
  let shown = text;
  for (const value of values)
    if (value.length >= MIN_HIDDEN) shown = shown.split(value).join("***");
  return shown;
};

/** The keys the file has a value for, in order. Names only. */
export const secretKeys = async (dataDir: string): Promise<string[]> =>
  Object.keys(await readSecrets(dataDir)).sort();

/** The key a line gives a value to, as `parseSecretsFile` reads it; undefined for a comment, a blank or a line it skips. */
const keyOfLine = (raw: string): string | undefined => {
  const line = raw.trim().replace(/^export\s+/, "");
  if (line === "" || line.startsWith("#")) return undefined;
  const equals = line.indexOf("=");
  if (equals === -1) return undefined;
  const name = line.slice(0, equals).trim();
  return VARIABLE_NAME.test(name) ? name : undefined;
};

/** Changes run one after another, each from what the one before left. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Rewrites the file keeping every other line as it is (comments and the person's own order too): `change` is given the
 * lines and returns the new ones. Written whole and renamed into place, mode 0600. A symlinked file is written through.
 */
const edit = (dataDir: string, change: (lines: string[]) => string[]): Promise<void> => {
  const run = queue.then(async () => {
    const path = await realpath(secretsPath(dataDir)).catch(() => secretsPath(dataDir));
    // Only a file that is not there is empty: any other failure stops the change rather than rewrite the file from nothing.
    const text = await Bun.file(path)
      .text()
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
    const lines = change(text === "" ? [] : text.replace(/\n$/, "").split(/\r?\n/));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, lines.length === 0 ? "" : `${lines.join("\n")}\n`, {
        mode: 0o600,
      });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  });
  queue = run.catch(() => undefined);
  return run;
};

/** A value as one line `parseSecretsFile` reads back as it is: always in single quotes, which it strips once and no more. */
const lineOf = (key: string, value: string): string => `${key}='${value}'`;

/** Adds the key or replaces its value, in the line it already has; a repeat of the key further down is dropped. */
export const setSecret = async (dataDir: string, key: string, value: string): Promise<void> => {
  if (!VARIABLE_NAME.test(key) || /[\n\r\0]/.test(value))
    throw new Error("Not a key and a one-line value");
  await edit(dataDir, (lines) => {
    let placed = false;
    const next: string[] = [];
    for (const line of lines) {
      if (keyOfLine(line) !== key) next.push(line);
      else if (!placed) {
        next.push(lineOf(key, value));
        placed = true;
      }
    }
    if (!placed) next.push(lineOf(key, value));
    return next;
  });
};

/** Removes the key's lines; a key that is not there leaves the file as it was. */
export const removeSecret = async (dataDir: string, key: string): Promise<void> => {
  await edit(dataDir, (lines) => lines.filter((line) => keyOfLine(line) !== key));
};

/**
 * The files an agent must not read: the secrets and the owner's provider keys, each by the path given and by where a
 * symlink leads (`setSecret` writes through one). Absolute paths, for the agents' own deny rules. Specific files, not
 * `dataDir`: Claude's home is a folder in it.
 */
export const protectedFiles = (dataDir: string): string[] => {
  const paths = new Set<string>();
  for (const path of [secretsPath(dataDir), providersPath(dataDir)]) {
    paths.add(path);
    try {
      paths.add(realpathSync(path));
    } catch {
      // Not there yet: the path itself is the rule, and stands for a file made later.
    }
  }
  return [...paths];
};

/** Whether the file holds a secret now, read at the start of a session. */
export const hasSecrets = (dataDir: string): boolean => {
  try {
    return Object.keys(parseSecretsFile(readFileSync(secretsPath(dataDir), "utf8"))).length > 0;
  } catch {
    return false;
  }
};

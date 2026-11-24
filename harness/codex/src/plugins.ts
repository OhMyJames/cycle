/**
 * Codex's plugins, driven through Codex's own command line (`codex plugin … --json`) in the daemon's private
 * `CODEX_HOME`. Codex installs them into its own cache and a session loads the enabled ones by itself. A marketplace's
 * format is never read here (docs/protocol.md §15); what comes back is in words any agent's plugins could be said in.
 *
 * `codex plugin` has no enable or disable: that switch is `[plugins."<id>"] enabled` in `$CODEX_HOME/config.toml`,
 * which is written here, and only there.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CodexPluginFailureReason =
  | "not_found"
  | "needs_command"
  | "unavailable"
  | "timeout"
  | "failed";

export class CodexPluginError extends Error {
  readonly reason: CodexPluginFailureReason;
  readonly detail: string;

  constructor(reason: CodexPluginFailureReason, detail: string) {
    super(detail === "" ? `codex plugin command failed (${reason})` : detail);
    this.name = "CodexPluginError";
    this.reason = reason;
    this.detail = detail;
  }
}

export type CodexPluginSource = {
  id: string;
  name: string;
  kind: "builtin" | "git" | "directory" | "url" | "other";
  location?: string;
  removable: boolean;
};

export type CodexPlugin = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  sourceId: string;
  installed: boolean;
  enabled?: boolean;
  scope?: "user" | "project";
};

export type CodexPluginSnapshot = {
  sources: CodexPluginSource[];
  installed: CodexPlugin[];
  available: CodexPlugin[];
};

/** What is shipped with Cycle: one marketplace of plugins, each in a directory of its own. */
/** Whether two locations are the same folder, whichever way each is written (a link, a trailing slash). */
const samePath = (a: string | undefined, b: string): boolean => {
  if (a === undefined) return false;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
};

export type CodexBuiltinBundle = {
  root: string;
  marketplace: string;
  plugins: { name: string; version: string; dir: string }[];
};

export type RunCodexPluginCommand = (
  command: readonly string[],
  options: { env: Record<string, string>; cwd: string; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

export type CodexPluginsOptions = {
  /** Resolves the `codex` binary on demand. */
  executable: () => string | undefined;
  /** Options put before every command (the ones every Codex command Cycle runs has). */
  args?: readonly string[];
  /** The whole environment given to `codex`, `CODEX_HOME` among it; never the daemon's own. */
  env: Record<string, string>;
  /** A folder that is no project. */
  cwd: string;
  run?: RunCodexPluginCommand;
};

const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 180_000;

const bunRun: RunCodexPluginCommand = async (command, { env, cwd, timeoutMs }) => {
  const proc = Bun.spawn([...command], {
    env,
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const classifyError = (detail: string): CodexPluginFailureReason => {
  if (/not found|no such|does not exist|unknown plugin|not available/i.test(detail))
    return "not_found";
  if (/unrecognized subcommand|unknown command/i.test(detail)) return "needs_command";
  return "failed";
};

/** A plugin id or location the person gave: never one `codex` would read as an option of its own. */
const arg = (value: string): string => {
  if (value.trim() === "" || value.startsWith("-")) {
    throw new CodexPluginError("not_found", "Not a plugin id or location");
  }
  return value;
};

const pluginOf = (raw: unknown, installed: boolean): CodexPlugin | undefined => {
  if (!isObject(raw)) return undefined;
  const id = text(raw.pluginId);
  const name = text(raw.name);
  if (id === undefined || name === undefined) return undefined;
  const version = text(raw.version);
  const description = text(raw.description);
  return {
    id,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(version !== undefined ? { version } : {}),
    sourceId: text(raw.marketplaceName) ?? "",
    installed,
    ...(installed ? { enabled: raw.enabled !== false, scope: "user" as const } : {}),
  };
};

const sourceOf = (raw: unknown): CodexPluginSource | undefined => {
  if (!isObject(raw)) return undefined;
  const name = text(raw.name);
  if (name === undefined) return undefined;
  const origin = isObject(raw.marketplaceSource) ? raw.marketplaceSource : {};
  const type = text(origin.sourceType);
  const location = text(origin.source) ?? text(raw.root);
  return {
    id: name,
    name,
    kind: type === "git" ? "git" : type === "local" ? "directory" : "other",
    ...(location !== undefined ? { location } : {}),
    removable: type === "git" || type === "local",
  };
};

/** `config.toml` with `[plugins."<id>"] enabled` set: the one line of one table, the rest left as it was. */
export const withPluginEnabled = (toml: string, id: string, enabled: boolean): string => {
  const header = `[plugins."${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  const value = `enabled = ${enabled}`;
  const lines = toml.split("\n");
  const at = lines.findIndex((line) => line.trim() === header);
  if (at === -1) {
    const body = toml.trimEnd();
    return `${body}${body === "" ? "" : "\n\n"}${header}\n${value}\n`;
  }
  let end = at + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? "")) end++;
  for (let i = at + 1; i < end; i++) {
    if (/^\s*enabled\s*=/.test(lines[i] ?? "")) {
      lines[i] = value;
      return lines.join("\n");
    }
  }
  lines.splice(at + 1, 0, value);
  return lines.join("\n");
};

export class CodexPlugins {
  readonly #executable: () => string | undefined;
  readonly #args: readonly string[];
  readonly #env: Record<string, string>;
  readonly #cwd: string;
  readonly #run: RunCodexPluginCommand;

  constructor(options: CodexPluginsOptions) {
    this.#executable = options.executable;
    this.#args = options.args ?? [];
    this.#env = { ...options.env };
    this.#cwd = options.cwd;
    this.#run = options.run ?? bunRun;
  }

  async #exec(args: readonly string[], timeoutMs: number): Promise<string> {
    const bin = this.#executable();
    if (!bin) throw new CodexPluginError("unavailable", "codex is not installed");
    mkdirSync(this.#cwd, { recursive: true });
    // `codex` refuses a CODEX_HOME that is not there.
    if (this.#env.CODEX_HOME) mkdirSync(this.#env.CODEX_HOME, { recursive: true, mode: 0o700 });
    let result: Awaited<ReturnType<RunCodexPluginCommand>>;
    try {
      result = await this.#run([bin, ...this.#args, "plugin", ...args], {
        env: this.#env,
        cwd: this.#cwd,
        timeoutMs,
      });
    } catch (error) {
      throw new CodexPluginError(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (result.timedOut) throw new CodexPluginError("timeout", `codex plugin ${args[0]} timed out`);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new CodexPluginError(classifyError(detail), detail);
    }
    return result.stdout;
  }

  async #json(args: readonly string[]): Promise<unknown> {
    const out = await this.#exec(args, READ_TIMEOUT_MS);
    try {
      return JSON.parse(out);
    } catch {
      throw new CodexPluginError("failed", out.trim().slice(0, 500));
    }
  }

  async #listing(): Promise<{ installed: CodexPlugin[]; available: CodexPlugin[] }> {
    const listing = await this.#json(["list", "--json"]);
    // An answer that is not a listing is a failure, never "nothing is installed".
    if (!isObject(listing) || !Array.isArray(listing.installed)) {
      throw new CodexPluginError("failed", "codex plugin list --json did not return a listing");
    }
    const installed: CodexPlugin[] = [];
    for (const raw of listing.installed) {
      const plugin = pluginOf(raw, true);
      if (plugin !== undefined && !installed.some((p) => p.id === plugin.id))
        installed.push(plugin);
    }
    const available: CodexPlugin[] = [];
    const byId = new Map(installed.map((plugin) => [plugin.id, plugin]));
    for (const raw of Array.isArray(listing.available) ? listing.available : []) {
      const plugin = pluginOf(raw, false);
      if (plugin === undefined || available.some((p) => p.id === plugin.id)) continue;
      available.push(byId.get(plugin.id) ?? plugin);
    }
    for (const plugin of installed) if (!available.includes(plugin)) available.push(plugin);
    return { installed, available };
  }

  async #sources(): Promise<CodexPluginSource[]> {
    const listing = await this.#json(["marketplace", "list", "--json"]);
    const raw =
      isObject(listing) && Array.isArray(listing.marketplaces) ? listing.marketplaces : [];
    return raw.map(sourceOf).filter((source): source is CodexPluginSource => source !== undefined);
  }

  async snapshot(): Promise<CodexPluginSnapshot> {
    const [{ installed, available }, sources] = await Promise.all([
      this.#listing(),
      this.#sources(),
    ]);
    return { sources, installed, available };
  }

  async installed(): Promise<CodexPlugin[]> {
    return (await this.#listing()).installed;
  }

  async install(id: string): Promise<void> {
    await this.#exec(["add", arg(id)], WRITE_TIMEOUT_MS);
  }

  async uninstall(id: string): Promise<void> {
    await this.#exec(["remove", arg(id)], WRITE_TIMEOUT_MS);
  }

  async update(id: string): Promise<{ updated: boolean }> {
    const before = (await this.installed()).find((plugin) => plugin.id === id);
    // `add` of what is installed installs what its marketplace has now.
    await this.#exec(["add", arg(id)], WRITE_TIMEOUT_MS);
    const after = (await this.installed()).find((plugin) => plugin.id === id);
    return { updated: before?.version !== after?.version };
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    arg(id);
    const home = this.#env.CODEX_HOME;
    if (!home) throw new CodexPluginError("unavailable", "CODEX_HOME is not set");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = join(home, "config.toml");
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    writeFileSync(file, withPluginEnabled(current, id, enabled));
  }

  /** Returns the id (the name) of the marketplace that was added. */
  async addSource(location: string): Promise<string> {
    const before = new Set((await this.#sources()).map((source) => source.id));
    await this.#exec(["marketplace", "add", arg(location)], WRITE_TIMEOUT_MS);
    const added = (await this.#sources()).find((source) => !before.has(source.id));
    if (added === undefined) throw new CodexPluginError("failed", "No marketplace was added");
    return added.id;
  }

  async removeSource(id: string): Promise<void> {
    await this.#exec(["marketplace", "remove", arg(id)], WRITE_TIMEOUT_MS);
  }

  async refreshSource(id?: string): Promise<void> {
    await this.#exec(
      ["marketplace", "upgrade", ...(id !== undefined ? [arg(id)] : [])],
      WRITE_TIMEOUT_MS,
    );
  }

  /**
   * What ships with Cycle is installed, and installed again when what ships is newer. What the person has done to an
   * installed one (turned it off) is left as it is.
   */
  async ensureBuiltin(bundle: CodexBuiltinBundle): Promise<void> {
    const sources = await this.#sources();
    const have = sources.find((source) => source.id === bundle.marketplace);
    const same = have !== undefined && samePath(have.location, bundle.root);
    const turnedOff = new Set(
      same ? [] : (await this.installed()).filter((p) => p.enabled === false).map((p) => p.id),
    );
    if (have !== undefined && !same) await this.removeSource(have.id);
    if (!same) await this.#exec(["marketplace", "add", bundle.root], WRITE_TIMEOUT_MS);
    const installed = await this.installed();
    for (const plugin of bundle.plugins) {
      const id = `${plugin.name}@${bundle.marketplace}`;
      const found = installed.find((p) => p.id === id);
      if (found !== undefined && found.version === plugin.version) continue;
      await this.install(id);
      // `plugin add` turns it on: what the person turned off stays off.
      if (found?.enabled === false || (found === undefined && turnedOff.has(id))) {
        await this.setEnabled(id, false);
      }
    }
  }
}

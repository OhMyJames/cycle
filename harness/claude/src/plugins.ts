/**
 * Claude Code's plugins, driven through Claude's own command line (`claude plugin … --json`): Claude installs,
 * enables and updates them in its configuration directory, and a session loads the enabled ones by itself. Nothing
 * of a marketplace's format is read here (docs/protocol.md §15, note 2026-11-23-plugins-are-the-agents-their-mcp-is-cycles).
 *
 * What comes back is in words any agent's plugins could be said in; Claude's own shapes stop at this file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export type ClaudePluginFailureReason =
  | "not_found"
  | "needs_command"
  | "unavailable"
  | "timeout"
  | "failed";

/** Claude's command line did not do it. `detail` is what it said, for a person. */
export class ClaudePluginError extends Error {
  readonly reason: ClaudePluginFailureReason;
  readonly detail: string;
  constructor(reason: ClaudePluginFailureReason, detail: string) {
    super(detail === "" ? `Claude's plugin command failed (${reason})` : detail);
    this.name = "ClaudePluginError";
    this.reason = reason;
    this.detail = detail;
  }
}

export type ClaudePluginSource = {
  id: string;
  name: string;
  kind: "builtin" | "git" | "directory" | "url" | "other";
  location?: string;
  removable: boolean;
};

export type ClaudePluginServer = {
  /** As the plugin names it. */
  name: string;
  /** As a Claude session names it: what a server given to the session must be called to stand in for it. */
  agentName: string;
  /**
   * Present for a plain http server: one something other than Claude can reach for it. `headers` are as the plugin
   * wrote them, a `${NAME}` left as it is.
   */
  http?: { url: string; headers: Record<string, string> };
};

export type ClaudePlugin = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  sourceId: string;
  installed: boolean;
  enabled?: boolean;
  scope?: "user" | "project";
  contents?: {
    skills: number;
    commands: number;
    agents: number;
    hooks: number;
    mcpServers: number;
  };
  servers?: ClaudePluginServer[];
};

/** How a command is run: replaced in tests, and where an agent runs somewhere else. */
export type RunCommand = (
  command: readonly string[],
  options: { env: Record<string, string>; cwd: string; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; timedOut: boolean }>;

export type ClaudePluginsOptions = {
  /** The Claude Code binary. Absent: the one the SDK comes with. */
  executable?: string | undefined;
  /** The whole environment of the command: what a Claude session of this daemon gets, and nothing inherited. */
  env: Record<string, string>;
  /** Where it runs: a folder with no project in it, so nothing is read as a project's. */
  cwd: string;
  run?: RunCommand;
};

/** A listing answers in a second; fetching a repository is what takes long. */
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 180_000;

const bunRun: RunCommand = async (command, { env, cwd, timeoutMs }) => {
  const proc = Bun.spawn([...command], {
    env,
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    // What it says for a person is also in its JSON; the rest could name a path or a key.
    stderr: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout, timedOut };
  } finally {
    clearTimeout(timer);
  }
};

/** The binary the SDK comes with for this machine, when it can be found from source. */
export const bundledClaudeExecutable = (): string | undefined => {
  try {
    const fromHere = createRequire(import.meta.url);
    const fromSdk = createRequire(fromHere.resolve("@anthropic-ai/claude-agent-sdk"));
    const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    for (const name of process.platform === "linux" ? [`${base}-musl`, base] : [base]) {
      try {
        const path = join(fromSdk.resolve(`${name}/package.json`), "..", "claude");
        if (existsSync(path)) return path;
      } catch {
        // Not this one.
      }
    }
  } catch {
    // No SDK to be found from here (the single-file executable): the caller names the binary.
  }
  return undefined;
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** `name@source`: the source is after the last `@` (a name can be scoped). */
const splitId = (id: string): { name: string; sourceId: string } => {
  const at = id.lastIndexOf("@");
  return at <= 0
    ? { name: id, sourceId: "" }
    : { name: id.slice(0, at), sourceId: id.slice(at + 1) };
};

const countFiles = (dir: string, match: (name: string) => boolean, depth = 3): number => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of entries) {
    const path = join(dir, name);
    let directory = false;
    try {
      directory = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (directory) count += depth > 0 ? countFiles(path, match, depth - 1) : 0;
    else if (match(name)) count += 1;
  }
  return count;
};

const countHooks = (root: string): number => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8"));
    const hooks = isObject(parsed) && isObject(parsed.hooks) ? parsed.hooks : {};
    let count = 0;
    for (const matchers of Object.values(hooks)) {
      for (const matcher of Array.isArray(matchers) ? matchers : []) {
        count += isObject(matcher) && Array.isArray(matcher.hooks) ? matcher.hooks.length : 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
};

/** What an installed plugin's folder holds, by the places Claude looks in by default. */
const contentsOf = (
  root: string | undefined,
  mcpServers: number,
): NonNullable<ClaudePlugin["contents"]> => {
  if (root === undefined) return { skills: 0, commands: 0, agents: 0, hooks: 0, mcpServers };
  return {
    skills: countFiles(join(root, "skills"), (name) => name === "SKILL.md"),
    commands: countFiles(join(root, "commands"), (name) => name.endsWith(".md")),
    agents: countFiles(join(root, "agents"), (name) => name.endsWith(".md")),
    hooks: countHooks(root),
    mcpServers,
  };
};

const serversOf = (pluginName: string, declared: unknown): ClaudePluginServer[] => {
  if (!isObject(declared)) return [];
  return Object.entries(declared).map(([name, config]) => {
    const server: ClaudePluginServer = { name, agentName: `plugin:${pluginName}:${name}` };
    if (!isObject(config) || config.type !== "http") return server;
    const url = text(config.url);
    // An address with a variable in it is one only Claude can work out.
    if (url === undefined || url.includes("${")) return server;
    const headers: Record<string, string> = {};
    for (const [header, value] of Object.entries(isObject(config.headers) ? config.headers : {})) {
      if (typeof value === "string") headers[header] = value;
    }
    return { ...server, http: { url, headers } };
  });
};

/** What the plugin says of itself, for one its source no longer lists. */
const descriptionOf = (root: string | undefined): string | undefined => {
  if (root === undefined) return undefined;
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"),
    );
    return isObject(manifest) ? text(manifest.description) : undefined;
  } catch {
    return undefined;
  }
};

const installedOf = (raw: unknown): ClaudePlugin | undefined => {
  if (!isObject(raw)) return undefined;
  const id = text(raw.id);
  if (id === undefined) return undefined;
  const { name, sourceId } = splitId(id);
  const servers = serversOf(name, raw.mcpServers);
  const root = text(raw.readFromFolder) ?? text(raw.installPath);
  const version = text(raw.version);
  const description = descriptionOf(root);
  return {
    id,
    name,
    sourceId,
    installed: true,
    ...(description !== undefined ? { description } : {}),
    enabled: raw.enabled === true,
    scope: raw.scope === "project" || raw.scope === "local" ? "project" : "user",
    ...(version !== undefined ? { version } : {}),
    contents: contentsOf(root, servers.length),
    servers,
  };
};

const availableOf = (raw: unknown): ClaudePlugin | undefined => {
  if (!isObject(raw)) return undefined;
  const id = text(raw.pluginId);
  if (id === undefined) return undefined;
  const split = splitId(id);
  const description = text(raw.description);
  const version = text(raw.version);
  return {
    id,
    name: text(raw.name) ?? split.name,
    sourceId: text(raw.marketplaceName) ?? split.sourceId,
    installed: false,
    ...(description !== undefined ? { description } : {}),
    ...(version !== undefined ? { version } : {}),
  };
};

const sourceOf = (raw: unknown): ClaudePluginSource | undefined => {
  if (!isObject(raw)) return undefined;
  const name = text(raw.name);
  if (name === undefined) return undefined;
  const from = text(raw.source);
  const kind: ClaudePluginSource["kind"] =
    from === "directory" || from === "file"
      ? "directory"
      : from === "github" || from === "git"
        ? "git"
        : from === "url"
          ? "url"
          : "other";
  const location = text(raw.repo) ?? text(raw.url) ?? text(raw.path);
  return { id: name, name, kind, removable: true, ...(location !== undefined ? { location } : {}) };
};

const reasonOf = (failureCode: unknown): ClaudePluginFailureReason => {
  const code = typeof failureCode === "string" ? failureCode : "";
  if (["not_found", "not_installed", "invalid_source", "not_configured"].includes(code)) {
    return "not_found";
  }
  if (code.includes("command")) return "needs_command";
  return "failed";
};

/** Everything Claude knows of its plugins at one moment. */
export type ClaudePluginSnapshot = {
  sources: ClaudePluginSource[];
  installed: ClaudePlugin[];
  /** What can be installed, the installed ones among them marked as such. */
  available: ClaudePlugin[];
};

export class ClaudePlugins {
  readonly #executable: string | undefined;
  readonly #env: Record<string, string>;
  readonly #cwd: string;
  readonly #run: RunCommand;

  constructor(options: ClaudePluginsOptions) {
    this.#executable = options.executable ?? bundledClaudeExecutable();
    this.#env = options.env;
    this.#cwd = options.cwd;
    this.#run = options.run ?? bunRun;
  }

  async #exec(args: readonly string[], timeoutMs: number): Promise<string> {
    if (this.#executable === undefined) throw new ClaudePluginError("unavailable", "");
    let result: Awaited<ReturnType<RunCommand>>;
    try {
      mkdirSync(this.#cwd, { recursive: true });
      result = await this.#run([this.#executable, "plugin", ...args], {
        env: this.#env,
        cwd: this.#cwd,
        timeoutMs,
      });
    } catch {
      throw new ClaudePluginError("unavailable", "");
    }
    if (result.timedOut) throw new ClaudePluginError("timeout", "");
    return result.stdout;
  }

  /** A listing: the whole of stdout is one JSON value. */
  async #read(args: readonly string[]): Promise<unknown> {
    const out = await this.#exec([...args, "--json"], READ_TIMEOUT_MS);
    try {
      return JSON.parse(out);
    } catch {
      throw new ClaudePluginError("failed", out.trim().slice(0, 500));
    }
  }

  /** A change: the last line of stdout is its result. */
  async #write(args: readonly string[]): Promise<Json> {
    // Before a `--`: after it, it would be read as one more thing the person typed.
    const end = args.indexOf("--");
    const asked =
      end === -1 ? [...args, "--json"] : [...args.slice(0, end), "--json", ...args.slice(end)];
    const out = await this.#exec(asked, WRITE_TIMEOUT_MS);
    const last = out.trim().split("\n").at(-1) ?? "";
    let result: unknown;
    try {
      result = JSON.parse(last);
    } catch {
      throw new ClaudePluginError("failed", out.trim().slice(0, 500));
    }
    if (!isObject(result)) throw new ClaudePluginError("failed", "");
    if (result.outcome !== "ok") {
      throw new ClaudePluginError(reasonOf(result.failureCode), text(result.message) ?? "");
    }
    return result;
  }

  async snapshot(): Promise<ClaudePluginSnapshot> {
    const [listing, marketplaces] = await Promise.all([
      this.#read(["list", "--available"]),
      this.#read(["marketplace", "list"]),
    ]);
    // An answer that is not a listing is a failure, never "nothing is installed": what stands for the installed ones
    // (their connectors, with the sign-ins) would be taken away on the strength of it.
    if (!isObject(listing) || !Array.isArray(listing.installed) || !Array.isArray(marketplaces)) {
      throw new ClaudePluginError("failed", "");
    }
    const sources: ClaudePluginSource[] = [];
    for (const raw of Array.isArray(marketplaces) ? marketplaces : []) {
      const source = sourceOf(raw);
      if (source !== undefined) sources.push(source);
    }
    const installed: ClaudePlugin[] = [];
    const rawInstalled =
      isObject(listing) && Array.isArray(listing.installed) ? listing.installed : [];
    for (const raw of rawInstalled) {
      const plugin = installedOf(raw);
      if (plugin !== undefined) installed.push(plugin);
    }
    const byId = new Map(installed.map((plugin) => [plugin.id, plugin]));
    const available: ClaudePlugin[] = [];
    const seen = new Set<string>();
    const rawAvailable =
      isObject(listing) && Array.isArray(listing.available) ? listing.available : [];
    for (const raw of rawAvailable) {
      const plugin = availableOf(raw);
      if (plugin === undefined || seen.has(plugin.id)) continue;
      seen.add(plugin.id);
      const mine = byId.get(plugin.id);
      if (mine === undefined) {
        available.push(plugin);
        continue;
      }
      // What the source says of it is said of the installed one too.
      if (mine.description === undefined && plugin.description !== undefined) {
        mine.description = plugin.description;
      }
      mine.name = plugin.name;
      available.push(mine);
    }
    // Claude lists an installed plugin apart from what can be installed: it is still one of its source's.
    for (const plugin of installed) if (!seen.has(plugin.id)) available.push(plugin);
    // A source nobody added is the directory Claude comes with.
    const known = new Set(sources.map((source) => source.id));
    for (const plugin of available) {
      if (plugin.sourceId === "" || known.has(plugin.sourceId)) continue;
      known.add(plugin.sourceId);
      sources.unshift({
        id: plugin.sourceId,
        name: plugin.sourceId,
        kind: "builtin",
        removable: false,
      });
    }
    return { sources, installed, available };
  }

  async install(id: string): Promise<void> {
    // No `-y`: a source that wants its own command run to fetch a plugin is refused, not agreed to for the person.
    await this.#write(["install", id, "--scope", "user"]);
  }

  async uninstall(id: string): Promise<void> {
    await this.#write(["uninstall", id, "--scope", "user"]);
  }

  async update(id: string): Promise<{ updated: boolean }> {
    const result = await this.#write(["update", id, "--scope", "user"]);
    return {
      updated: result.updateOutcome !== "up_to_date" && result.oldVersion !== result.newVersion,
    };
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.#write([enabled ? "enable" : "disable", id, "--scope", "user"]);
  }

  /** Returns the id of the source that was added. */
  async addSource(location: string): Promise<string> {
    // `--` so that what a person typed is never read as an option.
    const result = await this.#write(["marketplace", "add", "--scope", "user", "--", location]);
    const name = text(result.marketplace);
    if (name === undefined) throw new ClaudePluginError("failed", "");
    return name;
  }

  async removeSource(id: string): Promise<void> {
    await this.#write(["marketplace", "remove", "--", id]);
  }

  async refreshSource(id?: string): Promise<void> {
    await this.#write(["marketplace", "update", ...(id !== undefined ? ["--", id] : [])]);
  }
}

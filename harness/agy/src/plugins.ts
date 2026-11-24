/**
 * Antigravity (`agy`) plugins, driven through `agy plugin ...` in the daemon's isolated agy HOME
 * and a non-project working directory. `agy` 1.5.15 exposes `list --json`, `install`, `uninstall`,
 * `enable`, and `disable`, but no machine-readable catalog or marketplace source management CLI;
 * unsupported operations fail with `reason: "unavailable"`.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { V1McpServer } from "./mcp.ts";

export type AgyPluginFailureReason =
  | "not_found"
  | "needs_command"
  | "unavailable"
  | "timeout"
  | "failed";

export class AgyPluginError extends Error {
  readonly reason: AgyPluginFailureReason;
  readonly detail: string;

  constructor(reason: AgyPluginFailureReason, detail: string) {
    super(detail === "" ? `agy plugin command failed (${reason})` : detail);
    this.name = "AgyPluginError";
    this.reason = reason;
    this.detail = detail;
  }
}

export type AgyPluginServer = {
  name: string;
  agentName: string;
};

export type AgyPlugin = {
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
  servers?: AgyPluginServer[];
};

export type AgyPluginSnapshot = {
  sources: never[];
  installed: AgyPlugin[];
  available: never[];
};

export type RunAgyPluginCommand = (
  command: readonly string[],
  options: { env: Record<string, string>; cwd: string; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

export type AgyPluginsOptions = {
  /** Resolves the `agy` binary on demand (so an agy installed after daemon start is found). */
  executable: () => string | undefined;
  /** Explicit environment given to `agy` (isolated HOME, never inheriting daemon env). */
  env: Record<string, string>;
  /** Non-project directory used as `cwd` so no project plugins are picked up accidentally. */
  cwd: string;
  run?: RunAgyPluginCommand;
};

const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 180_000;
/** What a plugin's `mcp_config.json` writes for its own directory (not a template of ours). */
const PLUGIN_ROOT_TOKEN = ["$", "{PLUGIN_ROOT}"].join("");
/** Listing plugins as a session starts: short, a slow `agy` must not hold the session up. */
const STDIO_LIST_TIMEOUT_MS = 5_000;

const bunRun: RunAgyPluginCommand = async (command, { env, cwd, timeoutMs }) => {
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

const countArrayOrNumber = (value: unknown): number => {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (isObject(value)) return Object.keys(value).length;
  return 0;
};

const readJsonFile = (filePath: string): Json | undefined => {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const manifestDescription = (pluginPath: string | undefined): string | undefined => {
  if (!pluginPath) return undefined;
  for (const rel of [
    ".antigravity-plugin/plugin.json",
    ".gemini-plugin/plugin.json",
    "plugin.json",
  ]) {
    const json = readJsonFile(join(pluginPath, rel));
    const desc = text(json?.description);
    if (desc !== undefined) return desc;
  }
  return undefined;
};

const readDeclaredServerNames = (pluginPath: string | undefined): string[] => {
  if (!pluginPath) return [];
  const mcp = readJsonFile(join(pluginPath, "mcp_config.json"));
  const map = isObject(mcp?.mcpServers) ? mcp.mcpServers : undefined;
  return map ? Object.keys(map) : [];
};

const parseInstalledEntry = (raw: unknown): AgyPlugin | undefined => {
  if (!isObject(raw)) return undefined;
  const name = text(raw.name);
  if (!name) return undefined;
  const pluginPath = text(raw.path);
  const description = text(raw.description) ?? manifestDescription(pluginPath);
  const version = text(raw.version);
  const sourceId = text(raw.source) ?? "local";
  const enabled = raw.enabled === true;

  const declaredServers = readDeclaredServerNames(pluginPath);
  const jsonServerCount = countArrayOrNumber(raw.mcpServers);
  const mcpCount = Math.max(declaredServers.length, jsonServerCount);

  const serverNames =
    declaredServers.length > 0
      ? declaredServers
      : Array.isArray(raw.mcpServers)
        ? raw.mcpServers.filter((s): s is string => typeof s === "string" && s !== "")
        : isObject(raw.mcpServers)
          ? Object.keys(raw.mcpServers)
          : [];

  const servers: AgyPluginServer[] = serverNames.map((serverName) => ({
    name: serverName,
    agentName: serverName,
  }));

  return {
    id: name,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(version !== undefined ? { version } : {}),
    sourceId,
    installed: true,
    enabled,
    scope: "user",
    contents: {
      skills: countArrayOrNumber(raw.skills),
      commands: countArrayOrNumber(raw.commands),
      agents: countArrayOrNumber(raw.agents),
      hooks: countArrayOrNumber(raw.hooks),
      mcpServers: mcpCount,
    },
    ...(servers.length > 0 ? { servers } : {}),
  };
};

const classifyError = (detail: string): AgyPluginFailureReason => {
  if (/not found|no such plugin|does not exist/i.test(detail)) return "not_found";
  if (/unknown command|unrecognized/i.test(detail)) return "needs_command";
  return "failed";
};

/** A plugin name or location the person gave: never one `agy` would read as an option of its own. */
const pluginArg = (id: string): string => {
  if (id.trim() === "" || id.startsWith("-")) {
    throw new AgyPluginError("not_found", "Not a plugin name or location");
  }
  return id;
};

/** What is shipped with Cycle: plugins, each in a directory of its own (agy has no marketplace to add). */
export type AgyBuiltinBundle = {
  root: string;
  marketplace: string;
  plugins: { name: string; version: string; dir: string }[];
};

export class AgyPlugins {
  readonly #executable: () => string | undefined;
  readonly #env: Record<string, string>;
  readonly #cwd: string;
  readonly #run: RunAgyPluginCommand;

  constructor(options: AgyPluginsOptions) {
    this.#executable = options.executable;
    this.#env = { ...options.env };
    this.#cwd = options.cwd;
    this.#run = options.run ?? bunRun;
  }

  async #exec(args: readonly string[], timeoutMs: number): Promise<string> {
    const bin = this.#executable();
    if (!bin) {
      throw new AgyPluginError("unavailable", "agy is not installed or is below 1.5.10");
    }
    mkdirSync(this.#cwd, { recursive: true });
    if (this.#env.HOME) {
      mkdirSync(this.#env.HOME, { recursive: true, mode: 0o700 });
    }
    let result: { code: number | null; stdout: string; stderr: string; timedOut: boolean };
    try {
      result = await this.#run([bin, "plugin", ...args], {
        env: this.#env,
        cwd: this.#cwd,
        timeoutMs,
      });
    } catch (error) {
      throw new AgyPluginError(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (result.timedOut) {
      throw new AgyPluginError("timeout", `agy plugin ${args[0] ?? ""} timed out`);
    }
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new AgyPluginError(classifyError(detail), detail);
    }
    return result.stdout;
  }

  async installed(): Promise<AgyPlugin[]> {
    const stdout = await this.#exec(["list", "--json"], READ_TIMEOUT_MS);
    const trimmed = stdout.trim();
    if (trimmed === "") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new AgyPluginError("failed", "agy plugin list --json returned invalid JSON");
    }
    if (!Array.isArray(parsed)) {
      throw new AgyPluginError("failed", "agy plugin list --json did not return an array");
    }
    return parsed.map(parseInstalledEntry).filter((item): item is AgyPlugin => item !== undefined);
  }

  /**
   * The stdio MCP servers of the enabled plugins, as `session/new` takes them. `agy acp` does not start a plugin's own
   * MCP servers (its worker logs "Not reloading plugin MCP servers: cannot get the signed-in user", 1.5.16), so the
   * adapter hands them over itself. A server is named `<plugin>_<server>`, as `agy` names it, so the plugin's rules
   * and skills still find its tools. `${PLUGIN_ROOT}` is the plugin's directory. HTTP servers are not here: those are
   * Cycle's connectors. Never throws: a plugin that cannot be read just brings no server.
   */
  async stdioServers(timeoutMs = STDIO_LIST_TIMEOUT_MS): Promise<V1McpServer[]> {
    let stdout: string;
    try {
      stdout = await this.#exec(["list", "--json"], timeoutMs);
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: V1McpServer[] = [];
    for (const raw of parsed) {
      if (!isObject(raw) || raw.enabled !== true) continue;
      const plugin = text(raw.name);
      const root = text(raw.path);
      if (plugin === undefined || root === undefined) continue;
      const servers = readJsonFile(join(root, "mcp_config.json"))?.mcpServers;
      if (!isObject(servers)) continue;
      for (const [name, def] of Object.entries(servers)) {
        if (!isObject(def) || typeof def.command !== "string" || def.command === "") continue;
        const fill = (value: string) => value.replaceAll(PLUGIN_ROOT_TOKEN, root);
        const args = Array.isArray(def.args)
          ? def.args.filter((a): a is string => typeof a === "string").map(fill)
          : [];
        const env = isObject(def.env)
          ? Object.entries(def.env).flatMap(([key, value]) =>
              typeof value === "string" ? [{ name: key, value: fill(value) }] : [],
            )
          : [];
        out.push({ name: `${plugin}_${name}`, command: fill(def.command), args, env });
      }
    }
    return out;
  }

  async snapshot(): Promise<AgyPluginSnapshot> {
    const installed = await this.installed();
    return { sources: [], installed, available: [] };
  }

  async install(id: string): Promise<void> {
    await this.#exec(["install", pluginArg(id)], WRITE_TIMEOUT_MS);
  }

  async uninstall(id: string): Promise<void> {
    await this.#exec(["uninstall", pluginArg(id)], WRITE_TIMEOUT_MS);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.#exec([enabled ? "enable" : "disable", pluginArg(id)], READ_TIMEOUT_MS);
  }

  async update(_id: string): Promise<{ updated: boolean }> {
    throw new AgyPluginError("unavailable", "agy does not support updating plugins via CLI");
  }

  async addSource(_location: string): Promise<string> {
    throw new AgyPluginError("unavailable", "agy does not support managing plugin sources via CLI");
  }

  async removeSource(_id: string): Promise<void> {
    throw new AgyPluginError("unavailable", "agy does not support managing plugin sources via CLI");
  }

  async refreshSource(_id?: string): Promise<void> {
    throw new AgyPluginError(
      "unavailable",
      "agy does not support refreshing plugin sources via CLI",
    );
  }

  /**
   * What ships with Cycle is installed from its directory, and installed again (agy replaces it) when what ships is
   * newer. What the person has done to an installed one (turned it off) is left as it is, also across a replacement.
   */
  async ensureBuiltin(bundle: AgyBuiltinBundle): Promise<void> {
    const installed = await this.installed();
    for (const plugin of bundle.plugins) {
      const found = installed.find((p) => p.name === plugin.name);
      if (found !== undefined && found.version === plugin.version) continue;
      await this.install(plugin.dir);
      if (found?.enabled === false) await this.setEnabled(plugin.name, false);
    }
  }
}

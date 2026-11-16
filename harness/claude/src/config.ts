/**
 * Cycle's own configuration of Claude Code, kept in `CYCLE_HOME/claude.json`, and what it becomes
 * for a process: a settings file, the servers given over its pipe, and the tools it may not use.
 * Pure: the harness reads and writes it through `ClaudeConfigBook`.
 * Why: .agents/notes/2026-11-16-cycle-keeps-claude-code-s-configuration.md
 */
import {
  HOOK_EVENTS,
  type HookInfo,
  type HookSettings,
  type McpServerInfo,
  type McpServerInput,
  type McpTransport,
} from "@cycle/protocol";

/** A server of Cycle's own, environment values included. */
export interface StoredServer {
  transport:
    | { kind: "stdio"; command: string; args: string[]; env: Record<string, string> }
    | { kind: "http"; url: string; bearerTokenEnvVar: string | null };
  enabled: boolean;
}

/** `claude.json`. A key not there reads as its empty value. */
export interface ClaudeConfig {
  mcpServers: Record<string, StoredServer>;
  /** The owner's servers turned off, by name. */
  ownerServersOff: string[];
  /** Tools turned off, as Claude Code names them: `mcp__<server>__<tool>`. */
  toolsOff: string[];
  /** Plugins turned on or off by id, the owner's and Cycle's alike. One not here is on. */
  plugins: Record<string, boolean>;
  skillsOff: string[];
  hooks: HookInfo[];
  /** The owner's own hooks run. */
  ownerHooks: boolean;
  /** The owner's own user settings are read. */
  ownerSettings: boolean;
}

/** Where `claude.json` is kept. The daemon holds the file; the harness only asks. */
export interface ClaudeConfigBook {
  read(): ClaudeConfig;
  write(config: ClaudeConfig): Promise<void>;
}

export class ConfigError extends Error {}

export function emptyConfig(): ClaudeConfig {
  return {
    mcpServers: {},
    ownerServersOff: [],
    toolsOff: [],
    plugins: {},
    skillsOff: [],
    hooks: [],
    ownerHooks: true,
    ownerSettings: true,
  };
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SERVERS = 100;
const MAX_HOOKS = 100;
const MAX_VALUE = 4096;
const MAX_COMMAND = 4096;
const MAX_TIMEOUT = 3600;

/** The tool's name in Claude Code. */
export function toolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Checks a server the owner gives, keeping a stored environment value the page sent as null. */
export function toStoredServer(
  input: McpServerInput,
  stored: StoredServer | undefined,
): StoredServer {
  if (!SERVER_NAME.test(input.name)) {
    throw new ConfigError("A server's name is letters, digits, `-` and `_`, at most 64.");
  }
  const { transport } = input;
  const enabled = stored?.enabled ?? true;
  if (transport.kind === "http") {
    let url: URL;
    try {
      url = new URL(transport.url);
    } catch {
      throw new ConfigError("The server's address is not a URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConfigError("The server's address begins with http:// or https://.");
    }
    const variable = transport.bearerTokenEnvVar?.trim() || null;
    if (variable !== null && !VARIABLE.test(variable)) {
      throw new ConfigError(`"${variable.slice(0, 60)}" is not a variable's name.`);
    }
    return { transport: { kind: "http", url: url.href, bearerTokenEnvVar: variable }, enabled };
  }
  const command = transport.command.trim();
  if (!command) throw new ConfigError("A stdio server needs a command.");
  const before = stored?.transport.kind === "stdio" ? stored.transport.env : {};
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(transport.env)) {
    if (!VARIABLE.test(name))
      throw new ConfigError(`"${name.slice(0, 60)}" is not a variable's name.`);
    const kept = value ?? before[name];
    if (kept === undefined) throw new ConfigError(`${name} needs a value.`);
    if (kept.length > MAX_VALUE) throw new ConfigError(`${name}'s value is too long.`);
    env[name] = kept;
  }
  return { transport: { kind: "stdio", command, args: transport.args, env }, enabled };
}

/** Puts a server in, checking it fits beside the owner's own. */
export function putServer(
  config: ClaudeConfig,
  input: McpServerInput,
  ownerNames: string[],
): ClaudeConfig {
  const stored = config.mcpServers[input.name];
  // `deniedMcpServers` goes by name: one of Cycle's would be turned off with the owner's.
  if (!stored && ownerNames.includes(input.name)) {
    throw new ConfigError(`Claude Code already has a server named ${input.name}.`);
  }
  if (!stored && Object.keys(config.mcpServers).length >= MAX_SERVERS) {
    throw new ConfigError(`At most ${MAX_SERVERS} servers.`);
  }
  return {
    ...config,
    mcpServers: { ...config.mcpServers, [input.name]: toStoredServer(input, stored) },
  };
}

function toggle(list: string[], item: string, on: boolean): string[] {
  const rest = list.filter((each) => each !== item);
  return on ? rest : [...rest, item];
}

/** Turns a server on or off: Cycle's own in its entry, the owner's by name. */
export function enableServer(config: ClaudeConfig, name: string, enabled: boolean): ClaudeConfig {
  const stored = config.mcpServers[name];
  if (stored) {
    return { ...config, mcpServers: { ...config.mcpServers, [name]: { ...stored, enabled } } };
  }
  if (name.startsWith("plugin:")) {
    throw new ConfigError("A plugin's server is turned off with its plugin.");
  }
  return { ...config, ownerServersOff: toggle(config.ownerServersOff, name, enabled) };
}

export function enableTool(
  config: ClaudeConfig,
  server: string,
  tool: string,
  enabled: boolean,
): ClaudeConfig {
  return { ...config, toolsOff: toggle(config.toolsOff, toolName(server, tool), enabled) };
}

export function removeServer(config: ClaudeConfig, name: string): ClaudeConfig {
  if (!config.mcpServers[name]) {
    throw new ConfigError(`${name} is Claude Code's own: turn it off here, or remove it there.`);
  }
  const { [name]: _gone, ...rest } = config.mcpServers;
  const prefix = toolName(name, "");
  return {
    ...config,
    mcpServers: rest,
    toolsOff: config.toolsOff.filter((each) => !each.startsWith(prefix)),
  };
}

export function enableSkill(config: ClaudeConfig, name: string, enabled: boolean): ClaudeConfig {
  return { ...config, skillsOff: toggle(config.skillsOff, name, enabled) };
}

export function enablePlugin(config: ClaudeConfig, id: string, enabled: boolean): ClaudeConfig {
  return { ...config, plugins: { ...config.plugins, [id]: enabled } };
}

/** Checks hooks the owner gives. Each keeps its id, or is given one. */
export function setHooks(
  config: ClaudeConfig,
  settings: HookSettings,
  newId: () => string,
): ClaudeConfig {
  if (settings.hooks.length > MAX_HOOKS) throw new ConfigError(`At most ${MAX_HOOKS} hooks.`);
  const hooks = settings.hooks.map((hook): HookInfo => {
    if (!(HOOK_EVENTS as readonly string[]).includes(hook.event)) {
      throw new ConfigError(
        `"${hook.event.slice(0, 40)}" is not an event Claude Code runs hooks on.`,
      );
    }
    const command = hook.command.trim();
    if (!command) throw new ConfigError("A hook needs a command.");
    if (command.length > MAX_COMMAND) throw new ConfigError("A hook's command is too long.");
    const timeout = hook.timeout;
    if (timeout !== null && (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT)) {
      throw new ConfigError(`A hook's time is a whole number of seconds up to ${MAX_TIMEOUT}.`);
    }
    return {
      id: hook.id || newId(),
      event: hook.event,
      matcher: hook.matcher.trim(),
      command,
      timeout,
    };
  });
  return {
    ...config,
    hooks,
    ownerHooks: settings.ownerHooks,
    ownerSettings: settings.ownerSettings,
  };
}

export function toHookSettings(config: ClaudeConfig): HookSettings {
  return {
    hooks: config.hooks,
    ownerHooks: config.ownerHooks,
    ownerSettings: config.ownerSettings,
  };
}

/** Claude Code's own sandbox for commands, as the SDK would have merged its `sandbox` option. */
export interface CommandSandbox {
  enabled: boolean;
  autoAllowBashIfSandboxed: boolean;
}

/**
 * The flag layer Claude Code is given, in its settings shape. With `sandbox`, it carries the mode's
 * command sandbox too: the SDK refuses its `sandbox` option beside a settings file.
 */
export function flagSettings(
  config: ClaudeConfig,
  sandbox?: CommandSandbox,
): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const hook of config.hooks) {
    (hooks[hook.event] ??= []).push({
      ...(hook.matcher ? { matcher: hook.matcher } : {}),
      hooks: [
        {
          type: "command",
          command: hook.command,
          ...(hook.timeout !== null ? { timeout: hook.timeout } : {}),
        },
      ],
    });
  }
  return {
    // `applyFlagSettings` merges: what is on again is said so, not left out.
    disableAllHooks: !config.ownerHooks,
    deniedMcpServers: config.ownerServersOff.map((serverName) => ({ serverName })),
    enabledPlugins: { ...config.plugins },
    skillOverrides: Object.fromEntries(config.skillsOff.map((name) => [name, "off"])),
    hooks,
    ...(sandbox ? { sandbox: { ...sandbox, failIfUnavailable: sandbox.enabled } } : {}),
  };
}

/**
 * Cycle's servers that are on, as `setMcpServers` takes them. An http server's token is read from
 * the daemon's environment by the variable the owner named.
 */
export function ownServers(
  config: ClaudeConfig,
  env: Record<string, string>,
): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (!server.enabled) continue;
    const { transport } = server;
    if (transport.kind === "stdio") {
      servers[name] = {
        type: "stdio",
        command: transport.command,
        args: transport.args,
        env: transport.env,
      };
    } else {
      const token = transport.bearerTokenEnvVar ? env[transport.bearerTokenEnvVar] : undefined;
      servers[name] = {
        type: "http",
        url: transport.url,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      };
    }
  }
  return servers;
}

/** The tools a process may not use: the ones turned off, and the skills turned off. */
export function disallowedTools(config: ClaudeConfig): string[] {
  return [...config.toolsOff, ...config.skillsOff.map((name) => `Skill(${name})`)];
}

/** What only a process's start takes. Two processes started apart from it need not start again. */
export function startKey(config: ClaudeConfig, pluginDirs: string[]): string {
  return JSON.stringify([
    config.toolsOff,
    config.skillsOff,
    config.hooks,
    config.ownerSettings,
    pluginDirs,
  ]);
}

function shownTransport(server: StoredServer): McpTransport {
  const { transport } = server;
  return transport.kind === "stdio"
    ? { ...transport, env: Object.keys(transport.env).toSorted() }
    : transport;
}

/** A row for a server no process lists: it is off. */
function quiet(
  name: string,
  origin: "config" | "owner",
  transport: McpTransport | null,
): McpServerInfo {
  return {
    name,
    enabled: false,
    origin,
    transport,
    pluginId: null,
    status: "disabled",
    auth: "none",
    tools: [],
    error: null,
  };
}

/**
 * The servers as the page shows them: what a process said, with Cycle's own as they are kept and
 * what is turned off, which a process does not list, added.
 */
export function shownServers(config: ClaudeConfig, listed: McpServerInfo[]): McpServerInfo[] {
  const off = (server: string, tool: string) => config.toolsOff.includes(toolName(server, tool));
  const shown = listed.map((server): McpServerInfo => {
    const stored = config.mcpServers[server.name];
    const tools = server.tools.map((tool) => ({ ...tool, enabled: !off(server.name, tool.name) }));
    if (stored) {
      return {
        ...server,
        origin: "config",
        enabled: stored.enabled,
        transport: shownTransport(stored),
        tools,
      };
    }
    const origin = server.name.startsWith("plugin:") ? "plugin" : "owner";
    // A process started before it was turned off may still list it as it was.
    if (config.ownerServersOff.includes(server.name)) {
      return { ...server, origin, tools, enabled: false, status: "disabled" };
    }
    return { ...server, origin, tools };
  });
  const names = new Set(shown.map((server) => server.name));
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (!names.has(name)) {
      shown.push({ ...quiet(name, "config", shownTransport(server)), enabled: server.enabled });
    }
  }
  for (const name of config.ownerServersOff) {
    if (!names.has(name)) shown.push(quiet(name, "owner", null));
  }
  return shown.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Reads `claude.json` as kept, taking what is not there as empty. */
export function readConfig(raw: unknown): ClaudeConfig {
  const value = typeof raw === "object" && raw !== null ? (raw as Partial<ClaudeConfig>) : {};
  return { ...emptyConfig(), ...value };
}

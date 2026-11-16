/**
 * Claude Code plugins as Cycle keeps them. Cycle installs with Claude Code's own command, run in a
 * Claude Code home of Cycle's, so nothing of the owner's is written; each process is given the
 * folders installed there. The owner's own installs are listed beside them, to turn on or off.
 */
import type { PluginCatalog, PluginInfo, PluginMarketplace } from "@cycle/protocol";
import type { ClaudeConfig } from "./config.ts";

/** Runs `claude <args>` with Cycle's plugin home as its home. */
export interface PluginCli {
  run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** A plugin Claude Code installed in Cycle's home. */
export interface InstalledPlugin {
  id: string;
  version: string | null;
  path: string;
}

/** A plugin of the owner's own install, as a process lists it. */
export interface OwnerPlugin {
  id: string;
  name: string;
  version: string | null;
}

/** The marketplace the owner's own installs are shown under. */
export const OWNER_MARKETPLACE = "claude-code";

interface CliMarketplace {
  name: string;
  path?: string;
  installLocation?: string;
  source?: string;
}

interface CliList {
  installed?: { id: string; version?: string; installPath: string }[];
  available?: {
    pluginId: string;
    name: string;
    description?: string;
    marketplaceName: string;
    version?: string;
  }[];
}

function nameOf(id: string): string {
  return id.split("@")[0] ?? id;
}

function marketOf(id: string): string {
  return id.slice(id.indexOf("@") + 1);
}

function parse<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Claude Code's ${what} could not be read.`);
  }
}

/** Says what a failed `claude plugin` said, in one line. */
function failed(result: { stdout: string; stderr: string }, what: string): Error {
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  try {
    const said = JSON.parse(line) as { message?: string };
    if (said.message) return new Error(said.message);
  } catch {
    // Not a line of JSON: the reason is in stderr.
  }
  const reason = result.stderr.trim().split("\n").at(-1) || "it gave no reason";
  return new Error(`${what} failed: ${reason}`);
}

/** The installed plugins of a `claude plugin list --json`. */
export function toInstalled(list: CliList): InstalledPlugin[] {
  return (list.installed ?? []).map((each) => ({
    id: each.id,
    version: each.version ?? null,
    path: each.installPath,
  }));
}

/** The folders a process is given: Cycle's installs that are on. */
export function pluginDirs(installed: InstalledPlugin[], config: ClaudeConfig): string[] {
  return installed.filter((each) => config.plugins[each.id] !== false).map((each) => each.path);
}

/** The owner's own installs and Cycle's marketplaces, as the page shows them. */
export function toCatalog(
  marketplaces: CliMarketplace[],
  list: CliList,
  owner: OwnerPlugin[],
  config: ClaudeConfig,
): PluginCatalog {
  const on = (id: string) => config.plugins[id] !== false;
  const shown: PluginMarketplace[] = [];
  // A plugin of the owner's that Cycle turned off is not loaded, so no process lists it.
  const owners = new Map(owner.map((each) => [each.id, each]));
  const cycles = new Set(toInstalled(list).map((each) => each.id));
  for (const [id, enabled] of Object.entries(config.plugins)) {
    if (!enabled && !owners.has(id) && !cycles.has(id)) {
      owners.set(id, { id, name: nameOf(id), version: null });
    }
  }
  if (owners.size > 0) {
    shown.push({
      name: OWNER_MARKETPLACE,
      displayName: "Installed in Claude Code",
      path: null,
      plugins: [...owners.values()]
        .toSorted((a, b) => a.id.localeCompare(b.id))
        .map((each) => ({
          id: each.id,
          name: each.name,
          displayName: each.name,
          description: `${each.id}, installed with \`claude plugin install\``,
          version: each.version,
          installed: true,
          enabled: on(each.id),
          available: true,
          unavailable: null,
        })),
    });
  }
  const byMarket = new Map<string, PluginInfo[]>();
  const add = (market: string, plugin: PluginInfo) => {
    const plugins = byMarket.get(market) ?? [];
    plugins.push(plugin);
    byMarket.set(market, plugins);
  };
  for (const each of toInstalled(list)) {
    add(marketOf(each.id), {
      id: each.id,
      name: nameOf(each.id),
      displayName: nameOf(each.id),
      description: "",
      version: each.version,
      installed: true,
      enabled: on(each.id),
      available: true,
      unavailable: null,
    });
  }
  for (const each of list.available ?? []) {
    if (cycles.has(each.pluginId)) continue;
    add(each.marketplaceName, {
      id: each.pluginId,
      name: each.name,
      displayName: each.name,
      description: each.description ?? "",
      version: each.version ?? null,
      installed: false,
      enabled: false,
      available: true,
      unavailable: null,
    });
  }
  const names = new Set([...marketplaces.map((each) => each.name), ...byMarket.keys()]);
  for (const name of [...names].toSorted()) {
    const known = marketplaces.find((each) => each.name === name);
    shown.push({
      name,
      displayName: name,
      path: known?.source === "directory" ? (known.path ?? known.installLocation ?? null) : null,
      plugins: (byMarket.get(name) ?? []).toSorted((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return { marketplaces: shown, errors: [] };
}

/** Cycle's plugin home, through Claude Code's own `plugin` command. */
export class CyclePlugins {
  private readonly cli: PluginCli;
  private installedNow: Promise<InstalledPlugin[]> | null = null;

  constructor(cli: PluginCli) {
    this.cli = cli;
  }

  /** What is installed, read once and again after each change. */
  installed(): Promise<InstalledPlugin[]> {
    this.installedNow ??= this.list(false)
      .then(toInstalled)
      .catch((error: unknown) => {
        this.installedNow = null;
        throw error;
      });
    return this.installedNow;
  }

  async catalog(owner: OwnerPlugin[], config: ClaudeConfig): Promise<PluginCatalog> {
    const [markets, list] = await Promise.all([this.markets(), this.list(true)]);
    this.installedNow = Promise.resolve(toInstalled(list));
    return toCatalog(markets, list, owner, config);
  }

  async install(marketplace: string, name: string): Promise<void> {
    if (marketplace === OWNER_MARKETPLACE) {
      throw new Error("Plugins of Claude Code's own are installed with `claude plugin install`.");
    }
    await this.change(["install", `${name}@${marketplace}`, "--json"], "Installing");
  }

  async uninstall(id: string): Promise<void> {
    if (!(await this.installed()).some((each) => each.id === id)) {
      throw new Error(`${id} is Claude Code's own: uninstall it with \`claude plugin uninstall\`.`);
    }
    await this.change(["uninstall", id, "--json"], "Uninstalling");
  }

  async addMarketplace(source: string): Promise<void> {
    const text = source.trim();
    // It goes to Claude Code as an argument: one that looks like an option is refused.
    if (!text || text.startsWith("-")) throw new Error("That is not a marketplace.");
    await this.change(["marketplace", "add", text], "Adding the marketplace");
  }

  async removeMarketplace(name: string): Promise<void> {
    if (name === OWNER_MARKETPLACE || name.startsWith("-")) {
      throw new Error("Claude Code's own plugins are not a marketplace Cycle can remove.");
    }
    await this.change(["marketplace", "remove", name], "Removing the marketplace");
  }

  private async change(args: string[], what: string): Promise<void> {
    this.installedNow = null;
    const result = await this.cli.run(["plugin", ...args]);
    if (result.code !== 0) throw failed(result, what);
  }

  private async list(available: boolean): Promise<CliList> {
    const result = await this.cli.run([
      "plugin",
      "list",
      "--json",
      ...(available ? ["--available"] : []),
    ]);
    if (result.code !== 0) throw failed(result, "Listing plugins");
    return parse<CliList>(result.stdout, "list of plugins");
  }

  private async markets(): Promise<CliMarketplace[]> {
    const result = await this.cli.run(["plugin", "marketplace", "list", "--json"]);
    if (result.code !== 0) throw failed(result, "Listing marketplaces");
    return parse<CliMarketplace[]>(result.stdout, "list of marketplaces");
  }
}

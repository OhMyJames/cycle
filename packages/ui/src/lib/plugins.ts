import type { PluginInfo, PluginMarketplace } from "@cycle/protocol";

/** How many plugins of a marketplace are drawn before the owner asks for more. */
export const PLUGINS_FIRST = 12;
/** How many more each press adds. */
export const PLUGINS_MORE = 48;

/**
 * Where the owner has installed something comes first, and then the smaller marketplaces: one the
 * owner added is a few plugins, and the directory Claude Code comes with lists thousands.
 */
const hasInstalled = (market: PluginMarketplace) => market.plugins.some((each) => each.installed);

export function orderMarketplaces(list: readonly PluginMarketplace[]): PluginMarketplace[] {
  return list.toSorted(
    (a, b) =>
      Number(hasInstalled(b)) - Number(hasInstalled(a)) ||
      a.plugins.length - b.plugins.length ||
      a.name.localeCompare(b.name),
  );
}

/** The plugins of a marketplace that match a search, those installed first, and how many match. */
export function matchPlugins(
  plugins: readonly PluginInfo[],
  query: string,
  limit: number,
): { shown: PluginInfo[]; total: number } {
  const needle = query.trim().toLowerCase();
  const found = needle
    ? plugins.filter((each) =>
        `${each.name} ${each.displayName} ${each.description}`.toLowerCase().includes(needle),
      )
    : plugins;
  const sorted = found.toSorted((a, b) => Number(b.installed) - Number(a.installed));
  return { shown: sorted.slice(0, limit), total: sorted.length };
}

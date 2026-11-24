import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MARKETPLACE_DIR } from "clawdot-plugins";
import type { BuiltinBundle } from "./plugins.ts";
import { compiled } from "./self.ts";

/** The folder the plugins are shipped in, beside the executable (scripts/build.ts puts it there). */
export const BUILTIN_PLUGINS_FOLDER = "clawdot-plugins";

/** Where the plugins that ship with Cycle are: beside the executable, or in the checkout when run from source. */
export const builtinPluginsRoot = (): string =>
  compiled() ? join(dirname(process.execPath), BUILTIN_PLUGINS_FOLDER) : MARKETPLACE_DIR;

/** The version a plugin's manifest gives, when the manifest names the plugin as its folder does (an id is made of it). */
const versionOf = (dir: string, name: string): string | undefined => {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name?: unknown; version?: unknown } | null;
    if (manifest?.name !== name) return undefined;
    return typeof manifest.version === "string" && manifest.version !== ""
      ? manifest.version
      : undefined;
  } catch {
    return undefined;
  }
};

const ICONS: Record<string, string> = {
  "icon.svg": "image/svg+xml",
  "icon.png": "image/png",
};
const ICON_MAX_BYTES = 60_000;

/** `assets/icon.svg` (or `.png`) of a plugin as a data URL: what a client shows without fetching anything. */
const iconOf = (dir: string): string | undefined => {
  for (const [file, type] of Object.entries(ICONS)) {
    try {
      const bytes = readFileSync(join(dir, "assets", file));
      if (bytes.length > 0 && bytes.length <= ICON_MAX_BYTES) {
        return `data:${type};base64,${bytes.toString("base64")}`;
      }
    } catch {
      // Not there: the next one.
    }
  }
  return undefined;
};

/**
 * The plugins that ship with Cycle (packages/clawdot-plugins), read from disk: each directory under `plugins/` that has
 * a manifest with a version. Absent when there are none (a build without them is not an error).
 */
export const builtinPlugins = (root = builtinPluginsRoot()): BuiltinBundle | undefined => {
  const plugins: BuiltinBundle["plugins"] = [];
  const base = join(root, "plugins");
  if (!existsSync(base)) return undefined;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    const version = versionOf(dir, entry.name);
    const icon = iconOf(dir);
    if (version !== undefined) {
      plugins.push({ name: entry.name, version, dir, ...(icon !== undefined ? { icon } : {}) });
    }
  }
  if (plugins.length === 0) return undefined;
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return { root, marketplace: "clawdot", plugins };
};

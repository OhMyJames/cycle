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

const versionOf = (dir: string): string | undefined => {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"),
    );
    const version = (manifest as { version?: unknown } | null)?.version;
    return typeof version === "string" && version !== "" ? version : undefined;
  } catch {
    return undefined;
  }
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
    const version = versionOf(dir);
    if (version !== undefined) plugins.push({ name: entry.name, version, dir });
  }
  if (plugins.length === 0) return undefined;
  plugins.sort((a, b) => a.name.localeCompare(b.name));
  return { root, marketplace: "clawdot", plugins };
};

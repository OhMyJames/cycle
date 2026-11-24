import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Source of the built-in plugins: one directory each, in Claude plugin layout. */
export const PLUGINS_DIR = join(import.meta.dir, "..", "plugins");

/** The marketplace root (contains `.claude-plugin/marketplace.json`), the one source every agent adds. */
export const MARKETPLACE_DIR = join(import.meta.dir, "..");

/** Names of the built-in plugins. */
export const builtinPluginNames = (): string[] =>
  readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

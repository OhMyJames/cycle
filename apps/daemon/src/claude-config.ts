import { type ClaudeConfig, type ClaudeConfigBook, readConfig } from "@cycle/harness-claude";
import type { JsonStore } from "./store.ts";

/**
 * `claude.json`: Cycle's own configuration of Claude Code, which every process on this machine
 * starts with. It holds MCP servers' environment values, so the file is the owner's alone; the
 * page is given their names.
 * Why: .agents/notes/2026-11-16-cycle-keeps-claude-code-s-configuration.md
 */
export function claudeConfigBook(store: JsonStore<ClaudeConfig>): ClaudeConfigBook {
  return {
    read: () => readConfig(store.value),
    async write(config) {
      store.update((value) => Object.assign(value, config));
      // A process started next reads it from here: it is kept before the change is said done.
      await store.flush();
    },
  };
}

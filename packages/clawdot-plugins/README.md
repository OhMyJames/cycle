# clawdot-plugins

Clawdot team plugins that ship inside Cycle. The daemon installs them quietly for Claude, Codex and agy; the user can
turn them off but not uninstall them (docs/protocol.md §15, note 2026-11-24-builtin-plugins-are-installed-by-cycle).

## Add a plugin

1. Make `plugins/<name>/` in Claude's plugin layout. One source serves all three agents:
   - `.claude-plugin/plugin.json`: `{ "name": "<name>", "version": "0.1.0", "description": "…" }`. `name` is the directory's.
   - `skills/<skill>/SKILL.md` (frontmatter `name` = the directory, and `description`), `commands/*.md`, `.mcp.json`.
2. List it in `.claude-plugin/marketplace.json`: `{ "name": "<name>", "source": "./plugins/<name>", "description": "…" }`.
3. `bun test packages/clawdot-plugins` checks the layout.
4. Optional: `assets/icon.svg` (or `icon.png`, under 60 KB): Cycle shows it in the plugin's row. Only Cycle reads it; the agents ignore it.
5. **Change `version` whenever the content changes**: it is how installed copies are told to update.

## What to use

Use what all three have: skills, commands, http MCP servers. Hooks and sub-agents differ between agents; leave them out
until one is needed. Prefer http MCP servers: Cycle serves those through its gateway (sign-in and secrets stay with the
daemon), stdio ones are started by the agent itself.

## Try it by hand

Isolated, so nothing of yours is touched:

```sh
export HOME=$(mktemp -d) CLAUDE_CONFIG_DIR=$(mktemp -d)
claude plugin marketplace add "$PWD/packages/clawdot-plugins" && claude plugin install <name>@clawdot
claude plugin validate packages/clawdot-plugins/plugins/<name>
agy plugin install packages/clawdot-plugins/plugins/<name>     # agy converts on install; its output lists what it took (`validate` rejects an unconverted Claude layout, that is expected)
```

Markdown under `plugins/**/skills` is outside Biome's formatting: the formatter would break a SKILL.md's frontmatter.

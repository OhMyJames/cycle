# Agent Note: The Connector is codex's own configuration

Status: accepted
Date: 2026-11-13
Basis: codex app-server offers `config/read`, `config/batchWrite`, `config/mcpServer/reload`,
`mcpServerStatus/list`, `mcpServer/oauth/login`, `plugin/list|read|install|uninstall` and
`marketplace/add|remove`, each run against codex 0.167.2 with a temporary `CODEX_HOME`.

## Problem

old-cycle's Connector kept Cycle's own MCP servers in `~/.agents/mcp.json`, added them to every session,
signed in to them itself with tokens in the keychain, and served them to agents through a gateway in
the daemon behind a key of its own. That was needed because its agent had no way to be told about
servers at the owner's level. It was the daemon's largest part outside sessions.

## Decision

Cycle keeps no list of servers or plugins. The Connector reads and writes codex's `config.toml` through
the harness, and codex signs in, stores the tokens and starts the servers.

- A server is `mcp_servers.<name>`. An edit writes only the keys Cycle shows (`command`, `args`, `env`,
  `url`, `bearer_token_env_var`, `enabled`), each with its own `config/batchWrite` edit, so a timeout or
  header set by hand stays. Writing `null` removes a key.
- A server's `env` values stay in the harness. `McpTransport` carries the names only, and an edit that
  names a variable with a null value keeps the stored one.
- A token for an HTTP server is never typed into Cycle: the server is given the name of an environment
  variable, or codex's OAuth sign-in, whose link the page opens in the browser.
- Plugins are installed from marketplaces codex knows. Enabling one is `plugins."<id>".enabled`.

## Alternatives considered

- Cycle's own `mcp.json` and gateway, as in old-cycle. Rejected: a second place for the same servers, and
  tokens of Cycle's own to keep safe, for something codex already does.
- Sending `env` values to the page so the form can show them. Rejected: a key would sit in the page's
  memory and in any screenshot.

## Consequences

- A server added in Cycle works in the codex CLI, and one added there shows in Cycle.
- There is no sign-out in the page: codex app-server has no method for it. `codex mcp logout` does it.
- A server's name cannot be changed, since it is its key.
- The page cannot show a variable's value, only replace it.

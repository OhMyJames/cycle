# Cycle's tools for agents are an MCP server behind its own key

- Status: accepted
- Date: 2026-11-13
- Basis: codex app-server as bundled on this date, checked in
  `apps/daemon/test/integration/tools.test.ts` against the real binary

## Problem

An agent in one session could not see the owner's other sessions. The owner wants to say "look at
what that session found" and have the agent read it. That needs a way from codex into the daemon,
and the daemon's only door is the page's: loopback, the connection token, `Host` and `Origin`.
The connection token can start sessions, answer approvals and delete conversations, so it must
not reach an agent.

## Decision

The daemon starts a second server of its own, as the providers' gateway is one
(`apps/daemon/src/tools.ts`): an MCP server over HTTP, on `127.0.0.1` and a port of its own, that
checks `Host` and answers only its bearer, a key made at each start that is not the connection
token. It offers two tools, `list_sessions` and `read_session`, both marked read-only, and nothing
that changes a session.

Codex is given it with `-c` overrides at start (`mcp_servers.cycle.url`,
`mcp_servers.cycle.bearer_token_env_var`), in both of its processes. The key is in the codex
child's environment only, and `shell_environment_policy.exclude` keeps it from the commands the
agent runs. Nothing is written to codex's `config.toml`, so the codex CLI does not see a server
that is gone when the daemon stops, and the Connector does not list it: it is part of Cycle, not
one of the owner's connections.

A prompt names a session as a link, `[@title](cycle://session/<id>)`. The composer shows
`@title` and sends the link; a message draws the link as the title again. The link is text in the
conversation codex keeps, so it is a format: do not change it without reading old ones.

## Alternatives considered

- **The daemon's own port and token.** One door fewer, but the agent would hold the token that
  deletes sessions. Rejected.
- **A stdio MCP server that calls the daemon.** It needs a token on its command line or in its
  environment all the same, and one more process per codex child.
- **Putting the other session's text into the prompt in the page.** No server at all, but the page
  would paste whole conversations into prompts, the owner could not ask for more or less of one,
  and a schedule's run could not read anything.
- **Writing the server into `config.toml`.** The Connector's rule is that codex's file is the
  truth, but this server's address and key change at every start and mean nothing to the CLI.

## Consequences

- An agent can read every unarchived session of the owner's, whichever folder it runs in. There is
  one owner, so this is no wider than what the agent's commands can already read in `CODEX_HOME`.
- The tools only read. A tool that changes a session (send, archive) needs its own decision: it
  would let one agent drive another without the owner.
- Reading a session through the hub brings it back into codex as opening it in the page does.
- A third loopback server holds a key. The red line for the gateway applies to it in the same
  words: loopback, `Host`, its bearer.

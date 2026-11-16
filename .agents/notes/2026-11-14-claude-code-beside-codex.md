# Agent Note: Claude Code runs beside codex, as an agent only

Status: accepted
Date: 2026-11-14
Basis: The owner asked for a second harness on the Claude Agent SDK, and for harnesses that can later
run in Docker sandboxes (`sbx`), local and cloud (2026-11-14). Checked against
`@anthropic-ai/claude-agent-sdk` 0.3.325 (Claude Code 2.1.325), run under Bun against a scripted
Messages API.

## Problem

`Harness` was one interface that one backend implemented whole: sessions, the Connector, the account
and the machine. Claude Code offers the first through its SDK and nothing like the others: no `exec`,
no file calls, no terminal, no call that writes its configuration, and no sign-in to start.

## Decision

`Harness` is four parts: `Agent`, `Connector`, `Account` and `Machine`. Codex gives all four and stays
the main harness. `harness/claude` is an `Agent` only, and `Harnesses` in the daemon joins the two:

- A model says which agent it is of (`ModelInfo.harness`), and a new session starts on its model's
  agent. A session says which keeps it (`HarnessSession.harness`) and stays there: its model can
  change within that agent only.
- Files, git, search and terminals for every session go to codex, whichever agent runs the session.
  Both run on this machine, so a path means the same to both.
- The Connector and the account are codex's. Claude Code reads its own settings, MCP servers and
  sign-in, as its CLI does; Cycle shows and changes none of them.
- Conversations stay Claude Code's, read with `listSessions` and `getSessionMessages`. Nothing new is
  stored: `sessions.json` is unchanged, since each agent lists its own sessions.

Three things the SDK does not do the way codex does, and what was done instead:

- **The tools key.** An MCP server given in the SDK's options goes into the process's arguments, where
  any command the agent runs can list it with `ps`. Cycle's server is given with `setMcpServers` after
  the process starts, which goes down its pipe. An integration test reads `ps` and `env` from inside a
  session and finds no key.
- **Going back.** Claude Code cuts a stored conversation only as it takes the next prompt
  (`resumeSessionAt`). The harness remembers the cut until then and applies it to what it reads back.
  Before the first turn there is no entry to cut at: the stored session is deleted and begins again
  under its id.
- **Models.** Claude Code names models by alias. Each is offered once under the model the alias means
  now, so a session keeps its model when an alias moves.

## Alternatives considered

- Giving Claude Code a machine of its own, by spawning in the harness. Rejected for now: a second
  implementation of what codex already gives, for no gain while both run on one machine.
- Carrying Claude Code in the packaged app, as codex is. Rejected: its binary is about 350 MB for one
  platform, in every release and every update. The app uses the owner's own `claude`.
- Passing the tools key as an HTTP header in the SDK's `mcpServers` option. Rejected: see above.
- A harness column in `sessions.json`. Not needed: each agent lists what it keeps.

## Consequences

- A sandbox is a place, and a place needs its own machine. `ClaudeHarness` takes a `spawn` that starts
  Claude Code elsewhere (the SDK's `spawnClaudeCodeProcess`), but git, files and terminals would still
  be this machine's, and stored sessions would be the sandbox's, which the SDK reads from this
  machine's disk. Running sessions in `sbx` needs: a place on each session, `Machine` calls routed by
  place (a codex app-server started inside the sandbox serves both agents there), and the SDK's
  `sessionStore` or a mounted home for Claude Code's sessions. None of that is built.
- `auto` turns Claude Code's sandbox on, so commands run unasked inside the folder. Where the sandbox
  cannot start, Claude Code asks before a command instead; that was seen on Linux without `bwrap`. The
  sandbox itself was not run: not on macOS, not on Linux.
- A cut is lost if the daemon stops before the next prompt, and the turns come back.
- A session compacted in Claude Code reads back from the summary on: the SDK gives nothing earlier.
- Skills, the Connector and the account page were codex's only. Since 2026-11-16 each agent has
  its own, and Claude Code's are read in Cycle but not yet changed:
  [2026-11-16-each-agent-declares-what-it-can-do.md](2026-11-16-each-agent-declares-what-it-can-do.md).
  Claude Code's plan steps are shown as
  plain tool calls, and what its helper agents say is left out.
- The SDK and the owner's `claude` may be of different versions in a packaged app. Not seen to fail;
  not tested across versions.

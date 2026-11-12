# Agent Note: The daemon reaches the project only through the harness

Status: accepted
Date: 2026-11-12
Basis: The owner asked for a new Cycle "grown on the codex app-server harness" (2026-11-12).

## Problem

old-cycle's daemon ran git, pseudo-terminals, file reads and file listings itself, with its own process
spawning, environment allowlist and headless terminal emulator. That is a second implementation of
what the agent's runtime already has, and it ties the daemon to the machine the agent runs on.

## Decision

`Harness` carries the machine as well as the agent: `exec`, `readDirectory`, `readFile`, `searchFiles`
and `openTerminal`. The codex harness implements them with app-server's own `command/exec` (with
`tty: true` for terminals), `fs/readDirectory`, `fs/readFile` and `fuzzyFileSearch`. The daemon's `Git`,
`Files` and `Terminals` take those as ports and spawn nothing themselves.

## Alternatives considered

- Spawning in the daemon, as old-cycle did. Rejected: more code, and the daemon and the agent could
  disagree about which machine and which environment a path means.
- An MCP server of Cycle's own for terminals. Not needed while the owner's terminals and the agent's
  commands are separate; revisit if the agent should drive the owner's terminals.

## Consequences

- A harness for another agent must offer these calls too, or the panels that need them stay empty.
- Every git command is one request to codex and one process there. Status costs four to six. That is
  fine for one owner; a file watcher would replace the polling if it is not.
- `command/exec` is called with `dangerFullAccess`: these are the owner's own commands, not the agent's.
- Not verified: a codex app-server on another machine. The design allows it; nothing runs it yet.

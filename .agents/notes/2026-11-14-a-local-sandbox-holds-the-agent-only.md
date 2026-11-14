# Agent Note: A local sandbox holds the agent only

Status: accepted
Date: 2026-11-14
Basis: The owner asked for sessions in Docker sandboxes, local first (2026-11-14). Read from Docker's
documentation of `sbx` (docs.docker.com/ai/sandboxes and /reference/cli/sbx) on that day. No `sbx` was
run: this was built where there is no virtual machine to run one, against a stand-in script.

## Problem

A sandbox is another machine. Everything the daemon does for a session, it does on the machine the
main harness is: git, files, terminals. Moving a session into a sandbox seemed to mean moving all of
that, and bringing back the conversation Claude Code stores where it runs.

## Decision

A local sandbox mounts the session's folder at the same absolute path as on this machine. So only the
agent moves:

- `session.create` takes `sandbox: true`. The harness finds or makes one sandbox for the folder
  (`sbx create --name cycle-<folder>-<hash> claude <folder> ...`) and the session keeps its name, in
  `sessions.json` (`sandbox`) and on `SessionInfo`. Every turn is given the name again, so a daemon
  that started later knows where the session runs.
- Claude Code is started with `sbx exec -i -w <folder> -e ... <name> claude <the SDK's arguments>`,
  through the SDK's `spawnClaudeCodeProcess`. It is the sandbox's own Claude Code.
- Git, files, search and terminals stay this machine's. They read the same files.
- Claude Code keeps a folder's conversations in `<its home>/projects/<the folder's path, dashed>`.
  That one folder is mounted into the sandbox's home at the same place, so a conversation in the
  sandbox is written on this machine, and listing, reading, copying and going back work unchanged.
- Of this machine's environment, only what the SDK sets for Claude Code goes in (`CLAUDE_AGENT_SDK_*`,
  `CLAUDE_CODE_*`), and nothing named as a token, key or secret.
- A model says whether its sessions can run in a sandbox here (`ModelInfo.sandbox`): Claude Code's,
  when `sbx` is on the `PATH`.

## Alternatives considered

- Mounting all of `~/.claude` into the sandbox. Rejected: every project's conversations and the
  owner's settings would be the sandboxed agent's to read and change.
- The SDK's `sessionStore`, which mirrors a conversation to the caller. Rejected for now: it is marked
  alpha, and Cycle would keep conversations, which it does not.
- A sandbox for each session. Rejected: each is a virtual machine, and sessions in one folder already
  share the folder.

## Consequences

- A local sandbox gives isolation, not capacity: it runs on this machine's processor and memory. Only
  a cloud sandbox takes load off it, and that has no host folder, so everything in this note that
  leans on the shared path does not hold there.
- Inside a sandbox Claude Code's own command sandbox is left off, so `auto` asks before a command.
  `fullAccess` is what Docker's own template runs with; it stays the owner's choice here.
- The sandbox has none of the owner's Claude Code settings, hooks or MCP servers, and its own sign-in.
- Cycle's tools are not given to a sandboxed session: they answer on this machine's loopback alone.
- A terminal opened in a sandboxed session is this machine's shell, not the sandbox's.
- A worktree is refused with a sandbox: its history is in the repository's folder, outside the mount.
- Codex sessions are refused: `codex app-server` is one process for all sessions, on this machine.
- Not checked against a real `sbx`: that the agent's home is `/home/agent`, that a folder mounted
  under it leaves the rest of the home writable, that the template's Claude Code speaks to this SDK's
  version, and how long `sbx create` takes the first time.

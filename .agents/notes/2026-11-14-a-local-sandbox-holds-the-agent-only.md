# Agent Note: A local sandbox holds the agent only

Status: accepted
Date: 2026-11-14, revised 2026-11-15
Basis: The owner asked for sessions in Docker sandboxes, local first (2026-11-14). Read from Docker's
documentation of `sbx` (docs.docker.com/ai/sandboxes and /reference/cli/sbx) on that day, and checked
against `sbx` 0.53 on this machine on 2026-11-15. The owner then asked that neither the project's path
nor the owner's Claude Code home be in a sandbox (2026-11-15): the primary workspace `sbx` is made on
cannot be mounted anywhere but its host path, an additional workspace can be mounted at another.

## Problem

A sandbox is another machine. Everything the daemon does for a session, it does on the machine the
main harness is: git, files, terminals. Moving a session into a sandbox seemed to mean moving all of
that, and bringing back the conversation Claude Code stores where it runs.

## Decision

A local sandbox mounts the session's folder at a path of the sandbox's own. So only the agent moves:

- `session.create` takes `sandbox: true`. The harness finds or makes one sandbox for the folder
  (`sbx create --name cycle-<folder>-<hash> claude <empty folder> <folder>:<the sandbox's path> ...`)
  and the session keeps its name, in `sessions.json` (`sandbox`) and on `SessionInfo`. Every turn is
  given the name again, so a daemon that started later knows where the session runs. The empty
  folder is the workspace `sbx` insists on naming itself, which says nothing of the project; each
  sandbox has one, named by a hash of its own.
- The sandbox sees the folder at `/home/agent/workspace/<the folder's name>`, so no path of this
  machine is in what its tools say. `SessionInfo` carries that path (`sandboxCwd`) and the page
  opens a file it names at the same file here.
- Claude Code is started with `sbx exec -i -w <that path> -e ... <name> claude <the SDK's
  arguments>`, through the SDK's `spawnClaudeCodeProcess`. It is the sandbox's own Claude Code.
- Git, files, search and terminals stay this machine's. They read the same files.
- Claude Code keeps a folder's conversations in `<its home>/projects/<the folder's path, dashed>`.
  A sandbox has a Claude Code home of its own under `CYCLE_HOME/sandboxes/<name>/claude`; that one
  folder is mounted into the sandbox at its own dashed path, so a conversation in the sandbox is
  written there, and nothing of the owner's Claude Code home is in the sandbox. Listing, reading,
  copying and going back go through the SDK with that home, one home at a time, since the SDK finds
  its home in the environment. A conversation kept in the owner's home before this is moved into the
  sandbox's home the first time it is opened.
- Of this machine's environment, only what the SDK sets for Claude Code goes in (`CLAUDE_AGENT_SDK_*`,
  `CLAUDE_CODE_*`), and nothing named as a token, key or secret.
- A model says whether its sessions can run in a sandbox here (`ModelInfo.sandbox`): Claude Code's,
  when `sbx` is on the `PATH`.

## Alternatives considered

- Mounting all of `~/.claude` into the sandbox. Rejected: every project's conversations and the
  owner's settings would be the sandboxed agent's to read and change.
- Mounting a sandbox's whole Claude Code home over `/home/agent/.claude`. Rejected: `sbx` keeps its
  own policy files there and mounts the owner's skills at `/home/agent/.claude/skills`, which a
  mount over the parent would hide or refuse.
- Leaving the folder at its host path. Rejected: every tool call would carry this machine's path to
  the model, and the folder's dashed name would be in the sandbox.
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
- Checked against `sbx` 0.53 on this machine: the agent's home is `/home/agent`, a primary workspace
  cannot be mounted at another path, an additional one can, a folder mounted under the Claude home
  leaves the rest writable, and the template's Claude Code speaks to this SDK's version.
- A sandbox keeps its conversations when it is removed with its environment, under
  `CYCLE_HOME/sandboxes/`; a sandbox made again with its name finds them. They are not deleted with
  the sandbox, since what was said in a conversation is not the sandbox's to lose.
- The empty workspace is under `/tmp`, named by a hash, and made again whenever the sandbox is
  ensured: a reboot that clears `/tmp` would otherwise leave a sandbox that cannot start.

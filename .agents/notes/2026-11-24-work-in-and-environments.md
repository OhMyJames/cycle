# Agent Note: "Where it runs" is Work in; an environment is a global, reusable setup chosen per workspace

Status: accepted
Date: 2026-11-24
Basis: Owner's requests of 2026-11-24 in the session on how agents define environment. The owner compared Codex's "Edit local environment" (setup and cleanup scripts per OS, actions, variables) and "Work in" menu (This computer, Cloud, Remote, SSH) with Cycle, and said our SSH logic is "Work in". The owner agreed to split the two, and proposed that environments are added globally and then chosen. Reading, 2026-11-24: Codex [local environments](https://learn.chatgpt.com/docs/environments/local-environment) and [worktrees](https://developers.openai.com/codex/app/worktrees); Claude Code [desktop](https://code.claude.com/docs/en/desktop) and [cloud environments](https://code.claude.com/docs/en/cloud-environments); Antigravity [SSH](https://antigravity.google/docs/ssh/). Code read: `apps/desktop/src/main/settings.ts` and `apps/daemon/src/{claude,codex,agy}-agent.ts`.

## Problem

The 2026-11-18 note named a connected daemon (local, or remote over SSH) an **environment**. Two other tools use the word for two different things:

- Codex calls the daemon-like choice **Work in**. Its **environment** is a per-project recipe: setup script, cleanup script, actions, variables.
- Claude Code calls the place an **environment**. Its cloud environments are also recipes: network access, variables, setup script.

Cycle will need that recipe too, for worktrees, variables and actions. The word cannot mean both.

None of the three agents defines either concept in the layer Cycle drives: the Agent SDK, `codex app-server` and `agy acp` take a `cwd`, a process environment and MCP servers. So both concepts belong to Cycle and work the same for every agent. The per-agent process environment (`config.json` `allowEnv`/`env`, isolated `HOME`/`CLAUDE_CONFIG_DIR`/`CODEX_HOME`) is a third thing and stays as it is.

## Decision

- **Work in** (code: `location`) is where a session runs: the connected daemon. It covers what the 2026-11-18 note called environment (`{id, name, kind: local | remote, transport}`), with the same rules: it is a client concept, several are aggregated, a session cannot change it, and a workspace is `(locationId, cwd)`.
- **Environment** is a recipe:
  - name;
  - setup and cleanup scripts, each with a default and optional macOS, Linux and Windows overrides;
  - variables;
  - actions.

  Environments are defined **globally** in the desktop app and are not tied to a location. A workspace remembers a default, and a new session uses it unless the person picks another. The daemon receives the chosen environment when the session is created, keeps a copy, and runs it on its own machine. So one definition works on this computer and over SSH.
- Setup runs only when a worktree is created and cleanup only before one is removed, never in the main checkout. Variables and actions apply to every session. Until Cycle has worktrees, only variables and actions take effect.
- Environment variables are for what the session runs. They are separate from an agent's process settings and may not override them; the reserved names are listed in `docs/protocol.md`.
- Status: decision accepted. The format and protocol in `docs/desktop.md` and `docs/protocol.md` are drafts for the owner to review. Implemented on 2026-11-24: the rename to location, the daemon side (snapshot in the index, variables for every agent and terminal, actions through `_cycle/terminal/create`), and the desktop side (`environments.json`, Settings → Environments, the choice on the blank conversation, actions in the session's title bar). Setup and cleanup are stored and not run, since Cycle has no worktrees yet.

## Alternatives considered

- **Keep Claude Code's naming** (environment = place, recipe added under another name). The owner chose the split. With Claude's naming, a recipe would always need a qualifier, and the two concepts would stay tangled in settings and copy.
- **Per-project recipes committed to the repo** (Codex's `.codex/`). The owner chose global definitions. A repo file may be added later as a second source, for sharing with a team. Not in the first version.
- **A recipe per location.** Rejected: the same project needs the same setup locally and over SSH. Codex's per-OS scripts handle the differences between machines.

## Consequences

- The client renames environment to location in code and copy, about 48 files. Saved data keeps working:
  - `settings.json` is read from `locations`, then `environments`, then `hosts`, and is written as `locations`.
  - Ids are unchanged, so sessions, drafts and pins still match.
  - An older app opened on a new file no longer sees remote locations, the same downgrade cost the `hosts` → `environments` change accepted.
- Recipes go in their own file, `environments.json` (mode 0600, because variables can hold secrets). They never share a key with the old `environments` list.
- The daemon stores a session's environment the way it stores `mcpServers`: in the index only, not in the JSONL log or `session/list`. Editing an environment changes new sessions, not running ones.
- Variables reach the commands an agent runs, never the agent's own process, whose environment stays the daemon's explicit allowlist (AGENTS.md red line). A code review on 2026-11-24 found the first version put them into the Claude and agy processes, where a project variable such as `GOOGLE_APPLICATION_CREDENTIALS` could switch the account an agent bills. Now:
  - Claude gets them through `CLAUDE_ENV_FILE`, a file it sources before each Bash command.
  - Codex gets them through `shell_environment_policy.set.<NAME>` dotted keys. A whole table would replace the person's own policy.
  - agy gets none. It has no commands-only way, so the owner chose on 2026-11-24 that agy sessions get the variables in their terminals and actions only.

  All three behaviours were checked in real turns on 2026-11-24: Claude with SDK 0.3.327's binary, Codex 0.171.0 on start, resume and merging with the person's own `set`, and agy 1.5.16.

## Related

- Partly replaces [2026-11-18-sidebar-workspace-environment](2026-11-18-sidebar-workspace-environment.md) for the name only. Everything else there still holds, renamed to location: workspaces, the one-workspace sidebar, ordering, unread and disconnected behaviour.
- [2026-11-22-terminals-in-the-daemon-over-l1](2026-11-22-terminals-in-the-daemon-over-l1.md): actions run in the daemon's terminals.
- Partially replaced for `agy` command variables by [2026-11-24-agy-command-environment](2026-11-24-agy-command-environment.md) (CYC-314): `agy` commands now receive session variables via `ZDOTDIR` / `BASH_ENV` while keeping them out of `agy`'s own process. Everything else in this note still holds.

# Agent Note: Agents are kept from reading secrets.env by each agent's own sandbox or deny rule, and the gaps are stated

Status: accepted
Date: 2026-11-24
Basis: Owner's request of 2026-11-24 that the same-user read of `secrets.env` "must be handled, the agent must not be able to read it". Checked on this machine: Codex 0.166.0 (`codex sandbox`, and a real `codex app-server` thread/start), Claude Agent SDK 0.3.331 type definitions, `agy acp --help` (1.5.16). Code read: `harness/claude/src/process.ts`, `harness/codex/src/{agent,settings,server}.ts`, `apps/daemon/src/{claude-agent,codex-agent,secrets}.ts`. Extends [2026-11-24-secrets-by-name-and-never-to-agents](2026-11-24-secrets-by-name-and-never-to-agents.md), whose "not stopped" limit this narrows.

## Problem

Secrets never reach an agent's commands, but `secrets.env` is a file the same user owns. An agent that can read files can `cat` it, and `chmod 600` does not stop it.

## Decision

The daemon names the files to keep (`protectedFiles`: `secrets.env` and `providers.json`, each by its path and by where a symlink leads; not `dataDir`, since Claude's home is inside it) and each harness applies its own mechanism.

- **Codex**: the thread uses a permission profile `extends ":workspace"` with those files as `none`, and no `sandbox` mode, because Codex ignores the profile when `sandbox` is also given (`activePermissionProfile` stayed null). The profile gives the same sandbox as `workspace-write` (compared on `thread/start`). Turns in the workspace-write modes name no sandbox of their own. Denial was observed with `codex sandbox` on macOS, symlinks included. Not covered: Read only and Full access, whose turns still name their own sandbox (turn/start has no profile field), and on Linux files created after a session starts (bubblewrap creates 0-byte host mount points for nonexistent `"none"` targets, so Linux only denies files that exist at session start; see [2026-11-24-codex-agents-worktree-and-notes-sandbox](2026-11-24-codex-agents-worktree-and-notes-sandbox.md)).
- **Claude**: always a deny rule for the Read and Edit tools (`Read(//path)`; one slash would be from the project's root). When the vault has a secret at session start, also the SDK sandbox with `filesystem.denyRead`, `allowUnsandboxedCommands: false`, `failIfUnavailable: false`. The sandbox also limits what a command may write and reach, which is why it is not on for people with no secrets. Not run against a real Claude session: a nested launch was refused by the permission classifier here. Where the sandbox cannot start, commands run unsandboxed.
- **Antigravity**: nothing. `agy acp` has `--sandbox` and no way to name a path to deny.
- The Vault page says which cases are not covered.

## Alternatives considered

- Deny rules alone: stop the Read tool but not `cat` through Bash. Used for Claude's tools, not alone.
- Moving values into the OS keychain with access for the daemon binary only: holds even in Full access, not built. It is a larger change and on Linux depends on a secret service. Offered to the owner.
- Refusing to run an environment with secrets in Full access or Antigravity: not done; a product decision for the owner.
- Putting the profile in every Codex mode by restarting the app-server on a mode change: not done, more change than was checked.

## Consequences

- A secret added after a Claude session started is covered by the file tool rule but not by that session's sandbox until the next session.
- An agent that can reach the daemon's own socket is outside all of this.

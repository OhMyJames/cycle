# Agent Note: Unlock `.agents/worktree` and `.agents/notes` via Codex's `:workspace` permission profile, never legacy `writableRoots` or all of `.agents`

Status: accepted
Date: 2026-11-24
Basis: CYC-312 (real Codex 0.171.0 session `b43d4664-9693-401c-972a-fbe8bae749cd` blocked from running `bun install` in `.agents/worktree/<name>` and editing `.agents/notes/`) and empirical checks on this machine against pinned Codex 0.171.0 (`codex sandbox` and `codex app-server` `thread/start` + `turn/start`). Code read: `harness/codex/src/{agent,settings,server}.ts`, `apps/daemon/src/{worktree,secrets}.ts`.

## Problem

Codex 0.171.0's default `:workspace` / `workspace-write` sandbox marks `<cwd>/.agents` read-only. This conflicts with Cycle's managed worktree layout `<repo>/.agents/worktree/<name>` (CYC-273) and decision notes directory `<repo>/.agents/notes/`:

- When `cwd` is the main checkout, Codex cannot install dependencies or write files inside `.agents/worktree/<name>` or edit `.agents/notes/`.
- When `cwd` is inside a worktree (`<repo>/.agents/worktree/<name>`), the worktree root itself is writable, but `<worktree>/.agents/notes/` is still read-only.

Additionally, on Linux CI (`ubuntu-latest`), passing nonexistent files (`providers.json`) as `"none"` in Codex's permission profile caused bubblewrap (`bwrap`) to materialize a 0-byte stub file at the mount point on the host filesystem, crashing subsequent daemon startups with `ProvidersUnreadableError: JSON Parse error: Unexpected EOF`.

## Decision

- When `<cwd>/.agents` exists as a real directory (not a symlink), `harness/codex` opens the thread with Cycle's `permissions.cycle` profile extending `:workspace`, granting `"write"` only to `<realpath(cwd)>/.agents/worktree` and `<realpath(cwd)>/.agents/notes` (skipping any entry that is a symlink or non-directory), omitting thread-level `sandbox` so Codex honors the profile.
- `denyRead` entries (`secrets.env`, `providers.json`) are applied last as `"none"` in the same profile so denials always take precedence. On Linux, `denyRead` only includes files that already exist on disk so bubblewrap does not create 0-byte host stub files.
- Everything else in `:workspace` — `<cwd>/.agents/skills`, `<cwd>/.git`, `<cwd>/.codex`, `~/.aws`, and paths outside `cwd` — remains read-only.

## Alternatives considered

- **Adding `.agents/worktree` and `.agents/notes` to legacy `sandboxPolicy.workspaceWrite.writableRoots`:** Empirically tested with pinned Codex 0.171.0 (`codex sandbox` with `sandbox_mode = "workspace-write"` and `sandbox_workspace_write.writable_roots`): Codex still enforced `<cwd>/.agents` as read-only over `writable_roots`, denying writes to both subdirectories.
- **Unlocking all of `<cwd>/.agents`:** Rejected because `.agents/skills/` holds agent instructions and skills that should remain read-only in the sandbox.
- **Moving Cycle's managed worktrees out of `.agents/worktree/`:** Rejected because `<repo>/.agents/worktree/<name>` is shared with Cycle's Claude hooks and CYC-273 (`2026-11-24-worktree-is-cycles.md`), and would still leave `.agents/notes/` read-only.

## Consequences

- Codex sessions in either the main repo or a worktree can work in `.agents/worktree/<name>` and `.agents/notes/` without weakening `.agents/skills`, `.git`, `.codex`, `.aws`, or `secrets.env` protection.
- Same mode-switch caveat as `2026-11-24-keep-agents-from-reading-secrets-env.md`: once a turn switches to `read-only` or `full-access` (which names a turn-level `sandboxPolicy`), Codex's `turn/start` cannot re-attach a permission profile on a later switch back to `default`.
- If `<cwd>/.agents` does not exist at session start, the profile is not added because `:workspace` keeps `.agents` itself read-only anyway (creating a worktree via Cycle's `EnterWorktree` or new-session picker creates `.agents/worktree/<name>` in the daemon outside Codex's sandbox).
- On Linux, a `secrets.env` or `providers.json` created after a Codex session has started is covered starting with the next session.

## Related

- [Worktrees are Cycle's](2026-11-24-worktree-is-cycles.md)
- [Keep agents from reading secrets.env](2026-11-24-keep-agents-from-reading-secrets-env.md)

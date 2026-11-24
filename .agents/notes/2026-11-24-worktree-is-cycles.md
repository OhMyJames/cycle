# Agent Note: Cycle makes and removes worktrees for every agent; Claude keeps its native tools, Codex and agy get same-contract MCP tools

Status: accepted
Date: 2026-11-24
Basis: CYC-273 and the owner's answers of 2026-11-24 in the session that implemented it (mainly for Codex and agy; setup failure does not stop the session; start branches are local branches plus the remote default, no fetch, no SSH in the first version; deleting a session with unsaved work in its worktree is refused until the person confirms). Code read: `apps/daemon/src/{git,daemon,environment}.ts`, `.claude/hooks/worktree-create.sh`, `harness/{codex,agy}/src/agent.ts`. The Claude SDK 0.3.327 types for `EnterWorktree` and `ExitWorktree` were read, not run.

## Problem

Cycle had no worktrees, and the environment's setup and cleanup scripts (2026-11-24-work-in-and-environments) had nothing to run on. The three agents differ: Claude has native worktree tools and hooks, Codex's app-server protocol has none, agy has none. All three take only a `cwd` from Cycle.

## Decision

- The daemon owns the worktree lifecycle for every agent: it makes the worktree before the agent starts and passes its path as `cwd`.
- Location and names match the repository's Claude hook (`<main checkout>/.agents/worktree/<name>`, branch `worktree-<name>`), so a worktree made by either side is recognised by the other.
- Claude keeps its native `EnterWorktree` / `ExitWorktree`. Codex and agy are given tools with the same names, inputs, outputs and refusal rules by a built-in server on Cycle's existing MCP gateway, and the agent is restarted with `session/resume` at the new `cwd` after the turn.
- Cycle only removes worktrees it made (`managed`); removal refuses unsaved files or commits until the caller confirms.
- A setup failure keeps the worktree and the session and reports the output. Archiving leaves the worktree alone.

## Alternatives considered

- **Codex's `dynamicTools` and a per-turn `cwd`:** Codex-only and untested; the restart path works the same for agy.
- **Replacing Claude's native tools with Cycle's:** loses what Claude does natively for no gain.
- **Fetching before creating:** the first version uses local refs; the hook fetches, but a fetch can hang on credentials.

## Consequences

- One lifecycle and one contract for the three agents; the UI needs no per-agent branch.
- Claude's native `EnterWorktree` does not trigger Cycle's setup or cleanup yet.
- Resuming agy in a different `cwd` was not verified with a real account; Codex's resume takes a `cwd` (code read, not run).
- A prompt already queued runs in the old `cwd` until the agent restarts.
- SSH locations are not supported in the first version.

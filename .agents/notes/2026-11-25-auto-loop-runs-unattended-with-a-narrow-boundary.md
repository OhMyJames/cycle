# Agent Note: The auto loop runs unattended inside a narrow, code-enforced boundary

Status: accepted
Date: 2026-11-25
Updated: 2026-11-26 (CYC-407): facts corrected to match the code; the decision is unchanged.
Basis: CYC-318 and its parent CYC-315 (itsaplan), design discussion with the user on 2026-11-24/25; code in cloud/loop/.

## Problem

`cloud/loop` takes work items from the tracker and runs coding sessions on them with no one watching. Whoever writes a work item (or a session that drafted it) controls text the loop acts on, and the loop holds the tracker and GitHub credentials. The agent `agy` ignores `permissions.allow/ask/deny` under ACP, so the agent's own settings cannot be the boundary.

## Decision

The boundary is in the loop's code, not in prompts:

- Permission requests are answered by `policy.ts`: a baseline of reads and in-worktree edits is allowed, QA is read-only and everything else is denied; all other requests stay pending until a person answers in the desktop app.
- Verification commands are an allowlist of forms (`bun run check`, `bun run test:browser`, `bun run test:integration [suite]`, `bun test <relative paths>`), parsed to argv, never run through a shell. A work item whose acceptance criteria name anything else gets a comment with the reasons and is moved to Blocked.
- Commands run with an allowlisted environment (`verifyEnv`: no tokens). Only the commands that talk to the remote get `deliverEnv` (only allowlisted git/GitHub credentials): `git fetch`, `git push`, and `gh` for pull requests and CI (`pr create`, `pr view`, `pr comment`, `pr merge --auto`, `run view`, `run rerun`). The tracker key is read by the loop alone and never passed to a session or a command.
- The loop's own git commands run with hooks and fsmonitor disabled, since a session can write `.git/hooks` or config in the worktree.
- Whether a criterion is met is decided by an exit code of a command the loop ran; a session saying "done" changes nothing. QA's read-only status is checked (HEAD and `git status` before and after), not trusted.
- Run state, progress notes and criteria live outside the worktree, so a session cannot edit them. The loop never deletes a session. It removes a work item's own worktree and local branch only once the item is Done and its PR is merged, and never force-removes one with uncommitted changes (CYC-379).

## Alternatives considered

- Block every permission request: rejected by the user, who wants to see the session and decide in it.
- Trust the agent's own permission settings: not possible for `agy`.
- Run the verify commands the work item names through a shell: rejected, as that hands command execution to the work item's author.

## Consequences

A work item can only name a few kinds of verification, which is a deliberate limit. The command and permission lists will need maintenance as the repository grows. Verified end to end on 2026-11-25 against the live tracker and a real daemon: work items were taken, delivered, merged and cleaned up.

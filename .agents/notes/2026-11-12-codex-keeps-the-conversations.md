# Agent Note: Codex keeps the conversations; Cycle keeps only what is the owner's

Status: accepted
Date: 2026-11-12
Basis: codex app-server offers `thread/list`, `thread/resume`, `thread/archive`, `thread/delete`,
`thread/fork` and `thread/name/set`, checked against codex 0.167.2.

## Problem

old-cycle kept its own session index, mirrored for rollbacks, with archive state and transcript copies,
because its agent's list could not be trusted to be complete. Each of those files had to be kept in
step with the agent.

## Decision

The session list is codex's `thread/list`. A session's history is `thread/resume`. Archive, delete,
rename and fork are codex's. `CYCLE_HOME/sessions.json` holds only what codex has no place for, by
session id: the owner's title, pin, unread mark, mode, model and worktree. It lives in `~/.cycle-codex`,
never `~/.cycle`, which is old-cycle's.

A session made in the codex CLI or an IDE shows up in Cycle and can be continued there.

## Alternatives considered

- An index of Cycle's own. Rejected: a second source of truth for the same list.

## Consequences

- A session with no turn yet is not in codex's list, so the daemon adds the ones it holds open.
- Deleting `sessions.json` loses pins and modes, not conversations.
- A stored session's mode defaults to the owner's setting until it is changed in Cycle.
- An archived session keeps its worktree: removing it is the owner's choice at delete.

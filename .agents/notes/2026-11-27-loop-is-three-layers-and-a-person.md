# Agent Note: Loop is split into three layers plus a person (Work loop, Supervisor, Operator agent)

Status: accepted
Date: 2026-11-27
Basis: Epic CYC-470 (`[CYC-470] Intent / Spec / Design / Plan`, docs 57–60 in `infra.CYC`) and ticket CYC-471; architecture review of 2026-11-26.

## Problem

`cloud/loop` grew into one script that drove work items, polled the tracker, and relied on a human-watched session plus out-of-repo shell scripts (`loop.sh`, `watch.sh`) to restart, unstick, and update itself. Mixing deterministic orchestration, process supervision, and operational triage made failures harder to isolate and pulled a person back into routine restarts.

## Decision

Separate Loop into **three layers plus a person**, governed by five principles:

1. **Work loop** (`cloud/loop/src/engine/`, `flows/`, `ports/`, `cli.ts`): deterministic orchestration that claims approved work, drives sessions/verification/delivery, writes heartbeats, and reconciles tracker intents. The engine stays flow- and forge-agnostic (enforced by `scripts/boundaries.ts`).
2. **Supervisor** (`cloud/loop/src/supervisor/`): a resident deterministic process (no LLM) managed by launchd/systemd that keeps Work loop alive, restarts stalled heartbeats, cancels an overdue run once via `loop/run/cancel`, escalates repeat stalls with a `stuck` Notice, and self-updates Work loop in `~/.cycle/loop-runtime/` with rollback on missing heartbeat.
3. **Operator agent** (`CYC-470` phase 2, `CYC-486`–`CYC-489`, planned): handles Blocked diagnosis, conflict/criteria repair, periodic inspection, and Backlog planning, acting exclusively through the Loop API and recording every action.
4. **The person**: owns product decisions, approval gates, and merging PRs that touch the hard path floor.

Five core principles:

- Deterministic scripts own state transitions and verification; LLMs act only inside bounded steps.
- Single source of truth for execution state lives in SQLite (`loop.db`); tracker writes go through transactional outbox reconciliation.
- Every client (desktop and operator) reads and writes exclusively through the Loop API (`loop/*`).
- Security boundaries (delivery repo, clean env, exact command shapes, hard path floor) are enforced in code, not prompts.
- Supervisor and guard modules sit inside the auto-merge floor so Loop cannot silently weaken its own safety layer.

## Alternatives considered

- **Keep a single monolithic pipeline script + human-watched session**: rejected after operational logs showed frequent manual restarts and stuck checks.
- **Implement the supervisor as an LLM session**: rejected because an LLM session can itself hang or time out; the bottom-most liveness layer must be deterministic.

## Consequences

- Work loop, supervisor, and operator responsibilities stay cleanly separated and independently testable.
- Phase 1 (SQLite, reconciliation, Loop API, security patches, path floor, supervisor) is implemented first; Phase 2 (operator agent) builds on the same `loop.db` and `loop/*` API without changing engine internals.

## Related

- [2026-11-27-loop-state-in-sqlite](2026-11-27-loop-state-in-sqlite.md)
- [2026-11-27-loop-path-floor](2026-11-27-loop-path-floor.md)
- [2026-11-27-loop-delivery-repo-and-clean-env](2026-11-27-loop-delivery-repo-and-clean-env.md)
- [2026-11-26-loop-api-is-the-only-way-in](2026-11-26-loop-api-is-the-only-way-in.md)

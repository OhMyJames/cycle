# Agent Note: Loop enforces a hard code path floor that blocks auto-merge regardless of PR review verdict

Status: accepted
Date: 2026-11-27
Basis: Epic CYC-470 (`[CYC-470] Design` §7), tickets CYC-471 and CYC-481; code in `cloud/loop/src/guard/floor.ts`, `cloud/loop/src/flows/dev/review.ts`, `scripts/boundaries.ts`, and `REVIEW.md`.
Supersedes: [The PR review decides whether a person must look, with no code-enforced floor](2026-11-25-pr-review-decides-human-involvement-with-no-code-floor.md)

## Problem

Under the earlier no-floor decision, an automated PR that modified Loop's own review rubric (`REVIEW.md`), CI workflow (`.github/`), or safety/supervision code could still receive a `merge` verdict from the LLM review session and auto-merge itself. Once Loop began self-updating via a supervisor (`CYC-484`/`CYC-485`) and enforcing architectural guards, allowing automated self-merges into the safety layer itself became an unacceptable trust-boundary weakness.

## Decision

Enforce a hard, narrow path floor in code (`cloud/loop/src/guard/floor.ts`):

- `FLOOR = ["cloud/loop/src/supervisor/", "cloud/loop/src/guard/", "REVIEW.md", ".github/"]`.
- In `cloud/loop/src/flows/dev/review.ts`, whenever the LLM review returns `merge`, Loop calls `Forge.changedPaths` before enabling GitHub auto-merge. If any changed path hits `FLOOR`, or if the changed path list cannot be read, Loop **refuses to enable auto-merge**, posts an `escalate` PR/tracker comment naming the matched paths, moves the ticket to `In Review`, and logs a `floor_hit` event.
- Pair the runtime floor with static boundary checks in `scripts/boundaries.ts` (`cloud/loop/src/engine/**` cannot import `flows/dev`, `ports/github`, or `ports/git`; `engine/engine.ts` stays ≤ 600 lines; `apps/desktop/src/**` except legacy cleanup in `main.ts` cannot reference `itsaplan-key`) and updated escalation rules in `REVIEW.md`.
- All other paths—including ordinary `cloud/loop/src/flows/` and product code—continue to rely on independent LLM review + required CI for auto-merge.

## Alternatives considered

- **Keep no code floor and rely purely on LLM review (`2026-11-25` decision)**: rejected; a PR editing `REVIEW.md` or `.github/` can weaken the very checks meant to judge it.
- **Block auto-merge for all of `cloud/loop/`**: rejected; ordinary flow, UI, and engine fixes benefit from fast automated delivery while the narrow four-entry floor protects the trust anchor (supervisor, guard, review rubric, CI).

## Consequences

- PRs touching `supervisor/`, `guard/`, `REVIEW.md`, or `.github/` always require a human click to merge, even if CI is green and the LLM reviewer approves.
- Any attempt to shrink or bypass `FLOOR` touches `cloud/loop/src/guard/floor.ts`, which is itself inside `FLOOR`.
- Verified by `cloud/loop/test/guard.test.ts` and `scripts/boundaries.test.ts`.

## Related

- [2026-11-27-loop-is-three-layers-and-a-person](2026-11-27-loop-is-three-layers-and-a-person.md)

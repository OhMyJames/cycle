# Agent Note: The PR review decides whether a person must look, with no code-enforced floor

Status: accepted
Date: 2026-11-25
Basis: the user's choice "不加底线" in the 2026-11-25 planning session; CYC-332 (review stage) and the initiative 3 description.

## Problem

The auto loop can open PRs for tickets labelled `auto`, including tickets that change the loop itself, `.github` or `AGENTS.md`. The earlier plan (CYC-326) classified PRs by changed path: some paths always needed a person, docs-only or test-only PRs could merge automatically.

## Decision

After a PR is open and CI has run, an independent read-only review session gives a verdict, auto-merge OK or a person is needed with reasons, written as a PR comment. GitHub auto-merge is turned on only when the verdict is OK and CI is all green. There is **no floor in code**: PRs that change the loop, `.github`, `AGENTS.md` or `REVIEW.md` are decided by the review like any other. Tickets that change the loop may carry `auto`. This replaces the path-based tiers in CYC-326. Not yet implemented; CYC-332 is the work.

## Alternatives considered

- A path-based floor (changes to `tools/auto-loop/`, `.github/`, `AGENTS.md`, `REVIEW.md` always need a person): this was the CYC-326 design. The user rejected it for the MVP.

## Consequences

A PR can weaken the review that judges it, for example by editing `REVIEW.md` or the review prompt, and then pass its own review. The user knows and accepts this. The remaining protections are the required CI checks on `main` and the fact that a person labels the ticket `auto`. If a bad merge happens this way, a floor can be added later as a new note that supersedes this one. Review criteria and the "CI green but review incomplete" case (treated as needing a person) are specified in CYC-332.

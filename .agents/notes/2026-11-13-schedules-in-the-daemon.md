# Agent Note: Schedules are the daemon's, and run only while it does

Status: accepted
Date: 2026-11-13
Basis: old-cycle's `apps/daemon/src/schedules.ts` and its decision note of 2026-11-08; codex 0.167.2's
`PluginDetail.scheduledTasks` is a plugin's declaration, not something app-server runs.

## Problem

The owner wants a prompt to run on a timing, each time in a new session. Codex app-server runs nothing
on a clock.

## Decision

`CYCLE_HOME/schedules.json` holds `{ schedules: StoredSchedule[] }`: what the owner said (name, prompt,
folder, worktree, model, effort, mode, timing) and, for each, `since` and its newest 20 runs. Moments
are milliseconds since the epoch; a `daily` time is `HH:MM` on the daemon machine's clock.

A run is `SessionHub.create` then `send`, the same path the composer takes, so it has the owner's
settings, a worktree when asked, and approvals that wait for the owner. The session's `scheduleId` is
kept in `sessions.json`, so it reads as a schedule's after the schedule is deleted.

The rule for missed time is old-cycle's: an occurrence counts only after `since`; of those missed, only
the latest runs; runs of one schedule never overlap; a `once` runs late within 12 hours and is then off.
The run is recorded before it starts, so a daemon stopped meanwhile does not run it twice.

## Alternatives considered

- A launchd agent that keeps the daemon alive while a schedule is on, as old-cycle's daemon stayed up.
  Not yet: the desktop app owns the daemon's lifetime here, and quitting the app stops it.
- cron or launchd entries per schedule. Rejected: a second place the schedule lives, outside Cycle.

## Consequences

- With the app quit, nothing runs. On the next start the latest missed occurrence runs once.
- A schedule may name `fullAccess`, but only when the owner picks it in the form: a null mode is the
  owner's setting for new sessions, which is never `fullAccess` by default.

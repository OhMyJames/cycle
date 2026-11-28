# Agent Note: The daemon switches between turns, drains when it cannot, and forces after a limit

Status: accepted
Date: 2026-11-28
Basis: CYC-547, decided 2026-11-28 (the owner chose plan A for queued messages). Evidence: with a pending version the daemon waited for every session to be quiet for 2 minutes, so a person chatting with replies under 2 minutes apart, or a background task left running, kept the switch from ever happening, and Loop took no new work all that time.
Partly supersedes the switch condition and the waiting limit in [the CYC-538 note](2026-11-27-daemon-releases-on-its-own-and-updates-itself-when-idle.md).

## Problem

"Nothing working and quiet for 2 minutes" has no upper bound. Continuous conversation, a watcher or dev server as a background task, or a long turn that never stops each hold it off for good, and since Loop takes no new work while a version waits, the whole system stalls behind one session.

## Decision

- Three phases. Waiting: switch as soon as no turn, request, background task, loading session or terminal command exists and nothing happened for 15 seconds (checked every 30 seconds and at each turn or task end). Draining, after `update.drainAfterMinutes` (default 15): no new turns start, every prompt (also to idle sessions and the first one of a new session) is queued with `hold: "update"`, running turns finish and take no next prompt, and the daemon switches at once when none is left. Forced, after `update.forceAfterMinutes` more (default 15): the `cycle update --now` path (running turns end with `daemon_stopped`, requests cancelled, background tasks stopped with a note in the session, queue kept), logged as `self_update_forced`. `0` skips the next phase.
- Messages queued with `hold: "update"` are sent automatically after the switch by the new daemon (or by the old one when the switch is rolled back), with no client attached. This is the one exception to protocol §8 "returned, not sent automatically": the principle exists so that a message is not sent after the user stopped something or an error happened; draining is the daemon's own decision, the user stopped nothing, and the interface said the message goes out after the restart. Earlier queue entries and turns cut by the forced switch still follow §8 (no replay, returned as `interrupted`).
- Loop's rule "no new work while a version waits" is unchanged: the wait is now bounded by `drainAfter + forceAfter` plus the switch, and holding work in waiting lets the daemon reach a gap sooner.
- Protocol: `pending.state`, `since`, `forceAt` in `_cycle/daemon/update/read`, the `_cycle/daemon/update` notification for clients that declare it, `hold: "update"` in queue snapshots, and `selfUpdateDrain` in capabilities. All optional, so old and new sides read each other.

## Alternatives considered

- Only shorten the 2 minutes: fixes the chatting case, not a background task that never ends or a turn that never stops.
- Plan B, return drained messages to the input box as `interrupted` and make Loop resend returned prompts: keeps §8 whole, but people must resend by hand and Loop gets a new rule.
- Drain only people, or only Loop: two rules, and the interface would have to explain why one side can send.
- Loop takes no new work only while draining: the existing rule is already bounded now; relaxing it only delays the switch.
- Let a turn survive the switch by handing over the agent process: still a large change, left for later as in CYC-538.

## Consequences

- Switches are more frequent; each session's next message waits a few seconds for the agent to start. Versions come at most every 30 minutes.
- A forced switch can interrupt a person's turn, only after draining for the full limit; the interface shows the expected time beforehand.
- Auto-send breaks a written §8 principle for exactly one case; the messages run with nobody attached and are recorded in the history.
- Auto-send only happens on a daemon that has `selfUpdateDrain`; a target older than that is never installed, so this does not arise.
- A second starter hitting the switch logs "already listening" (now at info level); startup logic is unchanged.
- Not verified here: a switch with the real built daemon (`CYCLE_DAEMON_BIN`, `self-update.integration.ts`), and the 15 + 15 minute path with a never-ending background task; a person checks these after merge.

## Related

- [The daemon is released on its own channel and updates itself when idle](2026-11-27-daemon-releases-on-its-own-and-updates-itself-when-idle.md): partly replaced; channel, signing, rollback stay as written there.

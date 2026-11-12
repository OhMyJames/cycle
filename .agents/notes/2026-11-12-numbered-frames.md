# Agent Note: Sessions are sent as numbered frames a client can catch up on

Status: accepted
Date: 2026-11-12
Basis: old-cycle's measured weak points, read from its code on 2026-11-12: an unbounded in-memory log of
every update per open session, and reconnects that replay the whole conversation.

## Problem

A client joins late, drops its connection, or switches between sessions. It needs the conversation as
it is now, cheaply, and must never show a gap or apply an event twice.

## Decision

The daemon keeps each open session as a folded `SessionState` (the shared `reduceSession`), not a log.
What happens is sent as `EventFrame { sessionId, seq, events }`: frames are numbered from 1 per session
with no gaps, and the state carries the number of the last frame folded in and an `epoch` naming the run
of frames. Streamed text is held for 16ms and sent as one frame. The last 512 frames are kept.

`session.open` answers with the whole state, or, when the client says which frame it last folded
(`after: { seq, epoch }`) and the daemon still has what follows in the same epoch, with only those
frames. A client that sees a number skip asks again. Clients receive frames only for sessions they
opened; the list hears `sessions.changed`.

The wire is Cycle's own JSON, not ACP: codex app-server does not speak ACP, and the model here is a
small one that the harness translates into.

## Alternatives considered

- Forwarding the agent's raw protocol and replaying from the agent, as old-cycle did. Rejected: every
  reconnect costs the whole transcript, and the page must know the agent's protocol.
- A durable event log on disk. Rejected: codex already keeps the conversation; a second copy is a
  second thing to keep right.

## Consequences

- Memory per open session is its state plus 512 frames, and sessions nobody watches are let go past 32.
- A daemon restart starts new epochs, so clients get whole states once. That is the designed fallback.
- The reducer is a compatibility surface: the daemon and the page must run the same version of it,
  which holds while the daemon serves the page.

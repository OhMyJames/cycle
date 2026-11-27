# Agent Note: The `loop/` API is the only way a desktop or an operator agent reads or writes tickets

Status: accepted
Date: 2026-11-26
Basis: CYC-482; supersedes the "desktop reads and writes itsaplan itself" part of [2026-11-25-desktop-holds-a-personal-itsaplan-key-for-now](2026-11-25-desktop-holds-a-personal-itsaplan-key-for-now.md) once the desktop moves over (next work item). docs/protocol.md §17.

## Problem

The desktop connected to itsaplan on its own, built the board, parsed the Loop's comments with regexes and hardcoded label names. Comments are not an interface: a renamed label or a session the regex does not know about breaks it silently. Every new client (the operator agent) would repeat all of it.

## Decision

The Loop server answers the board, runs, Notices, approve/return and status over its socket (`loop/…` methods, zod in `@cycle/protocol` `loop.ts`). It is the only place besides the pipeline that talks to itsaplan. Label and column ids are resolved from `get_project` by name on every write, never cached or hardcoded. Notices come from the `notices` table and `runs`, with the session kind and id stored, not parsed. Writes (`approve`, `return`) go straight to itsaplan, not through the reconcile intents, and each ticket writes one `actions` row, including skipped and failed ones. Write methods need `actor` and `actorKind` (`desktop` or `operator`); the socket is `0600`, a request line over 1 MB closes the connection.

## Alternatives considered

- Writes as intents (reconcile): rejected, a person's click must answer now with a per-ticket result, and the loop's own writes are not racing a human's.
- Keep the desktop writing with its own key: rejected for the operator agent, which would have to hold a key too.

## Consequences

`actor` is self-declared. Anyone who can open `loop.sock` (the same OS user) can write as any actor; this is attribution, not authentication. The writes go out under the Loop's own itsaplan key, so itsaplan's audit trail shows the Loop, not the person: the comment ("由 <actor> 在桌面端批准/退回") and the `actions` row are the record of who acted. Remote access, several users and authentication are out of scope; they need a different decision.

## Related

- [2026-11-25-loop-server-is-its-own-process](2026-11-25-loop-server-is-its-own-process.md) — establishes the standalone Loop server process and mode-0600 unix socket that hosts the `loop/*` API.
- [2026-11-27-loop-is-three-layers-and-a-person](2026-11-27-loop-is-three-layers-and-a-person.md) — places the `loop/*` API as the single boundary between Work loop, desktop, and operator clients.

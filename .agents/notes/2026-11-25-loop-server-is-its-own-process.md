# Agent Note: The Loop server is its own process, and the desktop sees only non-secret Project facts from it

Status: accepted
Date: 2026-11-25
Basis: Epic CYC-381 (Intent/Spec/Design/Plan docs 19–22 in itsaplan) and ticket CYC-386, user go-ahead of 2026-11-25 ("现在开始做 386"); docs/protocol.md §17.

## Problem

The Loop page needs a server that knows which Projects exist and holds the forge/repo credentials a Loop run will need. `cloud/loop` is a one-repo script that runs next to the tracker key. The desktop is a renderer-facing app and the daemon spawns agent sessions that inherit its environment and can read the user's files.

## Decision

- The Loop server lives in `cloud/loop` as a separate process, one for many Projects, on the same machine as the daemon. It is not part of the daemon and does not import it.
- The desktop reaches it over a unix socket with JSON-RPC lines, like the daemon. It depends only on protocol types in `@cycle/protocol`, never on `cloud/loop`; `scripts/boundaries.ts` enforces this.
- Project tokens live in a mode-0600 config file read by the server only. The server refuses to start if the file is readable by group or others. No method returns a token, and the response test serializes the whole reply to prove it.
- `projects/list` is the only method in CYC-386. Remote Loop servers over SSH are not built.

## Alternatives considered

No alternatives were recorded.

## Consequences

- A second process to start, and a second socket. Agents running as the same user can still read a 0600 file; this note does not claim otherwise (see [2026-11-24-keep-agents-from-reading-secrets-env](2026-11-24-keep-agents-from-reading-secrets-env.md) for the same limit on `secrets.env`).
- Verified by tests in `cloud/loop`; not verified against a remote machine.

# Agent Note: The Loop server is started as a process and stopped with signals, with no config switch or protocol method

Status: accepted
Date: 2026-11-26
Basis: CYC-456, which left "config switch, command line or process supervisor" open in the CYC-381 Design; docs/protocol.md §17.

## Problem

The Design left how a person starts and stops the Loop server undecided. The CLI already stops on a signal, so the server needed one answer that matches it.

## Decision

Start is `bun cloud/loop/src/cli.ts`, run by hand or by a supervisor. Stop is `SIGINT`/`SIGTERM`: the first lets each step in flight finish and starts no new one, the second releases every Project's lock and exits 130. A killed server resumes from `run.json` on the next start. `handleStopSignals` in `runtime.ts` holds this so tests can drive it.

## Why

A config switch would need the file reread while running, and a protocol method would let a connected client stop the server, which widens who can stop it; the desktop must not start or stop it. Signals are what a supervisor already sends, and the semantics match the existing CLI.

## Rejected

- A `stop` flag in `loop.json`: needs polling and a second path to the same state.
- A `loop/stop` JSON-RPC method: gives the desktop a control it must not have.

## Consequence

A supervisor must send `SIGTERM` and wait longer than one step before `SIGKILL`; if it does not, recovery relies on `run.json`.

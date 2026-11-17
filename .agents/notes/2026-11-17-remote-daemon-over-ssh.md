# Agent Note: A remote daemon is reached through an ssh tunnel

Status: accepted
Date: 2026-11-17
Basis: The owner wants the desktop app to work on a daemon running on their own server. The daemon's
protections (loopback bind, `Host` and `Origin` checks, connection token) exist because agents run commands;
see [the daemon serves its own page](2026-11-12-the-daemon-serves-its-own-page.md).

## Problem

A daemon on another machine must be reachable without widening what may reach it. Binding beyond
loopback, or accepting other `Host` values, would let anything on the network, or any page the owner
visits, talk to a process that runs commands.

## Decision

- The daemon does not change. It stays on loopback and keeps the `Host`, `Origin` and token checks.
- The desktop reaches it with `ssh -L`, using the same port locally and on the server, so the daemon's
  own-port `Host` check accepts `localhost:<port>` unchanged.
- The token is read over ssh from the server's `daemon.json` at each connect and kept in the main
  process's memory. It is never written to disk by Cycle, and reaches the page only in the page URL
  fragment, as today.
- Authentication is the owner's own ssh configuration and agent. Cycle stores no password, key or
  passphrase, and runs ssh with `BatchMode=yes` so it never waits on a prompt nobody sees. Host keys are
  never skipped (no `StrictHostKeyChecking=no`).
- The list of remote servers (name, ssh target, optional remote `CYCLE_HOME`) is the desktop's, in the
  local `CYCLE_HOME/remotes.json`: no secrets. It is not in a daemon's `settings.json`, because the page
  of a remote daemon must show the same list.
- The owner starts and keeps the daemon on the server. Cycle does not start one remotely.

## Alternatives considered

- Binding the daemon to `0.0.0.0` with TLS. Rejected: it loosens the loopback red line and puts a
  command-running service on the network.
- A reverse proxy with a `Host` allowlist. Not chosen now. It may come later, but needs its own note and
  must keep an explicit `Host` list, never a wildcard.
- A cloud relay. Rejected: a third party between the owner and a daemon that runs commands.

## Consequences

- Same-port forwarding fails when the port is busy locally. That is reported as an error; the way out is a
  configurable daemon port, never a wider `Host`.
- A token changes on every daemon start, so a reconnect reads `daemon.json` again.
- Folder chooser, notifications and updates are the desktop's own and stay local; what a remote changes
  for them is decided with the page work.

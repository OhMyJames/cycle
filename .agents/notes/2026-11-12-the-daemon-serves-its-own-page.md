# Agent Note: The daemon serves its own page, behind a token on loopback

Status: accepted
Date: 2026-11-12
Basis: The MVP daemon accepted any WebSocket on its port with no check; agents can run commands.

## Problem

Anything on the machine, and any web page the owner visits, could reach a local daemon that runs
commands. old-cycle solved it with a token, a Host check, and one allowed Origin, a custom scheme only
its Electron app could have. That left the browser unable to be a client without a separate server.

## Decision

- The daemon binds to `127.0.0.1` only.
- Every request must name the daemon's own loopback address in `Host` (a page elsewhere cannot, even by
  rebinding DNS), and a browser's `Origin` must be the daemon's own.
- The WebSocket needs `?token=`, 32 random bytes, compared in constant time. The token is in
  `daemon.json` (mode 0600) and in the link the daemon prints.
- The daemon serves the built page at `/`, with a content security policy that lets it talk only to
  the daemon. The link carries the token after `#`, which is never sent to a server; the page moves it
  to session storage and takes it out of the address.
- The desktop app loads that same link, and its bridge answers only frames from that origin.

## Alternatives considered

- A custom scheme for the app's page, as old-cycle has. Rejected: two origins to allow, and no browser.
- Cookies. Rejected: a cookie is sent by any page that can reach the port; the token is not.

## Consequences

- The static files need no token: they hold no data. Everything that does goes over the WebSocket.
- Reading a file is limited to folders a session runs in or the owner's projects. Listing a folder's
  names is not, because the folder chooser needs it.
- Use from a phone needs a relay that authenticates the owner, as old-cycle's server does. None exists
  here yet, and widening the bind address is not a substitute.

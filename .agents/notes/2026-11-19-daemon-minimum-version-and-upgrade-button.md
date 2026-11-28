# Agent Note: A remote daemon is only flagged below a minimum version, and the app can update it over ssh when asked

Status: accepted
Date: 2026-11-19
Basis: The owner asked on 2026-11-19 that the "daemon is older than the app" notice be one line under the title with an update button instead of a pasted command, and proposed that the app carry a minimum daemon version set at release so that only a real conflict shows it; the owner agreed to run the command over ssh first and fall back to the manual command on failure. Evidence read: `ConnectionManager.#daemonOf`, `sshChannel`, `docs/desktop.md` on remote daemon upgrades.

## Problem

Any remote daemon older than the app showed a banner with a shell command, though most releases change only the page and the daemon does the same. The banner taught people to ignore it, and the app never did the work itself (the earlier rule was that the app does not install things on other machines).

## Decision

- `MIN_DAEMON_VERSION` in `apps/desktop/src/shared/release.ts` is the oldest daemon the app works with. A remote daemon below it is flagged; at or above it, nothing is said, even when it is older than the app. A development build, an unreadable version, and the local daemon are never flagged.
- Raise it in the release that depends on something the older daemon lacks and that cannot be turned off by a `capabilities` flag. A gate test keeps it a valid version and not later than the app's own.
- The flag is one line under the session's title bar with an "Update to x.y.z" button. After a confirmation (running sessions on that machine are interrupted), main runs the existing `daemonUpgradeCommand` on that environment's ssh host (`BatchMode=yes`, so it never asks for a password). It stops the old daemon; the connection drops and returns to the new one by itself.
- If it fails, the line shows what the machine said and the command, to run by hand. The result is counted as `daemon_upgraded { ok }`, never the message.
- This replaces the earlier rule that the app does not install anything on other machines: now it does, but only when the person clicks and confirms, and only the release's own daemon archive, checked by sha256, over the ssh they already use.

## Alternatives considered

- Keep flagging any older daemon: rejected, it nags on releases that changed nothing the daemon does.
- Negotiate only by `capabilities` and have no minimum: rejected, some changes cannot be left off; the minimum is the floor for those.
- The app downloads the archive and copies it over ssh, so the remote needs no internet: not done in this version, more to build; the manual command is the fallback. A remote that cannot reach GitHub will always fail the one-click update.
- Update through the protocol: rejected, an old daemon may not understand a new method.

## Consequences

- The minimum is raised by hand. Forgetting leaves a too-old daemon unflagged and the new feature broken on it; the release checklist in `docs/desktop.md` is the only guard besides the test of its validity. Not verified here against a real remote machine: the ssh run is covered by a fake in tests.
- The command assumes Linux x64, `curl`, `sha256sum`, and `~/.local/bin/cycle`, as before.

## Related

- [The daemon is released on its own channel and updates itself when idle](2026-11-27-daemon-releases-on-its-own-and-updates-itself-when-idle.md) (CYC-538): daemons now update themselves; the flag and button here remain the way out for one too old to.

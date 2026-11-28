# Agent Note: The daemon is released on its own channel for each commit on main and updates itself when idle, without asking

Status: accepted
Date: 2026-11-27
Basis: The owner's decisions of 2026-11-27 (CYC-538): the desktop app, the daemon and Loop update apart; the daemon has its own version; a commit on main that changes the daemon publishes it; local and remote daemons update themselves when idle with no confirmation; Loop holds new work so the daemon gets idle; the app carries a seed daemon. The owner rejected keeping the daemon in the app with an ordered restart ("没啥收益"). Evidence: `handOff` in `apps/desktop/src/main/main.ts` ran `cycle stop` before every app update and gave up when a session (Loop's included) was working.

## Problem

The daemon and the agents' binaries lived inside `Cycle.app`, and the daemon finds them beside its own executable. Replacing the app while the daemon ran would leave it starting another version's binaries, so every app update stopped the daemon first, and with Loop running sessions all day the app could not update. A daemon change could reach users only with an app release.

## Decision

- The daemon's version is `<major>.<minor>.<commits>`, apart from the app's. It runs from a folder of its own: `<CYCLE_HOME>/daemon/bin` for the app's local daemon (seeded from the one the app carries when missing or older), `<prefix>/share/cycle` on Linux. An app update no longer stops it.
- `daemon-latest` is a rolling release with, per platform, a manifest of every file by SHA-256 and the files stored by hash. CI publishes it for each commit on main whose build inputs changed, after the same binary checks and integration tests the app release runs. The manifest is signed with the interface bundles' CI key (environment `ui-release`) and says `kind: "daemon"`; the public key is built into the daemon. macOS programs are signed with the Developer ID, keeping the identifiers they have in the app, so the keychain knows them.
- An installed daemon checks the channel every 30 minutes, builds the new version beside its folder, checks it (version, and on macOS the same signing team), and switches only when nothing is working and nothing happened for 2 minutes and no terminal runs a command (changed by CYC-547: see Related). A version that does not start is rolled back and never taken again. A protocol major change is not taken automatically.
- Loop asks the daemon (`_cycle/daemon/update/read`) before taking a new work item and takes none while an update waits.

## Alternatives considered

- Keep the daemon in the app and restart in order (app first, daemon later): the running daemon would start the new app's agent binaries meanwhile; making that safe means keeping the old folder somewhere, which is moving it out anyway. Rejected by the owner.
- A daemon that hands its running turns to the new version (fd passing, adapters outside the daemon): turns would survive, but the adapters' state lives in the daemon's children over stdio; a much larger change, left for later.
- Trust the release by HTTPS and SHA-256 only: anyone who can write to the release would run code on every machine with no person in between. Signing with the CI key is the same rule as interface bundles.
- Release the daemon only by hand with a tag: the owner chose every commit on main.
- Decide "changed" by a hand-written list of paths: a missed input would leave a change unpublished without anyone noticing; the bundler's own input list is used instead.
- Count open terminals as busy: a shell left open in the right panel would block updates forever; only a terminal running a command counts.

## Consequences

- Every commit on main that changes the daemon reaches every installed daemon within about half an hour of its next idle moment, with no person approving it: the checks in `daemon-release.yml` are the only gate. A bad daemon that starts listening but misbehaves is not rolled back automatically.
- A leak of the CI key lets its holder run a daemon on every machine, as it already lets them run a page in every app.
- The update from an app before this change to the first one with it is still made by the old app, which stops the daemon and refuses while sessions work.
- macOS publishes need the Mac signing secrets on each daemon change, and use the owner's Mac when `RELEASE_RUNNER` says so (decision 0008 said only the release workflow uses it; this workflow does too).
- Not verified here: that a daemon run from `~/.cycle` keeps file access (TCC) and the keychain items without new prompts on a real Mac, and that a seeded copy is not stopped by Gatekeeper. These are listed for a person to check after merge in CYC-538.

## Related

- [A remote daemon is only flagged below a minimum version](2026-11-19-daemon-minimum-version-and-upgrade-button.md): still holds for the flag and the "Update" button, which stay as the way out for a daemon too old to update itself; what it said about the daemon's version being the app's no longer holds.
- [Interface bundles are trusted by a CI signature](2026-11-26-interface-bundles-signed-by-ci-key-not-by-github-account.md): the same key and environment sign the daemon's manifest.
- [The daemon switches between turns and drains instead of waiting for idle](2026-11-28-daemon-switches-between-turns-and-drains-instead-of-waiting-for-idle.md): partly replaces this note. The switch condition (quiet for 2 minutes) and the unbounded wait no longer hold; the rest (own channel, signing, rollback, Loop holding new work) stands.

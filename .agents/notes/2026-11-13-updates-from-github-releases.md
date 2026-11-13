# Agent Note: The app updates itself from GitHub releases, and installs only when asked

Status: accepted
Date: 2026-11-13
Basis: The owner asked for the packaged app to update itself from the releases of `OhMyJames/cycle`
(2026-11-13). old-cycle's updater (`apps/desktop/src/main/updates.ts`, its feed on R2) was read for
its shape. Electron 39.8.10. On Linux the request, redirect and download path was run in Electron
against a public repository's release; nothing that needs macOS was run.

## Problem

The app changed only through `bun run desktop:install`, on a Mac with the repository. It is signed ad
hoc, with no Developer ID, so Electron's `autoUpdater` (Squirrel.Mac) refuses it: Squirrel checks that
an update is signed by the same identity as the running app, and an ad hoc signature has none. The
repository is private, so its releases answer only to a token. And an update restarts the app, which
stops the daemon and every running turn.

## Decision

- **Where updates come from.** Only `https://api.github.com/repos/OhMyJames/cycle/releases/latest`
  and the assets it lists under that repository's own API path. A `v<version>` tag makes a release
  (`.github/workflows/release.yml`): the bundle zipped by `ditto` as
  `Cycle-Codex-<version>-darwin-arm64.zip`, and `latest-darwin-arm64.json`,
  `{ version, platform, arch, file, sha256, size }` (`apps/desktop/src/shared/release.ts`, the one
  definition, which the release script writes and the updater reads). The tag must equal the version
  in `apps/desktop/package.json`. Versions are plain `major.minor.patch`.
- **The token.** In the main process only: `GH_TOKEN` or `GITHUB_TOKEN` from the owner's login shell
  environment, or else what `gh auth token` prints on that shell's `PATH`, read again at each check
  and kept nowhere. With none, GitHub is asked without one, which works once the repository is
  public. It is sent as a header to `api.github.com`; redirects are followed by hand, and the header
  goes along only to the same host, so GitHub's file storage never sees it. It is in no state the
  page is sent, no message, no file and no log.
- **What is verified.** The archive's size and SHA-256 against the manifest of the same release; the
  manifest's version, platform and architecture against the release and this Mac; then, of the
  unpacked bundle, `CFBundleIdentifier` is `dev.cycle.codex`, `CFBundleVersion` is the release's, and
  `codesign --verify --deep` passes. The bundle is looked at again when the owner installs it.
- **What is replaced.** Only the running bundle, only if it is named `Cycle Codex.app`, its own
  identifier is `dev.cycle.codex` and its folder can be written; otherwise the page says why. The new
  bundle is moved beside it under a hidden name, then a detached `/bin/sh` helper, given its paths as
  arguments, waits for the app to quit, renames the old bundle aside, renames the new one into place,
  puts the old one back if that fails, and opens the app. What it said is `updates/install.log`.
- **When.** A check 15 seconds after the app starts, every four hours, and when the owner asks in
  Settings, About. A found update is downloaded to `CYCLE_HOME/updates` in the background. It is
  installed only when the owner clicks "Restart to update", which says that running turns stop.

## Alternatives considered

- Electron's `autoUpdater`. Rejected: Squirrel.Mac needs a Developer ID signature.
- A Developer ID and notarization. Not yet: it costs an Apple account and secrets in CI for an app
  with one user. Without them a copy downloaded with a browser is quarantined, and the first install
  on a new Mac needs `xattr -dr com.apple.quarantine`; what the updater downloads carries no such mark.
- A signing key of Cycle's own over the manifest. Not yet: its private half would live in the same
  GitHub repository's secrets, so it would add nothing against someone who can publish a release.
- Installing on quit or at night, as old-cycle retried a waiting restart. Rejected: a schedule's run or
  a long turn would be stopped with nobody there to see it.
- `electron-updater` and electron-builder. Rejected: the app is assembled by `package-app.ts`, with no
  packager, and they bring Squirrel's requirement with them.
- A feed on R2, as old-cycle had. Rejected: a second place to publish and to hold keys for, where
  GitHub already holds the code.

## Consequences

- Integrity rests on GitHub over TLS and the hash in the same release. Whoever can publish a release
  in the repository can replace the app, and so run commands as the owner. This is the `shortcut:`
  at the top of `apps/desktop/src/update/updater.ts`.
- While the repository is private, a Mac with no token and no `gh` sign-in finds no updates, and About
  says so.
- Requests go through Chromium's network stack (`net.request`), so they follow the system's proxy, not
  the shell's `HTTPS_PROXY`.
- Releases are built for Apple silicon only. An Intel Mac is told the release has no build for it.
- A downgrade is never offered: only a version later than the running one counts.
- The daemon is stopped by the app quitting, as on any quit; the helper does not wait for the daemon.

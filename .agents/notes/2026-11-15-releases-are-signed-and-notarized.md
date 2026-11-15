# Agent Note: Releases are signed with the Developer ID and notarized

Status: accepted
Date: 2026-11-15
Basis: The owner's Developer ID Application identity (Shanghai Xiadian Intelligent Technology Co.,
Ltd., team `AGKXLGRXJ7`) and its App Store Connect API key, both held on the owner's Mac mini.
`@electron/osx-sign` 2.7.2 and `@electron/notarize` 3.1.2, Electron 39.8.10.

## Problem

`bun run desktop:package` signed the bundle ad hoc. A copy downloaded with a browser carried the
quarantine mark, and Gatekeeper refused it: an ad hoc signature has no Developer ID and no
notarization ticket, so every download needed `xattr -dr com.apple.quarantine` or "Open Anyway". The
in-app updater was unaffected, because it downloads without quarantine, but a release could not be
handed to another Mac.

## Decision

- The release workflow imports the identity into a temporary keychain from
  `APPLE_CERTIFICATE_P12` and `APPLE_CERTIFICATE_PASSWORD`, and deletes that keychain afterwards.
- `apps/desktop/src/package/sign.ts` signs the packaged bundle with `@electron/osx-sign`: inside out,
  hardened runtime, a secure timestamp, and osx-sign's default entitlements. `--deep` is not used
  for signing.
- `@electron/notarize` submits the signed bundle with the App Store Connect API key
  (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) and staples the ticket. The workflow then
  asks `spctl` whether the bundle is accepted before it archives and publishes it.
- The zip is made after signing and stapling, so the manifest's size and SHA-256 cover the notarized
  bundle. `bun run desktop:install` still builds ad hoc, for this Mac only.

## Alternatives considered

- Keep ad hoc signing and tell people to remove the quarantine. Rejected: every browser download
  looks broken, and it is not a way to give the app to someone else.
- Package with electron-builder or Electron Forge to get signing. Rejected: the app is assembled by
  `package-app.ts`, and osx-sign with notarize does the same work without a packager.
- Sign only the app, not the binaries under `Contents/Resources/app` (the compiled daemon, codex and
  its helpers). Rejected: notarization rejects unsigned nested code.
- A key of Cycle's own over the manifest, instead of Apple's signature. Still rejected: it would not
  satisfy Gatekeeper, and its private half would live in the same repository's secrets.

## Consequences

- The release workflow needs five secrets and an Apple Developer account. A rotated certificate or
  API key means replacing them.
- Signing adds a few minutes to a release, mostly notarization; the job stops if `spctl` refuses the
  bundle.
- `bun run desktop:package` and `desktop:install` remain ad hoc; only a release is notarized.
- The update's `codesign --verify --deep` check still passes, now against the Developer ID signature.

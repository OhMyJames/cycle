# Agent Note: Interface bundles are trusted by a CI signature checked against a key inside the signed app, and they are published to one rolling release

Status: accepted
Date: 2026-11-26
Basis: CYC-461 (Design) and CYC-469 (Intent, Spec, Design, Plan), with the user's decisions of 2026-11-26: trust by CI private-key signature, `localStorage` must survive a change of page, and the old alpha path is to be retired afterwards (CYC-468).

## Problem

The app can load its page from outside the app (a folder in the user's data directory) so that a change to the page needs no release. That page runs with `window.cycle`, which can drive the local daemon, files and terminals. What makes a page acceptable has to be decided, and the obvious alternatives are tempting to bring back.

## Decision

A page is loaded only if its manifest carries an Ed25519 signature made by a key whose public half is built into the signed and notarized app (`UI_KEYS`, by `keyId`), for the same shell hash as the app, with a `uiVersion` above the highest seen. The files are hashed against the manifest on download, after unpacking, and again each time a page is chosen. The private key is a secret of the GitHub Environment `ui-release`, usable only from `main`. The bundled page is never removed and is the last fallback. A page must report that it has drawn itself within 15 s, or it is marked bad. With no public key built in, the feature is off. Bundles are published to one rolling pre-release `ui-latest` (not a `v` tag), read by download URL.

## Alternatives considered

- Trust whatever the repository's release holds (HTTPS and a SHA-256 in the manifest): anyone with write access to the release, or a stolen token, would then run code with `window.cycle` on every installed app. The manifest's hash only proves the file matches the manifest, not who made it.
- One GitHub release per commit: about 190 page-only commits a week would push real `v` releases out of the 20 the updater reads, and cost API limit to find them.
- A separate API or protocol version to say which pages fit which shell: it has to be kept in step by hand. The hash of `main.mjs` and `preload.cjs` changes whenever either changes, so nothing is kept.
- Hashing the native module as part of the shell: signing changes its bytes, so the hash would differ between the build and the signed app.
- Loading the page from a custom scheme or an `asar`: a new origin would lose `localStorage` (drafts, pins); an `asar` needs the integrity machinery this project removed from packaging.
- Putting the signature inside the manifest JSON: needs canonical JSON to verify; a separate signature file signs the exact bytes.
- Keeping the local alpha for fast iteration: a self-signed, team-less build has a new code identity each time and asks for the keychain again each time; once pages update without a release it is not needed (CYC-468).

## Consequences

- A leak of the signing key lets its holder run a page in every app that trusts it, until a release removes the key: rotate by adding a new `keyId` in a release, signing with it, then dropping the old one.
- Anyone who can write to the user's `<userData>/ui/` can at worst make the app fall back to the bundled page; a changed file fails its hash. Same-user code is out of scope, as it can change the app itself.
- If a build of the shell stops being byte-identical between the release runner and `ui-release`, bundles are silently not found. This is checked at release time against the shell recorded in the release manifest.

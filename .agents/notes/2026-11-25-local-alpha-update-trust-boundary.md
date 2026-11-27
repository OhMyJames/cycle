# Agent Note: A local alpha update is checked by certificate name, not pinned, and does not guard against the same user

Status: superseded (2026-11-27, CYC-468: the local alpha path was removed; interface changes reach the app as signed bundles, see 2026-11-26-interface-bundles-signed-by-ci-key-not-by-github-account)
Date: 2026-11-25
Basis: CYC-417 and the locked CYC-414 Design, "签名与钥匙串" (updater gets a second source, the alpha repository in `<CYCLE_HOME>/alpha/`)

## Problem

The updater can now install from a folder on the same machine. The GitHub source is held to the running app's signing team, but a local alpha is signed with a self-signed certificate ("Cycle Alpha (local)") that has no team, so that rule would refuse every local alpha. Something has to take its place, and its limits need to be written down so nobody takes it for more than it is.

## Decision

A local source must pass: the archive's size and SHA-256 match its `manifest.json`; the bundle's signature verifies (`codesign --verify --deep --strict`); and the first `Authority=` of `codesign -dv` (the leaf certificate that signed it) is named "Cycle Alpha (local)". It does not need the same team. A GitHub source keeps the same-team rule unchanged.

The certificate is matched by its name, not pinned (no fingerprint, no keychain lookup of the exact certificate). The check protects against a broken, half-copied, or wrong package in the folder, such as another app, another platform or an unsigned build. It is not a defence against someone who can already write to `<CYCLE_HOME>/alpha/` as this user: they can create a certificate with the same name, and they can already run code as the user, replace the app, or edit the repository's manifests. Local alpha is a developer's own-machine path; it is not a distribution channel.

## Alternatives considered

- Pin the certificate's fingerprint: needs the fingerprint recorded and rotated with the certificate each time it is recreated, and gives nothing against an attacker who is already the same user. Not worth the upkeep for this threat.
- Accept any valid signature for a local source: lets in any package that is signed by anything, including a different app; the name check costs one line and catches misplaced packages.
- Keep the same-team rule: refuses every alpha, since a self-signed certificate has no team.

## Consequences

- A same-user attacker is out of scope here, as it is for the whole `CYCLE_HOME`.
- Recreating the certificate under the same name keeps working without any change to the app.
- If the local repository is ever shared between users or fetched from elsewhere, this check is not enough and a pinned certificate has to be reconsidered.

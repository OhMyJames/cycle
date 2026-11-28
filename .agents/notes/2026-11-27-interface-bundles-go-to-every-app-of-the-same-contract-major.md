# Agent Note: Interface bundles go to every app of the same contract major, and a type check against a committed snapshot decides when the major must rise

Status: accepted
Date: 2026-11-27
Basis: The user's request of 2026-11-27 to separate the desktop, daemon and interface releases ("ui 的更新不依赖 desktop 的壳"), and agreement the same day that the "no separate API version" choice of the earlier note may be overturned; CYC-539. Evidence: 18 shell hashes on `ui-latest` in two days; after 0.3.39 a single added method (`workspaceRepo`, CYC-533) stopped every 0.3.39 app at interface 1024.

## Problem

Matching bundles to apps by a hash of the preload and the API's source means any change to `api.ts`, including adding one method, cuts every installed app off from all later pages until the next app release. Most API changes are additions. Interface updates were meant to let page changes reach installed apps between releases; with the hash they rarely did. In addition, page updates were paused whenever an app update was available, which with frequent releases is most of the time.

## Decision

- An app takes bundles of its contract major (`CONTRACT_MAJOR`, recorded in `build.json` as `contract`), whatever app version built them, published as `ui-c<major>.json` (manifest `v: 2`). The shell hash is gone. Signing, keys, the per-file checks, the boot check and the fallback stay as in the earlier note.
- Only "page as new as the app or newer" ever happens (a bundle at or below the app's own page is refused). So within a major, a change is allowed when the older app can serve the newer page: for methods in both, the new arguments are accepted by the old ones (extra arguments only optional, at the end), and the old answers are accepted by the new type; every old event variant is accepted by the new event type. Added methods and events are allowed. Removing a method is a break although the page no longer calls it, because the check compares with the last commit only (see Consequences).
- The check is a TypeScript type comparison in `bun run typecheck` between the current `api.ts` and a committed declaration snapshot of the previous one (`apps/desktop/test/ui-contract/`). A test requires the snapshot to be current and its imports to resolve. The snapshot only moves through `bun run --cwd apps/desktop ui-contract`, which refuses an incompatible change unless the major was raised, and refuses a change of the protocol SDK version or of the preload source (which the type check cannot judge) unless the major was raised or a reason is given.
- The page fills in methods the older app lacks with ones that reject (`renderer/bridge.ts`), so a call fails like a refused call instead of throwing a `TypeError`. Every API method must return a promise; the check enforces it.
- Page updates pause only while the app is being downloaded or installed, not while an update is merely available.
- Apps before this change (0.3.36–0.3.40) keep reading `ui-<shell>.json`, which is no longer published to; they get new pages with the next app update.

## Alternatives considered

- Keep the shell hash (the earlier note): exact, needs no human judgement, but as the evidence shows it blocks almost every bundle in practice.
- Compare the API's source text, normalised, and allow only appended text: cheap but wrong in both directions (a reordering is "incompatible", a narrowed type in place may look like an addition).
- A per-method list in the manifest, and the app refusing a bundle whose methods are not all its own: brings back "every addition blocks old apps", which is the problem.
- Check compatibility against the base commit in CI (git history) instead of a committed snapshot: the check job uses a shallow clone, and a snapshot also makes the contract visible in review.
- A hand-kept version only (no type check): the earlier note rejected it because it drifts; the type check keeps the hand-kept part to what types cannot show (behaviour), as `CONTRACT_REV` did before.

## Consequences

- Page-only commits, and commits that only add to the API, reach installed apps of the same major between releases.
- A change in what the main process does for an unchanged type is invisible to the check; the person making it must raise the major. The 15 s boot check and fallback remain the safety net.
- The snapshot chain compares each commit with the one before. Breaks spread over two compatible-looking steps would pass: for methods this is closed by counting a removal as a break; for fields (one removed, then added back with another type) it is documented rather than guarded (`shared/contract.ts`: give it a new name). Keeping every snapshot of a major and checking against each was the alternative; it was not done for its size.
- Arguments added at the end as optional, and fields added to what the page sends (required or not), are ignored by older apps: a page must not rely on an older app honouring them.
- Some compatible changes are flagged (making an optional parameter required, removing a trailing optional one): they cost a major bump, which is safe.
- The type comparison is only as good as its inputs: an import of the snapshot that does not resolve turns types into an error type that passes everything, so the resolution test is part of the gate, not optional.

## Related

- [Interface bundles are trusted by a CI signature checked against a key inside the signed app](2026-11-26-interface-bundles-signed-by-ci-key-not-by-github-account.md): signing, keys and publishing still hold; its matching by shell hash and its rejection of a separate API version are replaced here.
- [The daemon is released on its own and updates itself when idle](2026-11-27-daemon-releases-on-its-own-and-updates-itself-when-idle.md): the other half of separating the releases (CYC-538).

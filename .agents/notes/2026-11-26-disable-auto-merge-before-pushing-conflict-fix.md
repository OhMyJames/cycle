# Agent Note: Turn auto-merge off before pushing a conflict resolution

Status: accepted
Date: 2026-11-26
Basis: CYC-435 (from CYC-411 Design, "关自动合并"); GitHub documentation on auto-merge.

## Problem

When the Loop finds a conflict after auto-merge was enabled, it merges main into the branch and pushes the resolution. Per GitHub's documentation, a push by someone with write access does not turn auto-merge off, and the Loop's token has write access. The resolution commit would then merge as soon as CI is green, skipping a second review of code nobody has reviewed.

## Decision

Before handling any conflict, at every trigger point, `#handleConflict` reads `autoMergeRequest` and runs `gh pr merge --disable-auto` if it is on. If it cannot be read or turned off, the run is Blocked and nothing is pushed. Auto-merge is enabled again only when the review says merge after the new CI run. The read-then-disable stays even if testing shows GitHub does turn it off itself: it is safe either way.

## Alternatives considered

- Rely on GitHub dropping auto-merge on push: contradicts the documentation for write-access pushers.
- Change branch rules (e.g. dismiss stale approvals): out of scope for this item.

## Consequences

One extra read per conflict. Do not remove the step as redundant. A ticket put back after `merge_timeout` may still have auto-merge on, which is why every trigger checks.

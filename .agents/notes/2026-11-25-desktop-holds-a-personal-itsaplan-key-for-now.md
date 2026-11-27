# Agent Note: The desktop main process holds the user's own itsaplan key in a 0600 file until SSO exists

Status: accepted
Date: 2026-11-25
Basis: CYC-384 research (option C) and the user's answer of 2026-11-25 to "key 怎么放进去？": "手放一个 0600 文件（推荐）"; ticket CYC-386.

## Problem

The Loop page shows the real itsaplan board. The desktop acts as the person, so it needs that person's key. CYC-384 settled that the desktop reads the board itself but left open where the key is stored.

## Decision

- A file in the desktop app data dir, mode 0600, written by hand by the user. No settings UI and no environment variable: the daemon is spawned locally and would inherit an environment variable, and so would every agent session.
- Only the desktop main process reads it. The page gets board data through the `packages/ui/src/api.ts` bridge and never the key.
- This is a transition. It is replaced when the SSO credential exists; then the file goes away.

## Alternatives considered

- Environment variable: rejected, since the daemon is spawned locally and agent sessions would inherit it.

## Consequences

- A user must create the file by hand; with no file the page says the board is not connected.
- A same-user process can read the file. Not verified: that an agent session cannot read the app data dir.

## Related

- [`loop/` API 是读写工单的唯一入口](2026-11-26-loop-api-is-the-only-way-in.md):部分取代本条。桌面端迁过去之后，不再自己读写 itsaplan;本条关于密钥存放的部分在那之前仍然适用。

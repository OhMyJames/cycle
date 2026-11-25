# Agent Note: agy's isolated HOME gets its own empty-password keychain

Status: superseded
Date: 2026-11-25
Basis: CYC-316 and CYC-327 (itsaplan); the user ran the keychain experiment by hand on 2026-11-25 and accepted the empty password ("我接受空密码"); code in `harness/agy/src/keychain.ts`, merged in PR #221.
Superseded by: [Claude and Codex keep host HOME; agy isolates HOME with file token storage and hardened fallback keychain](2026-11-25-agent-home-and-keychain-isolation.md)

## Problem

Cycle runs `agy` with an isolated `HOME`. On macOS that HOME has no default keychain, so every start showed "A keychain cannot be found to store 'antigravity'". The OAuth token has to be stored somewhere other than the user's own login keychain, since Cycle never touches the host HOME.

## Decision

Before launching `agy` on darwin, the adapter makes sure `<HOME>/Library/Keychains/login.keychain-db` exists, is the default keychain for that HOME, and is unlocked. The keychain is created with an **empty password**. It never touches the host keychain, never reads or logs keychain contents, and a failure only logs a warning and does not stop `agy` from starting. Other platforms do nothing.

## Alternatives considered

- Leave the popup and have the user click through it: rejected, it blocks unattended runs of the auto loop.
- Create the keychain with a random password and keep it somewhere: not chosen, because then Cycle would have to store a secret for a keychain that only guards a token already kept in a file under the same HOME.
- Use the host login keychain: rejected, the isolated HOME exists so that Cycle does not touch the host's.

## Consequences

Anyone who can read the files under the isolated HOME can also open this keychain, so it adds no protection beyond the file permissions of that directory. The user accepted this. Not verified: that the popup is gone after a daemon restart with new `agy` sessions on a real machine; only the experiment steps and unit tests with a fake runner were run.

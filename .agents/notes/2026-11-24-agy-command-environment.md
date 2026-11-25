# Agent Note: Deliver session environment variables to agy commands through ZDOTDIR and BASH_ENV

Status: accepted
Date: 2026-11-24
Basis: Owner request of 2026-11-24 (CYC-314) to fix Cycle Environment variables not reaching `agy` commands, plus observed `agy` 1.5.16 `run_command` shell invocation (`zsh -c` without `-f`, forwarding `ZDOTDIR` / `BASH_ENV` while ignoring them in the `agy` process itself).

## Problem

[2026-11-24-work-in-and-environments](2026-11-24-work-in-and-environments.md) kept Cycle Environment variables out of every agent's own process (AGENTS.md red line) and gave them to commands only: Claude via `CLAUDE_ENV_FILE`, Codex via `shell_environment_policy.set.<NAME>`, and `agy` not at all because `agy acp` exposes no dedicated command-env flag. In practice, users expect a selected Environment (for example `GH_TOKEN`) to work in `agy` sessions just like Claude and Codex.

## Decision

Deliver session environment variables to `agy`'s shell commands via a per-session startup script, parallel to Claude's `CLAUDE_ENV_FILE`, without placing any session variable values into `agy`'s own process environment:

- On launch of an `agy` session with non-empty `sessionEnv`, the daemon writes `<dataDir>/agy-env/<sessionId>/.zshenv` (directory `0700`, file `0600`, atomic temp-and-rename; `<dataDir>/agy-env` is cleared when the daemon starts).
- The script optionally sources `$HOME/.zshenv` when running under zsh (`ZSH_VERSION`), exports each validated variable as a single-quoted shell word, and ends with `unset ZDOTDIR BASH_ENV` so interactive/login subshells keep using `$HOME` and nested `zsh -c` / `bash -c` invocations can override variables cleanly.
- The `agy` adapter receives only `sessionEnvDir` in `CYCLE_ADAPTER_CONFIG` (never variable values) and passes `ZDOTDIR=<dir>` and `BASH_ENV=<dir>/.zshenv` only to the spawned `agy acp` process (not `planUsage` or `pluginReader`).
- New sessions carrying non-empty `sessionEnv` skip taking a prewarmed `standby` process (`apps/daemon/src/daemon.ts`), so the spawned `agy` process always carries that session's `ZDOTDIR` / `BASH_ENV`; sessions without variables still take `standby`.
- Add `ZDOTDIR` and `BASH_ENV` to `RESERVED_VARIABLES` in `@cycle/protocol` and `@cycle/ui` (alongside `CLAUDE_ENV_FILE`).
- Remove the blank-conversation warning saying Antigravity commands do not receive environment variables.

## Alternatives considered

- **Inject session variables directly into `agy acp`'s process environment.** Rejected: violates the AGENTS.md red line; variables such as `GOOGLE_APPLICATION_CREDENTIALS` or proxy settings could silently alter `agy`'s own authentication, billing, or transport.
- **Rewrite `run_command` arguments via `agy` `PreToolUse` hook `overwrite`.** Rejected: exposes secret values in recorded command text and injects rewrite notices into tool results.
- **Keep `agy` commands without environment variables.** Rejected by the owner in CYC-314 after `GH_TOKEN` in a Cycle Environment failed to reach `agy` commands.

## Consequences

- `agy`'s `zsh -c` (macOS) and `bash -c` (Linux) commands receive session environment variables while `agy`'s own process environment stays on the explicit allowlist.
- Known limitation: commands invoked through POSIX `/bin/sh -c` (e.g. `dash` on Linux when not using `bash` or `zsh`) or Windows `cmd`/`PowerShell` do not read `ZDOTDIR` or `BASH_ENV`.
- Verified: unit tests for `env-dir`, `server.ts`, `daemon.ts` standby skip, `RESERVED_VARIABLES`, fake-agy stdio integration test spawning real `zsh -c` / `bash -c`, and browser UI tests. Not verified: live authenticated `agy` real-model turn (`CYCLE_AGY_REAL_HOME`) on Linux or Windows.

## Related

- Partially replaces [2026-11-24-work-in-and-environments](2026-11-24-work-in-and-environments.md) for the `agy` command-variable delivery item only; the Work in / Environment split, snapshot model, reserved-variable rules, and Claude / Codex delivery remain unchanged.

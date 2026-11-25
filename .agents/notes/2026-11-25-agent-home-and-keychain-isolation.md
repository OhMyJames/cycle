# Agent Note: Claude and Codex keep host HOME; agy isolates HOME with file token storage and hardened fallback keychain

Status: accepted
Date: 2026-11-25
Basis: CYC-401 and CYC-402 (itsaplan); isolated real-binary experiments on 2026-11-25 against `claude 2.1.331` (`@anthropic-ai/claude-agent-sdk 0.3.331`), `codex 0.171.0`, and `agy 1.5.17` in synthetic `/tmp` host HOMES with temporary macOS keychains and sentinel files (never touching real host `~/.claude`, `~/.codex`, `~/.gemini`, or login keychain); user approval on 2026-11-25.
Supersedes: [agy's isolated HOME gets its own empty-password keychain](2026-11-25-agy-isolated-home-gets-its-own-empty-password-keychain.md)

## Problem

Previously, Cycle overrode `HOME` for all three agents (`<dataDir>/claude`, `<dataDir>/codex`, `<dataDir>/agy`) to keep them away from the user's host logins. On macOS, a directory without `Library/Keychains/login.keychain-db` has no default keychain, causing repeated "A keychain cannot be found" dialogs across agent auth, session start, and subprocesses such as `git` (`osxkeychain`). CYC-327 added a private empty-password keychain for `agy`'s `launch()` path only, leaving Claude unhandled, Codex missing MCP OAuth file storage, `agy` missing 5 other entry points (`agy models`, `agy acp --login`, `logout`, `AgyPlugins`, `cycle login agy`), and the private keychain missing `set-keychain-settings` (allowing macOS's 5-minute auto-lock) and `list-keychains -s`.

## Decision

Isolate each agent according to what its real binary supports, rather than forcing one `HOME` strategy on all three:

1. **Claude keeps host `HOME` and isolates via `CLAUDE_CONFIG_DIR`.**
   - `claude.allowEnv` includes `"HOME"` by default (`claudeEnv` still falls back to `CLAUDE_CONFIG_DIR` when no `HOME` is inherited, e.g. minimal environments or tests, and always overrides `CLAUDE_CONFIG_DIR` to `<dataDir>/claude` or `config.claude.configDir`).
   - Verified on `claude 2.1.331`: with host `HOME` and isolated `CLAUDE_CONFIG_DIR`, Claude never reads or writes host `~/.claude` or `~/.claude.json`, stores macOS Keychain credentials under `Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[:8]>` without reading the host's unhashed `Claude Code-credentials` entry, works without `USER` in env, and `claude auth logout` removes only the hashed entry.
   - `claudeHarness.cli.executable` resolves `claudeExecutable() ?? sdkBundledClaude() ?? Bun.which("claude")` so `cycle login claude` and the daemon use the same binary signature in dev mode and avoid macOS Keychain ACL prompts.

2. **Codex keeps host `HOME` and isolates via `CODEX_HOME` and file credential stores.**
   - `codex.allowEnv` includes `"HOME"` by default (`codexEnv` falls back to `CODEX_HOME` when no `HOME` is inherited and always sets `CODEX_HOME`).
   - `CODEX_FIXED_ARGS` passes both `-c cli_auth_credentials_store="file"` and `-c mcp_oauth_credentials_store="file"` (verified on `codex 0.171.0` CLI and `app-server`).
   - `AppServer` and `loadBundledModels` run with `cwd: config.env.CODEX_HOME` instead of host `HOME`.

3. **Antigravity (`agy`) keeps isolated `HOME`, forces file token storage, and hardens the fallback keychain across all entry points.**
   - Verified on `agy 1.5.17`: `GEMINI_HOME` does not exist, and `ANTIGRAVITY_GEMINI_DIR`, `ANTIGRAVITY_APP_DATA_DIR`, `ANTIGRAVITY_CONFIG_REL_DIR`, and `XDG_CONFIG_HOME` are ignored by `agy models`, `agy plugin list`, and `agy acp --login`. Only `agy acp` accepts `--gemini-dir <abs>`; `agy models`, `agy plugin`, and `agy -p "/usage"` reject it and read/write `$HOME/.gemini` directly. Passing host `HOME` to `agy` would therefore violate Cycle's isolation boundary.
   - Verified on `agy 1.5.17`: `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` is honored by both `agy models` and `agy acp --login` (`composite_token_storage.go:207] Using file-based token storage because AGY_CLI_FORCE_FILE_TOKEN_STORAGE is set`), bypassing macOS Keychain completely. `agyEnv` sets `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` by default (overridable via `agy.env`), covering all `agy` entry points.
   - `harness/agy/src/keychain.ts` (`ensureKeychain`) remains as defense-in-depth for older `agy` versions (`1.5.10`–`1.5.15`), plugin keychains, or commands inside the isolated `HOME`, hardened with: `set-keychain-settings` (no auto-lock timeout / no lock-on-sleep), `list-keychains -s`, in-process concurrency deduplication, an explicit `hostHome` guard that refuses to touch the host's keychain, and wiring into `launch`, `createAgySetupProvider` (`probeAuth`, `start`, `logout`), `AgyPlugins`, and `cycle login agy` / `cycle agy`.

4. **Managed storage discovery uses each harness's managed directory (`storageDir`), not `env.HOME`.**
   - `storage.ts` resolves each agent's managed directory via `harness.storageDir` (`CLAUDE_CONFIG_DIR` for Claude, `CODEX_HOME` for Codex, isolated `HOME` for `agy`) so passing host `HOME` to Claude and Codex never causes `storage.ts` to treat host `HOME` as managed or mark Claude/Codex unmanaged.

## Alternatives considered

- **Pass host `HOME` to `agy` as well (uniform Route A):** Rejected after `agy 1.5.17` experiments showed `agy models`, `agy plugin`, and `agy -p "/usage"` ignore all directory env vars and `--gemini-dir`, directly reading and writing host `~/.gemini`.
- **Keep isolated `HOME` for Claude and Codex and build a shared empty-password keychain module (uniform Route B):** Rejected for Claude and Codex because both already provide clean directory/credential isolation (`CLAUDE_CONFIG_DIR` hashed keychain entry; `CODEX_HOME` + file stores), and keeping host `HOME` avoids breaking `git`/`gh`/`ssh` configs and macOS Keychain inside sessions.
- **Remove `ensureKeychain` for `agy` and rely solely on `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1`:** Not chosen because `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` is an upstream internal env var that older supported versions (`>= 1.5.10`) or future changes might not honor, and commands run inside `agy`'s isolated `HOME` may still query the default keychain.

## Consequences

- Claude and Codex sessions on macOS stop triggering "Keychain Not Found" dialogs and let session commands use host `git`/`gh`/`ssh` configuration while keeping agent logins isolated.
- `agy` skips macOS Keychain via `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` across all entry points while keeping `~/.gemini` strictly isolated and backed by a non-expiring empty-password fallback keychain.
- Known limitation (verified): on a macOS host reached over headless SSH where the user's host `login.keychain-db` is locked, `claude`'s `security` lookup blocks waiting for keychain unlock (and hits the daemon setup timeout rather than falling back to `.credentials.json`). Users in that setup must unlock the login keychain (`security unlock-keychain`) or configure `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` in `config.json`.
- Known limitation: `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` is not part of a documented public `agy` contract; if upstream renames or removes it, the hardened `ensureKeychain` fallback still prevents dialogs.
- Verified: isolated synthetic-HOME real-binary tests for `claude 2.1.331`, `codex 0.171.0`, and `agy 1.5.17`, plus unit tests. Not verified: live signed-in end-to-end desktop daemon restart across all three real accounts simultaneously.

## Related

- Supersedes [agy's isolated HOME gets its own empty-password keychain](2026-11-25-agy-isolated-home-gets-its-own-empty-password-keychain.md)
- [docs/adapters/claude.md](../../docs/adapters/claude.md)
- [docs/adapters/codex.md](../../docs/adapters/codex.md)
- [docs/adapters/agy.md](../../docs/adapters/agy.md)

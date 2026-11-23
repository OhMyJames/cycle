# Agent Note: agy terms, external binary distribution, and telemetry default

Status: accepted
Date: 2026-11-23
Basis: Owner decision on CYCL-169 (2026-11-23, epic CYCL-153); research and real-account probe in [docs/adapters/agy.md](../../docs/adapters/agy.md) (CYCL-157, CYCL-168).

## Problem

Integrating Google Antigravity CLI (`agy`) into Cycle raises three non-engineering policy questions before shipping:

1. **Terms of Service (Section 6)**: Antigravity's terms broadly prohibit accessing the service through third-party software (specifically citing OAuth token extraction or proxy tools), while Google's own documentation explicitly instructs external editors to spawn `agy acp` as a subprocess.
2. **Binary distribution**: `agy` is proprietary software (101–216 MB per platform) whose terms contain no redistribution grant and whose binary auto-updates in the background.
3. **Telemetry flag**: `agy acp` accepts `--disable-telemetry`, which controls a setting between the user and Google.

## Decision

1. **Allow shipping agy support in Cycle as a local application**: Cycle spawns the user's unmodified official `agy` binary locally over its documented public `agy acp` stdio protocol for a single user, and **never reads, stores, or forwards `agy` credentials** (hard red line). Because Cycle runs as a local application driving the official CLI over its documented editor protocol rather than an OAuth-extracting third-party client or multi-tenant proxy, shipping agy support is accepted.
2. **Do not bundle or redistribute the `agy` binary**: Cycle uses the `agy` binary already installed on the host (or remote SSH host), located in order via `config.json` (`agy.executable`) -> `~/.local/bin/agy` -> `PATH`, with a minimum version check (`>= 1.5.10`). When missing or outdated, `_cycle/agents/list` marks `agy` as `available: false` and the UI instructs the user how to install or upgrade it using Google's official installer.
3. **Do not silently override telemetry by default**: Cycle leaves `agy`'s telemetry setting to the user's own preference by default (does not pass `--disable-telemetry` unless the user explicitly sets `agy.telemetry: false` in `config.json`). Automated tests and probes continue passing `--disable-telemetry` explicitly.

## Alternatives considered

- **Bundle `agy` inside the daemon/desktop package (like Claude/Codex)**: Rejected. Antigravity's terms grant no redistribution license, bundling adds 101–216 MB per platform, and a shipped binary would conflict with `agy`'s built-in background auto-updater.
- **Refuse or hide `agy` integration due to Section 6 wording**: Rejected. Google officially documents spawning `agy acp` from third-party editors (Zed, JetBrains, Xcode, Android Studio), and Cycle operates strictly as a local client speaking the public ACP protocol without touching credentials.
- **Force `--disable-telemetry` unconditionally**: Rejected. Telemetry is an account-level preference between the user and Google; exposing an opt-out knob (`agy.telemetry: false`) respects user control without silently mutating their preference.

## Consequences

- **Benefits**: Keeps Cycle compliant with proprietary binary non-redistribution, avoids fighting `agy`'s auto-updater, keeps daemon tarball sizes unchanged, and establishes an explicit credential non-access red line.
- **Costs**: Users (including on remote SSH hosts) must install `agy` separately before using it in Cycle, unlike bundled harnesses (`claude`, `codex`).
- **Known limitations**: Because `agy` auto-updates independently (observed upgrading from `1.5.12` to `1.5.15` in the background during CYCL-168), `harness/agy` must enforce the minimum version floor (`1.5.10`), tolerate unknown ACP v1 updates gracefully, and keep an integration check against real `agy acp`.

## Related

- [docs/adapters/agy.md](../../docs/adapters/agy.md)
- [2026-11-19-workspace-layout-and-direct-acp-sdk.md](2026-11-19-workspace-layout-and-direct-acp-sdk.md)

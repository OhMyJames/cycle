# Agent Note: Loop isolates credentials in a dedicated delivery repo, clean git/gh environments, temporary verify HOMEs, exact command shapes, and outbound secret redaction

Status: accepted
Date: 2026-11-27
Basis: Epic CYC-470 (`[CYC-470] Design` §3), tickets CYC-471, CYC-472, CYC-473, CYC-478; security review of 2026-11-26; code in `cloud/loop/src/ports/git.ts`, `ports/github.ts`, `env.ts`, `policy.ts`, `secrets.ts`, `plan-mcp.ts`.

## Problem

The 2026-11-26 security review demonstrated four concrete escape paths in the original narrow boundary (`2026-11-25-auto-loop-runs-unattended-with-a-narrow-boundary.md`):

1. Session-written code running in a worktree could edit the shared `.git/config` (`url.*.insteadOf`, `core.sshCommand`, `include.*`), exfiltrating `GH_TOKEN` / `SSH_AUTH_SOCK` on Loop's next authenticated `git fetch` or `git push`.
2. `verifyEnv` inherited the user's real `HOME`, letting verification or `bun install` lifecycle scripts read `~/.cycle/loop.json` or `~/.config/gh` via `$HOME`.
3. `policy.ts` matched allowed dev commands by prefix (`startsWith`) and skipped unquoted glob checks for dev/QA/review roles, allowing flag injection (`git branch --show-current --no-show-current -D other`, `bun test --preload`, `bun install -g`, `git add -f`, `git commit --template`) and glob traversal (`cat .?/.?/.?/.cycle/loop.json`).
4. Outbound PR bodies, PR comments, and tracker comments did not pass through a shared secret-redaction filter.

## Decision

Harden all host-level boundaries in code (partially superseding the boundary mechanisms of [2026-11-25-auto-loop-runs-unattended-with-a-narrow-boundary](2026-11-25-auto-loop-runs-unattended-with-a-narrow-boundary.md)):

1. **Dedicated delivery bare repo (`<stateDir>/delivery.git`)**: Authenticated `git fetch` and `git push` run **only** inside `<stateDir>/delivery.git`, whose `config` is written and hashed by Loop at startup. Commits move from worktrees into `delivery.git` via credential-free local `git fetch`, and `repoRoot`'s `origin/main` updates from `delivery.git` without credentials. Before pushing, Loop re-verifies both `repoRoot/.git/config` (inspecting the full file for forbidden directives `include*`, `insteadOf`, `pushurl`, `sshCommand` and hashing all security-relevant sections while ignoring benign `[branch "<name>"]` tracking entries added/removed by normal branch operations in the shared repo) and `delivery.git/config` (exact whole-file hash, refusing and posting a Notice on any drift).
2. **Hardened git & isolated `gh`**: Every Loop git invocation sets `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=<stateDir>/gitconfig`, and full `GIT_SAFE` flags (`core.hooksPath=/dev/null`, `core.fsmonitor=false`, `core.sshCommand=ssh`, `credential.helper=`, `core.askPass=`, `core.pager=cat`, `diff.external=`, `protocol.ext.allow=never`). Every `gh` invocation runs in an empty `<stateDir>/gh-cwd` with explicit `--repo <owner/name>` and minimal env (`PATH`, `GH_TOKEN`, `GH_HOST`, empty `GH_CONFIG_DIR`).
3. **Per-run temporary HOME for verify & install**: `verifyEnv` uses `HOME=<stateDir>/home/<key>` (removed on run cleanup) and shared `<stateDir>/cache/{bun,ms-playwright,electron}`, with zero `GH_TOKEN`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, or real `HOME`.
4. **Exact command-shape allowlist**: `policy.ts` matches every allowed dev command's full argument shape (`DEV_ALLOW`) and rejects unquoted globs across `dev`, `qa`, and `review` roles as well. (Note: Claude Dev sessions run in `auto` mode and do not route through this allowlist; it governs non-Claude agents and read-only roles.)
5. **Outbound secret redaction**: `Forge.createPr`, `Forge.editPr`, `Forge.comment`, and `PlanTracker.comment` run outbound text through `secrets.ts` (`redactSecrets` / `redactPreservingMarker`), replacing any credential-shaped text with a kinds-only notice and logging `secrets_redacted`.

## Alternatives considered

- **Make `.git/config` read-only (`chmod 0444`)**: rejected; git itself modifies `.git/config` (e.g. `worktree add`) and any process running as the same OS user can `chmod` it back.
- **Jump directly to Docker container isolation in Phase 1**: deferred; container isolation requires daemon L2/L3 changes and is tracked separately in Epic `CYC-490` (`CYC-491`).

## Consequences

- **Benefits**: Closes shared `.git/config` token theft, `$HOME` inheritance, command prefix/glob bypasses, and accidental outbound credential leaks without blocking daily Loop operation.
- **Residual risk**: Because sessions and verification commands still run as the same OS user, code can still read mode-0600 files (such as `~/.cycle/loop.json`) by absolute path. Closing that residual risk requires OS/container isolation in Epic `CYC-490`.
- Verified by `cloud/loop/test/git-safety.test.ts`, `secrets.test.ts`, `env.test.ts`, and `policy.test.ts`.

## Related

- [2026-11-25-auto-loop-runs-unattended-with-a-narrow-boundary](2026-11-25-auto-loop-runs-unattended-with-a-narrow-boundary.md) — remains the baseline rationale for deterministic exit-code verification and unattended boundaries; its environment, git, and command-policy mechanisms are updated by this note.
- [2026-11-27-loop-is-three-layers-and-a-person](2026-11-27-loop-is-three-layers-and-a-person.md)

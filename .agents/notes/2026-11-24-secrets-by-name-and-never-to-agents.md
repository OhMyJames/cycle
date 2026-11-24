# Agent Note: Environment secrets are names in the environment, values in the daemon's secrets.env, and never reach an agent's commands

Status: accepted
Date: 2026-11-24
Basis: Owner's request of 2026-11-24 ("variables as references, values in a local .env, chmod 600, the agent may see them now"; then "do both, all three agents, keep the config simple"). Code read: `packages/protocol/src/environment.ts`, `apps/desktop/src/main/environments.ts`, `harness/claude/src/env-file.ts`, `apps/daemon/src/{environment,daemon,worktree-host}.ts`, `facing/{sessions,terminals}.ts`. Extends [2026-11-24-work-in-and-environments](2026-11-24-work-in-and-environments.md).

## Problem

An environment variable was a plain `{name, value}`: the value sat in the app's `environments.json`, went over the wire, was kept in the daemon index, and was exported into the commands Claude and Codex run, where an agent can print it with `env`. A person who wants to keep a key out of the agent's reach had no way to say so.

## Decision

- An environment has `secrets: string[]`, names only. The value is read from `<dataDir>/secrets.env` on the machine the daemon runs on, at each use; it is not in the UI, `environments.json`, the protocol, the index or the log. A location over SSH uses its own file.
- Secrets go to terminals, actions and setup/cleanup scripts only. `sessionVariables` was split: `commandVariables` (literals, for agent commands: Claude's env file, Codex's `shell_environment_policy.set`) and `shellVariables` (literals plus secrets). agy already gets none. Output of a failed setup has secret values replaced by `***` before it is shown or told to an agent.
- A secret is `{name, from?}`: the value comes from key `from` of `secrets.env`, else from `name`, so two environments can give one `GH_TOKEN` different values. In the editor a line `KEY as NAME` is an alias; a line with only `NAME` is a secret. A line without `=` was always an error, so no saved data changes meaning.
- A secret with no value in `secrets.env` refuses `session/new` with `missing_secret` and its name; one that goes missing later is left unset.
- Implemented 2026-11-24 with tests; not run against real Claude, Codex or agy sessions.

Addendum, 2026-11-24 (owner asked for a Vault page in Settings, like a password manager's list and detail view): `secrets.env` is managed from the desktop through `_cycle/vault/list|set|remove` (capability `vault`). It is write-only like connector secrets: no method returns a value, the page draws a fixed run of dots, and replacing a value means typing it again. The daemon edits only the key's own line, so hand-written comments and order survive. Revealing a value in the page was not built: it would put every secret in the renderer on demand, which this note's boundary is meant to avoid.

## Alternatives considered

- `${VAR}` or `value: "$…"` references inside values: rejected, since a literal value may already contain that text in saved files.
- Resolving on the client and sending the value: rejected; it puts the value on the wire and in the daemon index, and a remote location would need the key on the client.
- A per-variable "hide from agent" flag on ordinary variables: not recorded as considered; secrets-by-name does the same with one concept.

## Consequences

- `chmod 600` and this design do not stop an agent that runs as the same user and may read files: it can read `secrets.env` as it can the index. The daemon closes group/other access only. Keeping it out needs a deny-read rule for that file; Cycle does not add one.
- A secret the agent's own tests need must stay a literal variable, which the agent can see.
- An older daemon drops `secrets` silently (zod strips unknown keys), so the session runs without them.

## Addendum: agent-triggered worktree scripts

Code review (2026-11-24) found that EnterWorktree/ExitWorktree run the environment's setup/cleanup in a worktree made from code the agent may have edited, so giving them secrets lets the agent read them (an encoded echo defeats value scrubbing). Those two paths now get literal variables only. `session/new` setup and the session-end cleanup stay user-driven and keep secrets.

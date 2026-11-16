# Agent Note: A session's mode is one its agent offers

Status: accepted
Date: 2026-11-16
Basis: The owner asked for Claude Agent SDK support in full, starting with its permission modes and
approvals (2026-11-16). Checked against `@anthropic-ai/claude-agent-sdk` 0.3.325 (Claude Code
2.1.325), run under Bun against a scripted Messages API, and `codex app-server` 0.167.2's generated
schema.

## Problem

`SessionMode` was Cycle's own three values, `readOnly`, `auto` and `fullAccess`, and each harness
mapped them to what its agent does. Claude Code has six modes of its own (`default`, `acceptEdits`,
`plan`, `auto`, `dontAsk`, `bypassPermissions`), and codex has a plan mode besides its three. Three
words cannot say what either agent offers, and a page cannot draw a choice it does not know.

The three words are stored: in `sessions.json` (each session's mode), `schedules.json` (a schedule's
mode) and `settings.json` (what new sessions start in). One of them, `auto`, is also the name of a
Claude Code mode that means something else: Cycle's `auto` on Claude Code was `acceptEdits` with
Claude Code's sandbox, while Claude Code's `auto` lets a classifier approve calls.

## Decision

Each agent declares its modes (`Agent.listModes`, `ModeInfo`, wire `modes.list`): an id in the
agent's own words, a name, a line on what it allows, whether it is dangerous (never asks and has no
sandbox), whether it only plans, which is its default, and which of Cycle's old three it replaces. A
session's mode is an id of its agent's. The page draws the modes of the session's agent.

- Claude Code offers its six by its own names. Every process is started with a mode named, so Claude
  Code never picks one itself. `acceptEdits` is its default, and it and `auto` run commands in
  Claude Code's sandbox, as Cycle's `auto` did. `bypassPermissions` is the only dangerous one.
- Codex keeps `readOnly`, `auto` and `fullAccess` under the same ids, and adds `plan`, its
  experimental plan collaboration mode, given with `turn/start` and kept by the thread.
- A mode, model or effort changed while Claude Code runs is applied in place
  (`setPermissionMode`, `setModel`, `applyFlagSettings({ effortLevel })`), mid-turn too. Only a move
  that a process's start decides, the sandbox and `allowDangerouslySkipPermissions`, waits for the
  next turn's process. `setMaxThinkingTokens` is deprecated in the SDK and not used for effort.
- An agent that moves itself, as Claude Code does on entering plan mode or once a plan is approved,
  says so (`status.permissionMode`, harness event `mode.changed`). The daemon keeps the new mode and
  says it in the conversation.
- `settings.json` keeps the mode new sessions start in for each agent (`Settings.modes`).

Stored values are read by what they meant then, and left where an older daemon reads them:

- `sessions.json` keeps a session's mode under a new key, `agentMode`. The old `mode` is no longer
  written, and is read only when there is no `agentMode`. `schedules.json` does the same for a
  schedule, and `settings.json` keeps `modes` beside its old `mode`.
- An old word is read marked, as `legacy:<word>` (`legacyMode`), and resolves to the agent's mode
  that `replaces` it: on Claude Code `readOnly` is `default`, `auto` is `acceptEdits`, `fullAccess` is
  `bypassPermissions`; on codex each is itself. A schedule's agent is known only as it runs, so the
  wire carries its old mode marked until then, and the page reads it the same way.
- A value an agent does not offer is its default. A mode the owner names that the agent does not
  offer is refused.

## Alternatives considered

- **One union of every agent's modes.** Every mode would need a meaning on every agent, which they do
  not have: codex has nothing like Claude Code's classifier or `dontAsk`. Each harness would map most
  of the union to a guess, and the page would offer choices an agent cannot honor.
- **Keep Cycle's three and add Claude Code's beside them under new names.** It avoids the stored
  `auto`, but names Claude Code's modes in words that are not its own, so what the owner reads in
  Claude Code's documentation and in Cycle would differ.
- **Rename the stored values by the session's agent at start.** `sessions.json` does not say which
  agent keeps a session, and the agents' lists are not read before the daemon starts: the marker
  needs no agent and is read by whichever agent the session turns out to be on.
- **Rewrite the old words in place, marked, once.** Simpler to read, but the released app and this
  one share `CYCLE_HOME`: an older daemon would then read `legacy:auto`, which it has no policy for,
  and start Claude Code with no mode named. A key of its own leaves the older daemon what it knows.

## Consequences

- The wire's `SessionMode` is a string. A client draws the modes `modes.list` gives for the
  session's harness, and `resolveMode` (in `@cycle/protocol`) reads a stored value as the daemon
  does.
- A daemon from before this change reads each session's mode as it last knew it, and new sessions as
  the old settings say: a mode chosen since is not seen by it.
- No mode that never asks is a default, and approving a plan offers only modes that ask or are kept
  to a sandbox.

# Agent Note: The protocol is the entities and operations of `docs/`

Status: accepted
Date: 2026-11-18
Basis: The owner's review of the protocol (2026-11-17), the pages `docs/glossary.md`, `entities.md`,
`operations.md` and `worktree.md`, and the inventory in `docs/protocol-comparison.md` of the Claude
Agent SDK 0.3.325 (Claude Code 2.1.325), `codex app-server` 0.167.2 (its generated schema, with and
without `--experimental`) and the Agent Client Protocol (version 1, and the version 2 draft of
2026-07-20). The worktree part was tried with the real Claude Code on a scripted model.

## Problem

The protocol had grown by one need at a time, and its words had come apart from what they named:

- "Sandbox" meant five things: Claude Code's command sandbox, the container, an environment's id, a
  container's name, and whether a model can run in one. A mode switched the command sandbox on.
- "Agent" meant the program and a part of its adapter. "Harness" and "agent" were used for each other.
- A session was two types (`HarnessSession`, `SessionInfo`) joined by a function whose rule for each
  shared field was in no place but its code.
- One choice (mode, model, effort) was written in four records, and an agent's capabilities were said
  twice, as flags and as optional methods.
- A session's `error` and `stored` were not states of the session: one was the last turn's outcome, the
  other whether an agent held it in memory.
- An approval and a question were one kind of thing with seven shapes.
- Both agents have a notion of a worktree, and Cycle made its own and told neither.

Adding one per-session option meant twelve to fifteen edits in three packages and two harnesses.

## Decision

The protocol is the entities and operations written in `docs/`, reached in small steps
(`.plans/2026-11-18-migration/PLAN.md`, not tracked). Each word has one meaning, in
`docs/glossary.md`.

- **Entities:** Agent, Session, Turn, Item, Approval, Question, Event, Option, Environment, Workspace,
  Worktree, McpServer, Plugin, Skill, Hook, Subagent, AgentSettings, Account, Usage, Schedule, Provider.
  A workspace is a project; its path is its `cwd`. A Subagent is a definition and a Task is one running.
  "Connector" is the name of a page, not an entity.
- **One `Session` type**, its fields grouped by who keeps them, the winner of each shared field written
  down and tested.
- **A session's activity** (`SessionActivity`: `idle`, `running`, `requires_action`) is not a turn's
  status, and "loaded" is a flag of its own. The name is not `SessionState`: that is the folded session in
  `packages/protocol/src/reduce.ts`.
- **An Approval** is leave to do something (a command, a change, a permission, a tool, a plan); **a
  Question** asks for content (a choice, a form, a link).
- **An agent declares what it can do in one place**, by operation id, and its options as one declared
  list (`mode`, `model`, `effort`), each saying when a change of it applies.
- **A permission mode** says what asks. Where the agent runs and what it can reach is an environment's,
  with a command sandbox or a container as its backend.
- **Items stay typed** by what was done. A harness maps its agent into those kinds.
- **A worktree** is made by Cycle, for both agents, at `<workspace>/.agents/worktree/`; Claude Code's own
  entering goes through a hook Cycle gives it.
- **Wire methods** are `entity.verb`.

## Alternatives considered

- **A second package, `protocol-v2`, beside the first.** Rejected: the daemon, both harnesses, the page and
  the gateway all depend on the protocol, so two of them would live together until the last caller moved,
  and the same concept would have two definitions for that time.
- **Taking ACP as the protocol.** Rejected: it is a protocol between an editor and an agent, not between
  a page and a daemon holding many sessions, it has no plugins, hooks, skills, limits or worktrees, and its
  version 2 is a draft that still moves. It is read as the shared core other agents agree on.
- **Shaping the protocol on the Claude Agent SDK.** Rejected: the project's line is that only
  `harness/claude` knows Claude Code, and a codex-shaped protocol with Claude mapped into it would only
  be turned the other way.
- **One union of every agent's modes.** Already rejected in `2026-11-16-session-modes-are-the-agent-s-own.md`.
- **A bag of agent-specific fields on a session.** Rejected: there is almost none to put in it, and a
  bag loses what the page's types check.
- **A rewrite at once.** Rejected: the expected load is one owner and one daemon, and a small step that
  passes the gate can be reverted.

## Consequences

- The migration is a series of pull requests, each one step, each passing `bun run check`. A renamed
  stored key is read in both spellings and written in the new one, as `agentMode` already is.
- The page and the daemon change together, with no old names on the wire: the daemon serves its page, and
  a window on a remote daemon loads that daemon's page.
- Steps that change a stored or wire format, or an accepted note, write their own: the environment's
  place in `sessions.json`, the command sandbox following the environment (which replaces the part of
  `2026-11-16-session-modes-are-the-agent-s-own.md` that has a mode switch it on), the worktree's record,
  the stored form of an option.
- `CLAUDE.md` names the old words in its Architecture section (`Agent` as a part of a harness, the
  Connector, `worktrees/` in the runtime data). Each step edits the lines it makes false, with the
  owner's approval of that edit.
- Until the steps land, `docs/` names the target where the code differs, and says which is which.

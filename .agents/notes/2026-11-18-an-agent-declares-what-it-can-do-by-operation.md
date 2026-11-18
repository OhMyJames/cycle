# Agent Note: An agent declares what it can do by operation, in one place

Status: accepted
Date: 2026-11-18
Basis: [the declaration](../../docs/operations.md) (The declaration, the core, what an agent may add),
[the harness interface](../../docs/harness-interface.md) item 4, the owner's decision of 2026-11-17 that an
agent declares in one place, and the two notes this follows:
[each agent declares what it can do](2026-11-16-each-agent-declares-what-it-can-do.md) and
[the protocol is entities and operations](2026-11-18-the-protocol-is-entities-and-operations.md). Step 17
of the migration to [the entities](../../docs/entities.md).

This replaces part of the 2026-11-16 note: its "Capabilities" and "Optional methods, by capability"
bullets, and the alternative "A capability for every method ... Not done", which is reversed here. What
stays of it: `Agents`, "Another agent only reads", Accounts and Usage.

## Problem

An ability is said as a flag (`AgentCapabilities`, eleven fields), as an optional method on `Sessions` or
`Connector`, as both, or as neither (`stopTask` and `readContext` are methods with no flag). Nothing ties
a flag to its method. `connector` is one switch for MCP servers and for plugins, and `hooks` also gates
skills. The daemon tests each ability in its own way: a flag and a method, a method alone that answers
`null`, a method alone that throws a plain `Error`, a flag read in a hub. A new agent, or a new ability,
means edits in six places.

## Decision

- **One declaration.** `AgentDeclaration`, in `packages/protocol/src/declaration.ts`, which has no platform
  module and so may hold functions as `modeNamed` does:
  - `operations`: the ids an agent does beyond the core, from the closed list `OPERATIONS`
    (`session.fork`, `session.tag`, `task.stop`, ...), no duplicates;
  - `inputs`: what a prompt may carry (the old `attachments`, the same list);
  - `extensions`: which of `mcp`, `plugins`, `skills`, `hooks` and `subagents` it is given, each `read` or
    `edit`; a kind left out is refused;
  - `account`: `cycle` (the owner signs in through Cycle), `cli` (its own command line) or `none`.
    `declares(d, id)` and `gives(d, kind, access)` are the readers: an edit grant gives read.
- **The ids** are entity-verb, the names in `docs/operations.md`. They are the agent contract's, not the
  wire's: `session.stopTask`, `commands.list` and the other wire methods keep their names.
- **Which field became which.** `rewindFiles` is `session.rewindFiles`, `commands` is `session.commands`,
  `tags` is `session.tag`, `mcpReconnect` is `mcp.reconnect`, `directories` is `session.directories`,
  `login` is `account`, `attachments` is `inputs`. `stopTask` and `readContext`, which had no flag, are
  `task.stop` and `session.context`. `connector` is `mcp` and `plugins` (edit gives both; read gives `mcp`
  read and no plugins, as the Connector refuses `listPlugins` and `readPlugin` today). `hooks` is `hooks`
  and `skills` (an agent always lists skills, so `skills` is `read` where `hooks` is off). `subagents` is
  `subagents` read. Seven ids are declared by both agents and gated by no code: `session.fork`,
  `session.rename`, `session.archive`, `session.compact`, `session.rewind`, `turn.steer`, `turn.review`.
- **Provisional names.** `directories` is a parameter of `session.create`, not an operation, and `docs/`
  has no slot for it: it is the operation `session.directories` until the options of step 18. `features`
  (codex's `features.*` switches) is AgentSettings, which step 19 separates from `HookSettings`: it is the
  operation `settings.features` until then, not a sixth kind of extension.
- **`machine` is not declared.** The docs' shape has it, and says a Machine is the main agent's alone, but
  nothing would read it. The field comes with its first reader.
- **`options` and `environments` are not in it.** The options (modes, models, effort) are step 18's:
  `listModels`, `listModes`, `ModelInfo`, `ModeInfo` and `models.list` / `modes.list` stay as they are.
  The environments an agent can run in are steps 09 and 10's.
- **Refusal by an id.** The daemon refuses an operation its agent did not declare, with one table keyed by
  id in `Harnesses`, so an id without its sentence does not compile. Optional methods stay optional in the
  type: an agent that lacks one writes nothing, where "required plus a stub" would put dead refusing code
  in codex. One helper refuses when the id is undeclared and fails loudly when it is declared and the
  method is missing, which a test of each harness makes impossible. A session's `session.context`
  undeclared answers `null`, as today, and the hub falls back to the usage. The main agent's Connector
  stays unwrapped, never refused by its declaration, as today.
- **The page reads the same ids**, from `daemon.info`: `AgentInfo` carries `declaration`, with no alias.
- **Three pull requests.** The declaration is added beside `AgentCapabilities` and both harnesses fill it,
  with tests that say a field and its ids agree; then the daemon and the page read it; then
  `AgentCapabilities` goes.

## Alternatives considered

- Keeping the flags and generating the methods' presence from them. The two stay two names, and
  `stopTask` and `readContext` stay outside.
- One `can: Record<string, boolean>` of free strings. A typo is a silent `false`; `OPERATIONS` is closed.
- Required methods plus refusing stubs in codex. Dead code in the agent that does less.
- Gating the seven ids every agent has (fork, rename, archive, compact, rewind, steer, review) as soon as
  the declaration lands. They are declared, and nothing refuses by them until a third agent leaves one out;
  a refusal no agent can reach is not tested by anything real.
- Wrapping the main agent's Connector in its declaration, so the rule of `docs/operations.md` (an
  operation not declared is refused for every agent) holds for codex too. A change of what codex does, left.
- The Agent Client Protocol's capability objects. Shaped by an editor's needs, not by the operations here.

## Consequences

- A change to what an agent can do is one list in its harness.
- A third agent says which of the seven it leaves out and is refused the rest.
- Until the last of the three pull requests, `daemon.info` gives `capabilities` and `declaration` side by
  side, and `CLAUDE.md`'s paragraph on `AgentCapabilities` is half true; it is rewritten with the removal.
- `docs/operations.md` stays a draft in its other parts.
- Both `settings.features` and `session.directories` are renamed or moved by steps 18 and 19; so are the
  two sentences that go with them.

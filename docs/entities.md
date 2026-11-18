# Entities

The things Cycle's protocol is about, one card each. This is the first of three steps: the entities,
then the operations on them, then the code. It follows [the glossary](glossary.md) and uses what
[the comparison](protocol-comparison.md) found in the Claude Agent SDK, `codex app-server` and ACP.

Status: **draft**, with the owner's decisions of 2026-11-17 in it. A card says **Decided** where the
owner decided it and **Open** where it is not settled. Worktrees have their own page: [worktree](worktree.md).
What operations the entities have, and the events they give, is in [operations](operations.md).

## The cards

Each card answers the same five questions: what it is, who owns it (the **agent** keeps it, or
**Cycle** does), how it is identified, how it lives, and what it is tied to.

### Conversation

**Session.** One conversation of one agent, in one workspace.

- Owner: both. The agent keeps the conversation and its title, model, effort, times, fork source
  and tag. Cycle keeps pin, unread, the schedule that started it, and the mode, environment, worktree
  and extra directories chosen. Archive is the agent's where it has one. The environment is Cycle's
  alone, stored as `environment` (an id): the agent's record does not say it, and the container's name
  is the harness's, never on the wire.
- Identity: the agent's id. Which agent: `Session.agent` (today `harness`).
- Life: made by the owner or a schedule; loaded into an agent's process and let go of, which is not a
  state of the session; archived; deleted for good (clients confirm first).
- Tied to: an Agent, a Workspace, a Worktree (optional), an Environment, its Turns, its Options, a
  Schedule that started it.
- **Decided**: one `Session` type. Its fields are grouped by who keeps them, and where both say the
  same thing (model, effort, title, preview) the card says who wins.
- **Decided**: the session's activity (`SessionActivity`) is `idle | running | requires_action`, as in
  the SDK (`session_state_changed`) and ACP version 2 (`state_update`). Whether the daemon holds the
  session in memory is a separate flag, `loaded`, and a session that is not loaded is `idle`. The
  name is not `SessionState`: that is taken, by the whole folded session in `reduce.ts`.
  The last turn's outcome is a flag too, `failed`: true when the session is not working and its last
  turn ended in failure (or its agent exited under it), false once the next turn starts. It is read
  from the turn, not from the activity, so a failed session is `idle` with `failed: true`.

**Turn.** One prompt and everything the agent does until it stops.

- Owner: the agent. Identity: the agent's turn id.
- Life: `running`, then `completed`, `interrupted` or `failed`, with a reason.
- Tied to: a Session, its Items, who began it (owner, schedule, task, peer, agent), its diff, time taken.
- **Decided**: a session's activity and a turn's status are two things.
- **Open**: the reasons. The SDK has `terminal_reason` (completed, max turns, budget, blocked, aborted…)
  and ACP has `stopReason` (end turn, max tokens, max turn requests, refusal, cancelled, error). Where
  Cycle keeps "the limit a turn stopped at" today was not looked at.

**Item.** One thing in a turn.

- Owner: the agent. Identity: the agent's item id; `parentId` puts a helper's work under its task.
- Life: started, deltas, completed. Status `running`, `completed`, `failed`, `declined`.
- Kinds today: user message, agent message, reasoning, plan, command, file change, tool call, web
  search, agent call, image, wait, hook, task, agent activity, review, compaction, other.
- **Decided**: typed, by what was done, so the page can show each its own way. A kind that is not
  known is `other`. The SDK is typed by message and by tool; ACP and the SDK's tool calls are generic
  with a name or a `kind`, so each harness maps its agent into these kinds and the protocol does not
  carry the agent's own.

**Approval.** The agent asks leave to do something.

- Owner: asked by the agent, answered by the owner. Identity: an approval id.
- Kinds: command, file change, permissions, tool, plan.
- Answer: accept, accept for the session, decline, cancel; with rules kept for the session, an edited
  input, a message on decline, and on a plan the mode to carry it out in.
- Life: requested, then resolved. While one is open the session `requires_action`.
- **Decided**: apart from Question. A plan is an approval, since the owner is giving leave.

**Question.** The agent, or an MCP server, asks the owner for something.

- Kinds: a choice (options, free text, a secret), a form (an MCP server's fields), a link (an MCP
  server's page to finish). The answer is content, not leave.
- Life and `requires_action`: as an Approval. Today `question` and `elicitation` are kinds of Approval.

**Event.** What the daemon tells a page.

- Owner: Cycle. A session's events are numbered frames (`seq`; the `epoch`, which names a run, is in the session state and in `session.open`'s
  `after`) that a client
  that was away can ask for again; the daemon keeps the last 512. Others are the daemon's own
  (settings, models, providers, terminals, schedules and more).
- Tied to: a Session, or none. Today `EventFrame`, `DaemonEvent`.
- What an agent tells the daemon (`HarnessEvent`, one stream) is two sets: `AgentSessionEvent`, of
  one session, and `AgentEvent`, of the whole agent (MCP changed, account changed, limits changed,
  exited). [Operations](operations.md) lists them.

### Choice

**Agent.** The program that does the work: codex or Claude Code, as Cycle knows it.

- Owner: Cycle lists them; what each can do is its own. Identity: its name.
- Life: starts with the daemon, may be left out when it cannot start, may exit.
- Tied to: its models, modes and efforts (Options), its Account, its extensions, its Sessions.
- **Decided**: an entity. Today only `HarnessInfo { name, capabilities }`. The adapter that runs it is a
  harness, and is not in the protocol.
- **Decided**: it declares what it can do in one place. Today it is said twice: eleven fields
  (`AgentCapabilities`) and seven optional methods. The shape is in [operations](operations.md).

**Option.** A choice an agent declares and a session makes: model, effort, permission mode.

- Owner: the agent declares; the session holds the choice; Cycle's defaults hold what a new session
  starts with. Identity: an id and a category.
- **Decided**: one declared list, as ACP's config option is: an id, a category (`mode`, `model`,
  `effort`), its values, the current one. The category is `effort` and not ACP's `thought_level`, and a
  model's efforts are options under its value. The owner agreed the direction; the fields are in
  [operations](operations.md), and [the note](../.agents/notes/2026-11-18-options-are-one-declared-list.md) fixes them.
- _Today_ (step 18, first pull request): an agent gives `Option[]` (`Sessions.options()`, the wire's
  `options.list` and `options.changed`) beside the two lists the daemon and the page still read, `ModeInfo`
  and `ModelInfo`, and the three fixed fields (mode, model, effort) are still written in four option
  records. Nothing reads the list yet.
- **Decided**: a permission mode is the agent's own and the page draws the session's agent's. It says
  what asks, not where the agent runs.

**Environment.** Where a session's agent runs and what it can reach.

- Owner: Cycle (`sandboxes.json`). Identity: an id. Fields: name, hosts, variables, CPUs, memory, a
  setup script. A variable's value never goes to a page.
- Life: made by the owner. Its backend is made on first use and again when what only making sets
  changes. A session records its id, and keeps it when the environment is removed.
- Backends: the command sandbox of Claude Code on this machine (honors hosts, later folders), and a
  container made with `sbx` (honors everything).
- **Decided**: environment and sandbox are one concept, the container a backend of it, and the
  command sandbox follows the session's environment and not its mode.
- **Open**: see the end of the glossary.

**Workspace.** The owner's folder that sessions work in. The same thing as a project.

- Owner: Cycle (the projects in `settings.json`). Identity: its path, which is also its `cwd`.
- **Decided**: workspace and project are one word; `cwd` is a property of it.
- **Open**: a session an agent lists whose folder was never saved by the owner. Worktrees: the next card.

**Worktree.** A separate checkout of a workspace's repository, on a branch of its own.

- Owner: Cycle, whoever asked for it; neither agent keeps it. Identity: its path.
- Fields: path, workspace, branch, base (the commit it began at), origin (the owner asked for it with
  the session, or the agent entered it).
- Life: made; used by one session or more (a fork shares it); ended by the owner, and its branch stays.
- Tied to: a Workspace, which has many, and the Sessions that point to it. A session's `cwd` is the
  key of the agent's record and never changes; where the agent works now is the worktree's path when
  the agent entered it, else the `cwd`.
- **Decided and done**: the place, `<workspace>/.agents/worktree/`, and `path` and `origin` on the
  record (`agent` when the agent entered it, through Cycle). **Proposed**: the rest, all of it in
  [worktree](worktree.md).

### Extensions

All five are an agent's, the same for each session of it unless a card says otherwise. Each has a
source (the owner's, the project's, a plugin's, Cycle's) and an on or off switch.

**McpServer.** A server that gives the agent tools.

- Owner: the agent's configuration (codex's `config.toml`; for Claude Code, Cycle's `claude.json` over
  the owner's own). Identity: its name.
- Life: added, edited, enabled, signed in, removed. Status connected, failed, needs sign-in, pending,
  disabled. Each tool of it can be off. Its environment values and headers never go to a page.
- **Open**: its scope. codex and Cycle: one configuration. The SDK: a process. ACP: a session.

**Plugin.** A package from a marketplace. It can provide McpServers, Skills, Hooks and Subagents.

- Life: install, enable, uninstall. A marketplace is a source of them, part of this card.

**Skill.** A named instruction the model can use. Listed for a folder; can be off.

**Hook.** A command run on an event of the agent. Claude Code only. Cycle offers nine of the SDK's
thirty-three events. The owner's own can all be turned off together, not one at a time.

**Subagent.** The definition of a helper agent: a name, what it is for, a model.

- **Decided**: a Subagent is a definition and a **Task** is one running, which is an Item. The two are
  not mixed in a name.

### Configuration and account

**AgentSettings.** The knobs Cycle keeps for an agent: the models to fall back to, the most requests,
the most to spend, whether it guesses what comes next, codex's helper-agent switch, and the owner's
two switches (read my own settings, run my own hooks).

- Owner: Cycle (`claude.json`). Reaches a session the next time its process starts.
- **Decided**: apart from hooks. Today `RunSettings` is inside `HookSettings`.

**Account.** The owner's sign-in with whoever serves an agent's models: its kind, email, plan.

- Cycle signs the owner in for codex. Claude Code's sign-in is its own command line's.

**Usage and limits.** Tokens and cost of a turn and a session, what fills the context, the plan's
limit windows, and tokens for each day (numbers only, in `usage.json`).

### Only Cycle

**Schedule.** A prompt the daemon starts in a new session when it is due: once, every so many minutes,
or daily on days. Owner: Cycle (`schedules.json`). The latest twenty runs are kept.

**Provider.** A model service the owner keys in. Owner: Cycle (`providers.json`). The key goes to the
daemon once and is never given back. A provider's model is `<provider id>/<model id>`.

## Settings layers

Four, and a setting lives in one: Cycle's defaults for a new session; the harness configuration;
the owner's own configuration of an agent, read and never written; the project's own, which the
agent reads. See the glossary.

## Worktrees

The design is in [worktree](worktree.md): who makes one (Cycle, for both agents, and Claude Code's own
entering goes through Cycle by a hook), where it lives, what a session's folder is when one is used,
and how it ends.

## What else this changes

When the entities are agreed, these words in other files follow: "Connector" (a page's name, not the
protocol's; it is in `CLAUDE.md`, the glossary and the harness map), the `Agent` part of `Harness`
(to `Sessions`), `Session.harness` (to `agent`), `SessionMode` (to `PermissionMode`), and the sandbox
fields. No code or other file has been changed.

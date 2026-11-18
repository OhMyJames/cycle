# Operations and events

What can be done with the [entities](entities.md), and what comes back. This is the second of three
steps; the third is the code. Words are the [glossary](glossary.md)'s. What the other protocols do is
in [the comparison](protocol-comparison.md).

Status: **draft**. Three things are decided by the owner (2026-11-17): an agent declares what it can
do in one place, its options are one declared list, and a session's activity and a turn's status are two
things. The rest is **Proposed**, to be argued with, and **Open** where it is not settled.

## Two contracts

Cycle has two, and this page is about the first.

1. **The agent contract**, between the daemon and an agent's harness (`harness.ts` today). The daemon
   asks; the agent does it and tells what happened. This is what changes when a third agent comes.
2. **The wire**, between a page and the daemon (`wire.ts` today, seventy-eight methods). It shows the
   entities to the page and holds what only Cycle has: environments, workspaces, schedules, providers,
   numbered frames. It is not redesigned here; only a naming rule is proposed at the end.

## Rules

All five are **Proposed**. Each is one that some of the sources already follow.

1. **A call returns when it is accepted. What follows arrives as events.** `send` gives back a turn id,
   not the turn. (Cycle, the Claude SDK and codex do; ACP does from version 2, and in version 1 its
   prompt answers when the turn ends.)
2. **An event names what it is about by its id, and a completed one carries the whole of it.** An
   item, an approval, a task is told as started, changed, completed, so a client that missed some, or a
   replay after a reconnect, is the same code as live. Whether Cycle's events already do this was not
   checked.
3. **An operation an agent did not declare is refused, never done by another agent.** Today's rule for
   a Connector and an Account, for all of them.
4. **An option says when a change of it applies:** at once, from the next turn, or from the next
   process. The agent declares it; Cycle does not guess it.
5. **Ids belong to whoever made the thing.** The agent's: session, turn, item, approval, question.
   Cycle's: schedule, environment, workspace, frame.

## The declaration

**Decided**: one place. **Proposed**: this shape. It replaces `AgentCapabilities` (eleven fields), the
seven optional methods and `listModels` and `listModes`.

_Today_ (step 17, [the note](../.agents/notes/2026-11-18-an-agent-declares-what-it-can-do-by-operation.md)):
`AgentDeclaration` (`packages/protocol/src/declaration.ts`) exists beside `AgentCapabilities`, which is still
what the daemon and the page read; `daemon.info` gives both. It has `operations`, `inputs`, `extensions`
and `account`, without `options` and `environments` (steps 18, 09 and 10) and without `machine` (no reader
yet). Two ids are provisional: `session.directories`, which is a parameter of `session.create`, and
`settings.features`, codex's `features.*` switches, which step 19 moves to AgentSettings.

```
Agent declares
  name            "codex", "claude"
  operations      the ids it does beyond the core, such as "session.fork"
  inputs          what a prompt may carry: image, pdf, text
  options         Option[]
  extensions      which of mcp, plugins, skills, hooks, subagents it has, each "edit" or "read"
  account         "in Cycle", "its own command line", or none
  machine         whether it gives files, commands and terminals
  environments    the backends it can run in: command sandbox, container

Option
  id, category    category is "mode", "model", "effort" or an agent's own
  name, description
  values[]        id, name, description, and flags: default, dangerous, plansOnly
  current         on a session, not in the declaration
  applies         "now", "nextTurn", "nextProcess"
```

- A permission mode is the option of category `mode`. Its flags are today's `ModeInfo.dangerous`,
  `plan` and `isDefault`. `dangerous` never is the default and nothing turns it on for the owner.
- Setting one option can change the others (a model has its own efforts). So setting one answers with
  the whole list, as ACP does.
- The operation ids are the one source. The code that offers an operation and the page that shows its
  button read the same id, so a flag and a method cannot disagree.

## The core

What every agent does. Cycle, the Claude SDK and codex have each of these; ACP has them too, though it
makes `session.list` and `session.delete` optional.

| Operation                      | Does                                                   | Today                                     |
| ------------------------------ | ------------------------------------------------------ | ----------------------------------------- |
| `agent.start`, `agent.dispose` | brings the agent up, lets it go                        | `start`, `dispose`                        |
| `agent.declare`                | says what it can do and which options it offers        | `capabilities`, `listModels`, `listModes` |
| `session.create`               | a session in a workspace, its options and environment  | `createSession`                           |
| `session.load`                 | a stored session into memory, with its turns and usage | `loadSession`                             |
| `session.list`                 | the agent's sessions                                   | `listSessions`                            |
| `session.delete`               | removes it for good                                    | `deleteSession`                           |
| `session.setOption`            | changes one option; answers with all of them           | `configure`                               |
| `turn.send`                    | starts a turn; answers with its id                     | `send`                                    |
| `turn.interrupt`               | stops the turn                                         | `interrupt`                               |
| `approval.respond`             | answers an approval                                    | `respondApproval`                         |
| `question.answer`              | answers a question                                     | `respondApproval` (a kind of it)          |

## What an agent may add

Declared by operation id. In brackets, who has it of the four sources read (Cycle, the Claude SDK,
codex, ACP version 1).

| Operation             | Does                                           | Who has it                                      |
| --------------------- | ---------------------------------------------- | ----------------------------------------------- |
| `session.fork`        | copies a session, up to a turn                 | Cycle, SDK, codex                               |
| `session.rename`      | sets its title                                 | Cycle, SDK, codex                               |
| `session.archive`     | puts it away or back                           | Cycle, SDK, codex                               |
| `session.tag`         | puts a label on it                             | Cycle, SDK                                      |
| `session.compact`     | folds the conversation into a summary          | Cycle, codex (SDK: no call)                     |
| `session.rewind`      | takes the conversation back before a turn      | Cycle, codex (SDK: by resuming up to a message) |
| `session.rewindFiles` | puts the files back as they were before a turn | Cycle, SDK                                      |
| `session.context`     | what the context holds, part by part           | Cycle, SDK                                      |
| `session.commands`    | the commands a prompt can begin with           | Cycle, SDK, ACP                                 |
| `turn.steer`          | puts input into the turn that is running       | Cycle, SDK, codex                               |
| `turn.review`         | a turn in which the agent reviews code         | Cycle, codex                                    |
| `task.stop`           | stops one background task                      | Cycle, SDK                                      |

## What an agent is given

Operations on the extensions, declared as `edit` or `read` for each kind. An agent that only reads
leaves the others refused.

| Entity        | Operations                                                                      |
| ------------- | ------------------------------------------------------------------------------- |
| McpServer     | list, put, remove, enable, enable a tool, sign in, reconnect (optional)         |
| Plugin        | list, read, install, uninstall, enable, add a marketplace, remove a marketplace |
| Skill         | list (for a workspace), enable                                                  |
| Hook          | read, set                                                                       |
| Subagent      | list (for a workspace)                                                          |
| AgentSettings | read, set                                                                       |

`codex` has MCP servers and plugins to edit, skills to list (Cycle cannot turn one off yet), and a switch
for helper agents; it has no hooks. Claude Code has all five. Cycle edits its MCP servers, plugins and
hooks in its own `claude.json`, turns skills on and off, and only lists its subagents.

## Account, usage, machine

| Entity  | Operations                                                                                         |
| ------- | -------------------------------------------------------------------------------------------------- |
| Account | read (with the plan's limits), sign in, cancel a sign-in, sign out; declared `in Cycle` or not     |
| Machine | run a command, read a directory, read a file, search files, open a terminal; declared by `machine` |

Only codex gives a Machine today. Files, git and terminals of every session, whatever its agent, are
the main agent's.

## Worktrees

Cycle makes them for both agents; see [worktree](worktree.md).

| Operation                             | Does                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| `session.create { worktree }`         | makes one for the session, on a branch and from a base if given     |
| `session.delete { removeWorktree }`   | removes it with the session, unless another uses it or one is in it |
| `worktree.list { workspace }`         | the worktrees of a workspace and the sessions that use each         |
| `worktree.remove { workspace, path }` | removes one that no running session is in                           |

`worktree.list` answers git's own list for the workspace's repository, read each time: every linked
worktree, with its branch, whether it is locked or its folder gone, whether it holds uncommitted work,
and the sessions that use it, archived ones included. `workspace` is any folder of the repository; the
answer gives its main checkout. `managed` means directly under `.agents/worktree/` (or, of the older
place, `<repository>/<branch>` under `CYCLE_HOME/worktrees/`): a worktree made by hand, one inside
another worktree, or one an agent's own tool made under `.claude/worktrees`, is listed and not
`managed`. `worktree.remove` takes the `workspace` as well, since a worktree whose folder is gone
cannot say which repository it was of, and its `path` must be one the list gives, character for
character. It refuses before changing anything: a worktree not `managed`, one with another worktree
inside it, a locked one, one whose `.git` file is gone (git would then remove the checkout above
it), or one a session is working in; idle and archived sessions do not block. It discards
uncommitted work, since the client confirmed, and keeps the branch. The check is of the sessions the
daemon knows; a turn that starts as git removes the folder is not seen.

An agent that can enter a worktree itself (Claude Code) declares `worktree.enter`; Cycle then tells
the page by `session.changed` when it enters or leaves one.

## Events

Two sets, which exist as the types `AgentSessionEvent` and `AgentEvent` (their union, `HarnessEvent`,
is the one stream a harness reports on). Four kinds below are still to do: `option.changed` (today
`mode.changed`), `question.requested` and `question.resolved` (today kinds of the approval events),
and `extensions.changed` (today `mcp.changed`); `options.changed` has no producer yet. The rest
carry their names, `agent.exited` since this change. An agent's event tells what it knows; Cycle
adds its own and numbers a session's into frames.

**Of a session** (each carries a session id):

| Event                                                            | Says                                                   | Replaces today's             |
| ---------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------- |
| `session.changed`                                                | a field of the session the agent keeps, as a patch     | `session.changed`            |
| `option.changed`                                                 | the agent moved an option itself, as on leaving a plan | `mode.changed`               |
| `turn.started`, `turn.completed`                                 | a turn began, ended, with its status and reason        | the same                     |
| `item.started`, `item.delta`, `item.completed`                   | an item, told by its id                                | the same                     |
| `plan.updated`, `diff.updated`, `tasks.updated`, `usage.updated` | the plan, the diff, the tasks, the tokens              | the same                     |
| `approval.requested`, `approval.resolved`                        | an approval opened, answered                           | the same                     |
| `question.requested`, `question.resolved`                        | a question opened, answered                            | kinds of the approval events |
| `notice`                                                         | a note, a warning or an error                          | the same                     |
| `turns.rewound`                                                  | turns taken back                                       | the same                     |
| `commands.changed`, `suggestion.changed`                         | the commands, or what the agent guesses comes next     | the same                     |

**Of an agent** (no session id): `options.changed` (the models offered changed), `extensions.changed`
(a server started, failed, finished a sign-in), `account.changed`, `limits.changed`, `agent.exited`.
Today `mcp.changed` stands for `extensions.changed`, and `options.changed` has no producer yet.

**Not the agent's:** the daemon derives the session's activity (`SessionActivity`) and tells it.

- `running` from the prompt being sent to the turn's end (the turn's id is not known at first, so a
  session that is starting counts as running); `requires_action` while any approval or question is
  open; `idle` otherwise. The SDK and ACP version 2 say it themselves; codex was not seen to, so one
  derivation serves all.
- `failed` is true when the session is `idle` and its last turn ended in failure, or its agent exited
  under it. It is false once the next turn starts.
- `loaded` is the daemon's knowledge of whether it holds the session in memory. A session that is not
  loaded is `idle`.
- The queue (`queue.updated`) is Cycle's. A prompt sent in a turn is queued by the daemon and sent
  when the turn ends, or put into the turn with `turn.steer` where the agent declares it.

## Open

- **When does the owner's message appear?** The turn id and the user message item could be announced
  when the daemon has the prompt, before the agent's process is ready, which also answers a cold
  start. The turn id is the agent's, so this needs the daemon to hold the message until it has one.
- **Which reasons a turn can stop for.** The SDK's `terminal_reason` and ACP's `stopReason` are
  where to start. Where Cycle keeps "the limit a turn stopped at" was not read.
- **How the parts of a harness are grouped.** Today four (`Agent`, `Connector`, `Account`,
  `Machine`). With the Connector gone, the extensions and AgentSettings need a place; one part for
  all five extension kinds, or one for each, is not decided.
- **A turn's origin.** `owner`, `schedule`, `task`, `peer`, `agent` are Cycle's and the agent's
  mixed; which is which was not read.

## A naming rule for the wire

**Proposed**, and only a rule: a method is `entity.verb`, and the entity is the one in these pages.
Today most follow it (`session.*`, `account.*`, `terminal.*`) and some do not: `mcp.*` for McpServer,
`plugins.*` and `marketplace.*` for Plugin, `sandboxes.*` for Environment, `features.*` and `hooks.*`
for AgentSettings (its run limits travel in `hooks.*`). Renaming a wire method is a change a page and a daemon must agree on, and needs the
older page's methods read for a while.

## Not covered

The wire's method list; stored file formats; error codes; the order of the daemon's
changes. Nothing here has been run, and no code has been changed.

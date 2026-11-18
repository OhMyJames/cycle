# Glossary

The words Cycle uses, and the one thing each of them means. A word that means two things in the code
is a bug in the words, not in the reader: this page says which meaning stays.

Two kinds of entry:

- **Today** is what the code says now.
- **Target** is what the owner decided the word should mean. The code does not follow it yet; the
  table at the end lists each rename that is still to be done. Until it is done, read the code with
  the Today column.

Why a decision was taken lives in `.agents/notes/`. This page says what the words are; what each
thing is, who keeps it and how it lives is in [entities](entities.md), and what can be done with
them is in [operations](operations.md).

## The people and the processes

- **Owner**: the one person Cycle is for.
- **Daemon**: the one long-running process that holds every session (`apps/daemon`).
- **Agent**: a program that does the work: codex or Claude Code. The page says "agent" and means
  this. It is an entity of its own: a name, what it can do, the options it offers.
- **Harness**: Cycle's adapter for one agent (`harness/codex`, `harness/claude`). It is code only,
  never shown in the interface and not part of the protocol's entities.
  - _Today_ a harness has four parts, `Agent`, `Connector`, `Account` and `Machine`, and the first is
    named like the program, so "agent" means both the program and a part of its adapter.
  - _Target_ the part is called `Sessions`; "agent" means the program only. How the rest is grouped
    is for [operations](operations.md).

## What a conversation is made of

- **Session**: one conversation with one agent, in one workspace. One type, whichever of the agent
  and Cycle keeps a field of it.
- **Turn**: one prompt and everything the agent does until it stops.
- **Item**: one thing in a turn: a message, a command, a file change, a tool call. Typed by what was
  done.
- **Task**: a helper agent, or a command, running in the background. It is an Item.
- **Approval**: the agent asks leave to do something: a command, a change, a permission, a tool, a
  plan. The answer is a decision.
- **Question**: the agent, or an MCP server, asks the owner for something: a choice, a form, a link.
  The answer is content.
- **Frame**: a numbered event the daemon sends the page. The page asks for the frames it missed.
- **Model**: `<provider id>/<model id>` for the owner's providers, an agent's own name otherwise. A
  model says which agent a new session starts on, and the session stays there.
- **Schedule**: a prompt the daemon starts in a new session when it is due.
- **Provider** and **Gateway**: a model service the owner keys in, and the loopback endpoint that
  lets codex use it.

## Where a session works

- **Workspace**: the owner's folder that sessions work in. The same thing as a project: there is one
  word. Its path is its `cwd`.
  - _Today_ the code says "project" (the list in settings), "folder" and `cwd`. _Target_ workspace.
  - In the container's own words a "workspace" is the folder `sbx` mounts. That stays in the sandbox
    code; it is not this word.
- **Worktree**: a separate checkout of a workspace's repository, on a branch of its own. See
  [worktree](worktree.md).
  - _Today_ the daemon makes it under `CYCLE_HOME/worktrees/`, and it is the session's `cwd`.
  - _Target_ Cycle makes every one, at `<workspace>/.agents/worktree/` (the owner decided the place).
    A session's `cwd` stays the folder the agent's record is kept under; where the agent works now is
    the worktree's path when there is one.

## What an agent may do

- **PermissionMode**: how much the agent may do without asking the owner.
  - Each agent declares its own list and a session's mode is one of its agent's. There is no list of
    Cycle's own. The same id can mean two things on two agents (`auto`), so a stored mode is always
    kept with its agent.
  - _Today_ the type is `PermissionMode`.
  - A mode says what asks. It does not say where the agent runs or what it can reach: that is the
    environment's.
  - The one mode that never asks (`fullAccess` on codex, `bypassPermissions` on Claude Code) is never a
    default, and nothing turns it on for the owner.
- **Option**: a choice an agent declares and a session makes: model, effort, permission mode. One
  declared list, not three kinds of field.

## Where an agent runs

- **Environment**: what the owner chooses for where a session's agent runs and what it can reach: a
  name, hosts it may connect to, and, for a backend that can honor them, CPUs, memory, variables and
  a setup script.
  - An environment has a **backend**. A backend is how the environment is carried out, not a second
    kind of environment:
    - **Command sandbox**: Claude Code's own sandbox (bwrap on Linux). The agent runs on this machine
      and each command it runs is confined. It can honor hosts, and later folders it may read or
      write. It cannot honor CPUs, memory or a setup script, and a variable's value is never put in
      its settings file.
    - **Container**: a Docker sandbox made with `sbx`. The whole agent runs in it. It honors every
      field.
  - A field a backend cannot honor is shown as not applying there, never dropped silently.
  - _Today_ "sandbox" means five things: Claude Code's command sandbox, the container, the
    environment's id (`session.create.sandbox`), the container's name (`SessionMeta.sandbox`) and
    whether a model can run in one (`ModelInfo.sandbox`). The command sandbox is also switched on by
    a mode (`modeOptions`), and the test of whether a session is in a container is made in two places
    (`claude-harness.ts:1357` and `:1447`).
  - _Target_ the owner chooses an **environment**. The word "sandbox" alone is not used: say the
    environment, the command sandbox or the container.
  - _Target_ the command sandbox follows the session's environment, not its mode.

## What an agent is given

Each of these is an agent's own, the same for every session of it. Each has a source (the owner's,
the project's, a plugin's, Cycle's) and a switch.

- **MCP server**: a server that gives the agent tools, with its sign-in and status.
- **Plugin**: a package from a marketplace. It can provide MCP servers, skills, hooks and subagents.
- **Skill**: a named instruction the model can use.
- **Hook**: a command run on an event of the agent. Claude Code only.
- **Subagent**: the definition of a helper agent. One running is a Task.
- **AgentSettings**: the knobs Cycle keeps for an agent: models to fall back to, the most requests,
  the most to spend, whether it guesses what comes next, and the owner's switches. A change reaches
  a session the next time its process starts.
  - _Today_ they are `RunSettings`, kept inside `HookSettings` and shown under "Hooks". _Target_
    their own, apart from hooks.
- **Connector** is the name of a page of the interface that shows MCP servers and plugins together.
  It is not an entity: the protocol does not have it, and the page assembles it.
  - _Today_ it is also a part of the harness (`Connector`), holding skills, hooks and subagents too.

## Settings: four layers

Settings follow the harness. There are four places a setting can live, from Cycle's to the
project's:

1. **Cycle's defaults** (`settings.json`): what a new session starts with: model, effort, mode,
   worktree. Cycle's own, not an agent's.
2. **Harness configuration**: what the owner set for an agent in Cycle. Claude Code's is
   `claude.json`; codex's is its own `config.toml`.
3. **The owner's own configuration of an agent**: `~/.claude`, `~/.codex`. Cycle reads it only
   through the agent and never writes it.
4. **The project's configuration**: `.claude/` and the like inside the workspace. The agent reads it.
   Cycle neither parses nor writes it.

A setting lives in one layer. Where two layers set the same thing, the agent's own rules decide.

## Words to avoid

| Do not say                       | Say                                                              |
| -------------------------------- | ---------------------------------------------------------------- |
| "sandbox" alone                  | environment, command sandbox, or container                       |
| "default" alone in a choice list | the choice's name, marked: "Auto (default)"                      |
| "agent" for Cycle's adapter      | harness                                                          |
| "settings" alone                 | which layer: defaults, harness configuration, owner's, project's |
| "mode" for where a session runs  | environment                                                      |
| "project" or "folder"            | workspace                                                        |
| "Connector" for an entity        | MCP server, or plugin                                            |
| "subagent" for one running       | task                                                             |

## Renames still to do

| Today                                              | Target                                          |
| -------------------------------------------------- | ----------------------------------------------- |
| `HarnessSession` and `SessionInfo`                 | `Session`                                       |
| `Session.harness`, `HarnessInfo`                   | `Session.agent`, `Agent`                        |
| `SessionStatus` (five values)                      | `SessionActivity` (three) and a "loaded" flag   |
| `Approval` kinds `question` and `elicitation`      | `Question`                                      |
| `ModeInfo`, `ModelInfo`, an effort string          | `Option`                                        |
| `AgentCapabilities` and the optional methods       | one declaration                                 |
| `Harness.agent` (the Sessions part)                | `Harness.sessions`                              |
| `HarnessEvent` (one union)                         | an event set for a session and one for an agent |
| sandbox environment, `sandboxes.json`, `sbx`       | environment, with the container as a backend    |
| `RunSettings` inside `HookSettings`                | `AgentSettings`, apart from hooks               |
| the command sandbox set by a mode                  | set by the environment                          |
| `DEFAULT_MODE` and `isDefault` saying two defaults | one                                             |
| "project", "folder", `cwd`                         | workspace                                       |

Stored files keep reading what older daemons wrote, so a rename of a stored field needs a decision
note first.

## Not settled

- Whether hosts written for `sbx` (names, patterns, ports) are the same as the ones Claude Code's
  command sandbox takes. They are not checked against each other.
- Whether an environment also names the folders a command sandbox may read and write.
- How a session without a container chooses an environment: today the choice is an environment or
  none.
- What [worktree](worktree.md) lists as not checked, such as what Claude Code's `bgIsolation` does to a
  session Cycle starts.
- Which reasons a turn can stop for.

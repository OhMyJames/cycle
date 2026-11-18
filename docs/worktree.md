# Worktrees

The design of the worktree: who makes one, where it lives, what a session's folder is when one is
used, and how it ends. It follows [the entities](entities.md) and gives the operations
[operations](operations.md) lacks for it.

Status: **draft**. One thing is **Decided** by the owner: worktrees live at
`<workspace>/.agents/worktree/`. Everything else is **Proposed**, with its reason. The parts that could be
tried were tried (the section "What was tried"); what could not be is at the end.

## What was found

- **Cycle today.** The daemon makes the worktree before the agent starts, with `git worktree add`
  (`sessions.ts:254-255`, `git.ts:259`), under `CYCLE_HOME/worktrees/<repo folder>/<the branch, made safe>`. The agent
  is given that folder as the session's `cwd`. The record, `{repo, base, branch}`, is only in
  `sessions.json`: neither agent knows of it. Removal is the owner's choice at delete and keeps the
  branch. A fork shares its source's worktree. A session in a container cannot have one.
- **codex.** Nothing. Its app-server schema, generated from the bundled binary with and without
  `--experimental` (47 files), has no worktree. A thread has a `cwd` and `gitInfo`
  (`branch`, `sha`, `originUrl`), and `turn/start` can set `cwd` "for this turn and subsequent turns".
  The word appears in the binary in names that look like its own terminal program's; that was not
  checked further.
- **Claude Code.** Two tools the model can call, `EnterWorktree` (a new name, or the path of one that
  exists) and `ExitWorktree` (`keep` or `remove`). Their results carry the path, the branch and, on
  exit, the folder the agent came from and how many files and commits were discarded. Hooks
  `WorktreeCreate` (given a name, the hook answers with the path it made) and `WorktreeRemove`, and
  `CwdChanged`, exist: a host can make the worktree itself. Its settings have a `worktree` group
  (`baseRef`, `symlinkDirectories`, `sparsePaths`, `bgIsolation`, and `location`, which the CLI does not
  read yet). Its conversation store is, as far as
  Cycle's code shows, keyed by the session's folder (inferred).

## What follows from it

1. **codex cannot make one, so Cycle must.** One maker serves both agents; two would put worktrees in
   two places with two ways to end.
2. **Claude Code can make one on its own, and a hook lets Cycle decide how.** Without the hook, an
   `EnterWorktree` makes a checkout Cycle does not know of, under Claude's own folder.
3. **An agent's record of a session is keyed by the session's folder.** That folder must not change
   during the session's life, or its history is stranded.

## The entity

**Worktree.** A separate checkout of a workspace's repository, on a branch of its own.

- Owner: Cycle, whoever asked for it. The agents do not keep it.
- Identity: its path.
- Fields: `path`; `workspace` (the repository's folder; today `repo`); `branch`; `base` (the commit it
  began at, which the session's changes are read against); `origin` (`owner` if made as the session
  was, `agent` if the agent entered it).
- Life: made; used by one session or more; ended with its folder removed. Its branch stays.
- Tied to: a Workspace, which has many; sessions, which point to it with `Session.worktree`.

## Rules

1. **Cycle makes every worktree** with `git worktree add`, whichever agent the session is on. **Claude
   Code's `EnterWorktree` goes through Cycle**, by a `WorktreeCreate` hook that Cycle gives the
   process, and `ExitWorktree`'s `remove` by `WorktreeRemove`. So both agents get the same place,
   name, base and ending, and Cycle knows each one the moment it exists. The hook is a callback of
   the SDK's `hooks` option, in the daemon's own process: it needs no command and no credential.
   (Tried: see below.)
2. **Place: `<workspace>/.agents/worktree/<name>`.** (Decided.) The name is the branch, made safe.
   The path is made unique, not only the branch: today two repositories of one name, or `a/b` and
   `a-b`, can ask for the same path.
3. **Hidden from git and from tools.** The first time, Cycle writes `.agents/worktree/.gitignore`
   holding `*`. The folder then ignores itself and everything in it, with nothing changed outside it
   and no line in the owner's `.gitignore`: `git status` stays quiet, and `git add -A`, which Cycle's
   commit uses, does not stage a checkout inside the checkout. The formatter, the linter and `bun test` of this repository skip it, so
   it needs no line in their configuration (tried). What does not read `.gitignore` still sees the
   folder: the page's file search and its `@` suggestions must leave it out.
4. **A session's `cwd` is the key of the agent's record, and never changes.** Where the agent works
   now is `worktree.path` when there is one, else `cwd`. The files, terminal and changes of the page
   follow the first. For a worktree made as the session was, the two are the same, as today.
   **Claude Code remembers the worktree itself**: a process started with `resume` begins in it, from
   the folder it was given. So Cycle reads where the agent is from the `cwd` of the process's `init`
   message, each time one starts, and brings `Session.worktree` into line.
5. **A worktree is shared by forks and kept by archive.** It is removed only when the owner says so, and
   not while a session in it runs or another session still uses it.
6. **A worktree made for a session that never started goes with it.** Today one is removed when the
   agent fails to start (`sessions.ts:276-281`), but not when the page drops a session that was made
   and never sent to (`client/app.ts:573-574`).
7. **The branch is kept when a worktree is removed**, as today, and also when the agent asks for
   `remove`: with a `WorktreeRemove` hook Claude Code removes neither the folder nor the branch, the
   hook does. Claude Code still tells its model "removed".
8. **A session in a container cannot have one**, unchanged: its history is in the repository's folder,
   which the container would not hold (`sessions.ts:246`).
9. **Worktrees already under `CYCLE_HOME/worktrees` stay as they are.** Their record holds the path,
   nothing moves, and the files panel still may read there.

## Operations and events

| Operation                           | Does                                                                                                 | Today                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| `session.create { worktree }`       | makes one for the session, on a branch if given, from a base if given                                | the same                     |
| `session.delete { removeWorktree }` | removes it with the session, under rule 5                                                            | the same, without the checks |
| `worktree.list { workspace }`       | what is under `.agents/worktree` and what `git worktree list` knows, with the sessions that use each | none                         |
| `worktree.remove { path }`          | removes a worktree no running session is in                                                          | none                         |

- **Event:** `session.changed` carries `worktree` when the agent entered or left one. No new item kind
  is needed: an `EnterWorktree` is a tool call in the turn as it is today.
- **For the agent contract:** an agent that can enter a worktree on its own says so by operation id
  (`worktree.enter`), and the harness gives Cycle's creation to it. codex does not declare it.
- **Settings:** `Settings.worktree` and a schedule's `worktree` flag stay as the defaults of a new
  session and of each run.

## What it changes

- `git.ts`: the path, its uniqueness, the self-ignoring file, and a lock for each repository (today one lock serves all repositories, though its comment says each).
- `sessions.ts`: the removal checks, the dropped session, `Session.worktree` gaining `path` and
  `origin`, the entered worktree.
- `harness/claude`: the two hooks, which it cannot take today: its `QueryOptions` (`sdk.ts`) has no
  `hooks`, and only settings-file command hooks are passed (`config.ts:292-318`). The option goes in
  `QueryOptions` and in the `query()` call of `claude-harness.ts:1365-1386`. It does not read `init`'s
  `cwd` yet either (the SDK's message has it); that is needed to bring `Session.worktree` into line.
- `Files`: leave `.agents/worktree` out of search (`files.ts:84` filters only `.git`). Reading stays
  allowed: it is inside a project, and `CYCLE_HOME/worktrees` stays on the list for the old ones.
- The page: the dialog that deletes a session names a worktree other sessions use; a list of a
  workspace's worktrees; the sidebar's mark.
- `CLAUDE.md`'s Runtime data, which lists `worktrees/` under `CYCLE_HOME`. This repository's own
  formatter, linter and tests need nothing.
- A decision note, since `sessions.json`'s `worktree` changes shape. Old records stay readable.
- Tests: none today covers `removeWorktree`, the cleanup when a session fails to start, a delete that
  removes it, or a fork's sharing.

## What was tried

With the real Claude Code (the SDK's own binary, version 0.3.325) on a scripted model, in a scratch
repository and a scratch home; git and the repository's tools in scratch copies. The scripts are in
`.plans/2026-11-17-worktree/`.

**Without a hook**, the way Claude Code behaves today:

- `EnterWorktree` makes `<repo>/.claude/worktrees/<name>` on a branch `worktree-<name>`, and the
  worktree is **locked** in git. The model is told "The session is now working in the worktree".
- A process started again with `resume`, from the original folder, **begins in the worktree** (`init`
  `cwd`), with the whole history found.
- `ExitWorktree` with `remove` removes the folder and **deletes the branch**.

**With a `WorktreeCreate` hook**, as a command or as a callback of the SDK's `hooks` option beside a
settings file:

- It is called with `name`, the session's `cwd`, `session_id` and `prompt_id`. Claude Code **uses the
  path it answers with**: the worktree was at `.agents/worktree/exp1`, and `.claude/` was never made.
  It is not locked. A resume begins in it, with the history found.
- `ExitWorktree` with `keep` calls no hook and leaves everything. With `remove`, Claude Code first
  refuses ("Could not verify worktree state … re-invoke with `discard_changes: true`"), since it cannot
  check a worktree it did not make; with `discard_changes: true` it calls `WorktreeRemove` (given
  `worktree_path`) and **does nothing else**: the folder and the branch stayed until the hook acts.
- The `CwdChanged` hook did not fire on entering one.

**With the command sandbox on** (Claude Code's own, started with `failIfUnavailable`), `git add` and
`git commit` in a worktree under `.agents/worktree` worked.

**In git**, in a scratch repository: a worktree at `.agents/worktree/<name>` with that folder's own
`.gitignore` holding `*` leaves `git status` and `ls-files --others` empty (it also did in this
repository), `git add -A` stages only the real changes, and removing it keeps the branch.

**In this repository's tools**, in a clone: `oxfmt --check` and `oxlint` find nothing in a worktree
holding a badly formatted file and a `debugger`, though both flag the same files when named;
`Bun.Glob` and `bun test` find no test file in it.

**codex**: its generated schema has no worktree; `turn/start` has `cwd`, "for this turn and subsequent
turns".

## Is it one behavior?

For the owner, yes: a worktree is made, listed, shown, changed and removed one way, wherever it came
from and whichever agent the session is on. What stays different is in the agents:

| Part                            | codex          | Claude Code                                                                                                                    |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| the owner asks for one at start | Cycle makes it | Cycle makes it                                                                                                                 |
| the agent enters one itself     | cannot         | can: through Cycle's hook, so the same worktree                                                                                |
| where the agent is on a restart | Cycle's record | its own memory; Cycle reads `init`'s `cwd`                                                                                     |
| the agent leaves one            | cannot         | `keep` calls nothing, so Cycle sees it in `init` and the tool's result; `remove` needs `discard_changes` and a hook of Cycle's |
| a worktree of Claude Code's own | none           | made by the CLI under `.claude/worktrees` (six in this checkout); Cycle lists them, does not manage them                       |

Cycle gives the agent no tool of its own to enter one: its tools only read, which is a red line.
So codex stays without the second row, and the contract says so by declaring it.

## Not checked

- `ExitWorktree` with `keep`, then a restart: where `init`'s `cwd` is. Taken to be the original folder.
- A `WorktreeRemove` callback of the SDK's, which was tried only as a command.
- What Claude Code's `bgIsolation` does to a session Cycle starts. Its default blocks edits in the
  main checkout of a background session until a worktree is entered.
- The base: Claude Code starts from `origin/<default branch>` by default, Cycle from `HEAD`. Rule 1
  makes it Cycle's, and the owner may want the other.
- The page's file search and its `@` suggestions: read from the code, not tried.
- Moving an existing session into a worktree: codex's `turn/start` `cwd` would allow it, Claude Code's
  process cannot change it. Not designed.

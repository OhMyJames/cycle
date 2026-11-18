# Worktrees

The design of the worktree: who makes one, where it lives, what a session's folder is when one is
used, and how it ends. It follows [the entities](entities.md) and gives the operations
[operations](operations.md) lacks for it.

Status: **draft**. One thing is **Decided** by the owner: worktrees live at
`<workspace>/.agents/worktree/`. Everything else is **Proposed**, with its reason. The parts that could be
tried were tried (the section "What was tried"); what could not be is at the end.

## What was found

- **Cycle today.** The daemon makes the worktree before the agent starts, with `git worktree add`
  (`SessionHub.create`, `Git.addWorktree`), at `<repo>/.agents/worktree/<the branch, made safe>`
  (made unique), where `<repo>` is the main checkout; worktrees older daemons made are under
  `CYCLE_HOME/worktrees/<repo folder>/<the branch, made safe>` and stay there. The agent is given the
  folder as the session's `cwd`. The record, `{repo, base, branch, path, origin}`, is only in
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
   (**Done**, step 14; tried, see below.) The daemon refuses what it must, in words the agent's model
   reads (a session in a container, one that already has a worktree, a name git or a folder would
   misread), and never makes the worktree from the hook's own folder, only the session's.
2. **Place: `<workspace>/.agents/worktree/<name>`.** (Decided; **done**, step 11, with
   [its note](../.agents/notes/2026-11-18-worktrees-live-in-the-workspace.md).) The name is the
   branch, made safe. The path is made unique, not only the branch: two repositories of one name no
   longer meet, and `a/b` and `a-b` get `a-b` and `a-b-2`. For a project that is a subfolder of its
   repository, the worktree is at the repository's root, and the session starts in the same
   subfolder inside it.
3. **Hidden from git and from tools.** (**Done**, step 11.) Cycle writes `.agents/worktree/.gitignore`
   holding `*` before it makes a worktree, and never over one that is there. The folder then ignores itself and everything in it, with nothing changed outside it
   and no line in the owner's `.gitignore`: `git status` stays quiet, and `git add -A`, which Cycle's
   commit uses, does not stage a checkout inside the checkout. The formatter, the linter and `bun test` of this repository skip it, so
   it needs no line in their configuration (tried). What does not read `.gitignore` still sees the
   folder: the page's file search and its `@` suggestions leave it out (`Files.search`).
4. **A session's `cwd` is the key of the agent's record, and never changes.** (**Done**, step 14.)
   Where the agent works now is `worktree.path` when the agent entered the worktree (`origin:
   "agent"`), else `cwd` (`workingDir`, in `@cycle/protocol`). Not `worktree.path ?? cwd`: for a
   worktree the owner made of a project that is a subfolder, `path` is the repository's root and
   `cwd` is the root plus the subfolder, which the panels must keep. The files, terminal and changes
   of the page follow it. **Claude Code remembers the worktree itself**: a process started with
   `resume` begins in it, from the folder it was given. So Cycle reads where the agent is from the
   `cwd` of the process's `init` message (it comes with each prompt, and says where the agent is
   now), and brings `Session.worktree` into line: the agent is in its worktree, or inside it:
   nothing; back in its own folder (or below it, but not in a worktree: every one is inside its
   repository): the record goes, and the folder stays; anywhere else, nothing changes and the owner
   is told. Paths are compared as the machine resolves them: `init` says a real path, and the
   session's folder may be a link.
5. **A worktree is shared by forks and kept by archive.** (**Done**, step 12.) Only the owner removes
   one: with `session.delete { removeWorktree: true }`, and with `worktree.remove` (**done**, step 13, the
   daemon's part). The
   daemon refuses, before it changes anything, while another session runs in it (its record names the
   worktree, or its folder is in it) and while another session's record names it, archived or not, fork
   or not. Removal discards uncommitted and untracked files (`--force`; the box in the delete dialog is
   the owner's consent) and keeps the branch. A locked worktree is not removed. The one removal the
   daemon does by itself is of a worktree made for a session that failed to start.
6. **A worktree made for a session that never started goes with it.** (**Done**, step 12.) One is removed
   when the agent fails to start (`SessionHub.create`), and when the page drops a session that was made
   and never sent to (`client/app.ts`), which asks for it; the branch is kept.
7. **The branch is kept when a worktree is removed**, as today, and so is the folder when the agent
   asks for `remove`. (**Done**, step 14.) Only the owner removes one (rule 5): the `WorktreeRemove`
   callback removes nothing, Claude Code removes neither (tried) and tells its model "removed", and
   the thread says what is true: "Claude Code asked to remove the worktree `<branch>`. Cycle keeps it
   until you remove it." The agent is back in its own folder, so the session's record goes; the
   folder waits in Settings, Worktrees. A helper agent's worktree is made and left to the owner.
8. **A session in a container cannot have one**, unchanged: its history is in the repository's folder,
   which the container would not hold (`sessions.ts:246`).
9. **Worktrees already under `CYCLE_HOME/worktrees` stay as they are.** (**Done**, step 11.) Their
   record holds the path (read from the session's `cwd` when an older daemon did not write it),
   nothing moves, and the files panel still may read there.

## Operations and events

| Operation                             | Does                                                                                        | Today                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------- |
| `session.create { worktree }`         | makes one for the session, on a branch if given, from a base if given                       | the same                  |
| `session.delete { removeWorktree }`   | removes it with the session, under rule 5                                                   | the same, with the checks |
| `worktree.list { workspace }`         | what `git worktree list` knows, each marked by where it is, with the sessions that use each | the same                  |
| `worktree.remove { workspace, path }` | removes a worktree Cycle made that no running session is in                                 | the same                  |

- **The result and the rules** of the two new rows are in [operations](operations.md#worktrees):
  `worktree.remove` takes the `workspace` too, since the path is checked against that repository's
  own list. By hand means not directly under `.agents/worktree` or in the older place (so a worktree
  inside another is by hand): listed, never removed. A folder there that git does not list is not a
  worktree and is not listed.
- **Event:** the harness's `session.changed` carries `workingDir`, where the agent says it works
  now; the page hears `sessions.changed`, whose `Session.worktree` is the record. No new item kind
  is needed: an `EnterWorktree` is a tool call in the turn as it is today.
- **For the agent contract:** an agent that can enter a worktree on its own says so by operation id
  (`worktree.enter`), and the harness gives Cycle's creation to it. codex does not declare it.
- **Settings:** `Settings.worktree` and a schedule's `worktree` flag stay as the defaults of a new
  session and of each run.

## What it changes

- `git.ts`: the path, its uniqueness, the self-ignoring file, and a lock for each repository
  (**done**, step 11).
- `sessions.ts`: `Session.worktree` gaining `path` and `origin` (**done**, step 11); the removal
  checks and the dropped session (**done**, step 12), the entered worktree (**done**, step 14:
  `enterWorktree`, `leaveWorktree`, and where the agent says it is). `worktrees.ts`: the list and
  the removal of the owner's worktrees (**done**, step 13).
- `harness/claude`: the two hooks, given to each process on this machine, and `init`'s `cwd` read
  (**done**, step 14; the port is `WorktreePort`, and `WorktreeDesk` in the daemon serves it). A
  process in a container gets neither the hooks nor the two built-in tools.
- `Files`: leave `.agents/worktree` out of search (**done**, step 11). Reading stays allowed: it is
  inside a project, and `CYCLE_HOME/worktrees` stays on the list for the old ones.
- The page: a list of a workspace's worktrees, with Remove (**done**, step 13: Settings,
  Worktrees); the files, terminal and changes panels read the folder the agent works in (**done**,
  step 14); the dialog that deletes a session names a worktree other sessions use; the sidebar's
  mark.
- `CLAUDE.md`'s Runtime data, which lists `worktrees/` under `CYCLE_HOME` (**done**, step 11). This
  repository's own formatter, linter and tests need nothing.
- A decision note, since `sessions.json`'s `worktree` changes shape (**done**, step 11). Old records
  stay readable.
- Tests: `removeWorktree`, the cleanup when a session fails to start, a delete that removes it and a
  fork's sharing are covered since step 11 (`worktree-session.test.ts`, `worktree-git.test.ts`); the
  removal rules since step 12 (`worktree-removal.test.ts`, `worktree-users.test.ts`, and with real git
  `integration/worktree.test.ts`). The page's dropped session has no test: `CycleApp` has no seam.

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

**With the callbacks answered by Cycle** (step 14; the same Claude Code, scratch repositories, scratch homes):

- **A refusal's words.** A callback that throws, or answers `continue: false` or `decision: "block"`,
  gives the model only "hook succeeded but returned no worktree path". The one place it reads a
  callback's words is Claude Code's error for a path that does not exist, so a refusal is a path
  that begins `/cycle-refused: ` and the words as one line. Nothing is made, and a later good
  `EnterWorktree` in the same process works.
- **Where the agent is.** `init` comes with each prompt, not once for a process, and its `cwd` is
  where the agent is now: after a live enter it says the worktree, after a live `keep` it says the
  project, on the next prompt. `CwdChanged` does not fire, and the stream carries no change of
  folder. A process begun again with `resume` from the project starts in the worktree, and after a
  `keep` in it, in the project. A **fork** of a session that entered one begins in the project. With
  the worktree's folder gone, `resume` starts in the project with no error.
- **`remove`.** Without `discard_changes: true` Claude Code refuses itself, before any hook. With it,
  `WorktreeRemove` is called with the worktree's root; its words do not reach the model ("Exited and
  removed worktree"); folder and branch stay; the agent is back in the project.
- **The owner's own hook.** `disableAllHooks: true` does not stop the SDK's callbacks. An owner's own
  `WorktreeCreate` command hook runs beside Cycle's, and its path wins: Cycle's worktree is made
  and left unused. The daemon notices that the agent works in a folder it made nothing of, and says so.
- **Other ways in.** `EnterWorktree { path }` of a worktree that exists calls no hook (and asks for
  an approval, "permission-root relocation"). By name it asks for none. A helper agent started with
  `isolation: "worktree"` calls `WorktreeCreate` with the session's id, no `agent_id` and the name
  `agent-<id>`; no `WorktreeRemove` was seen when it ended. A second `EnterWorktree` is refused by Claude
  Code itself ("Already in a worktree session"), as is a helper's own.
- **Around it.** `Write` and `Edit` in the main checkout are not blocked by `bgIsolation`, in `default` and
  `acceptEdits`. History after entering reads from the project's folder (`getSessionMessages`,
  `getSessionInfo`, `listSessions`: its `cwd`), and `git status` of the project stays quiet. The
  page's file search from the project's root finds nothing in the worktree, and from inside it,
  finds the file.

## Is it one behavior?

For the owner, yes: a worktree is made, listed, shown, changed and removed one way, wherever it came
from and whichever agent the session is on. What stays different is in the agents:

| Part                            | codex          | Claude Code                                                                                                                                           |
| ------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| the owner asks for one at start | Cycle makes it | Cycle makes it                                                                                                                                        |
| the agent enters one itself     | cannot         | can: through Cycle's hook, so the same worktree                                                                                                       |
| where the agent is on a restart | Cycle's record | its own memory; Cycle reads `init`'s `cwd`                                                                                                            |
| the agent leaves one            | cannot         | `keep` calls nothing, so Cycle sees it in `init`, at the next prompt; `remove` needs `discard_changes` and calls Cycle's hook, which keeps the folder |
| a worktree of Claude Code's own | none           | made by the CLI under `.claude/worktrees` (six in this checkout); Cycle lists them, does not manage them                                              |

Cycle gives the agent no tool of its own to enter one: its tools only read, which is a red line.
So codex stays without the second row, and the contract says so by declaring it.

## Not checked

- The base: Claude Code starts from `origin/<default branch>` by default, Cycle from `HEAD`, which is
  the base even when it is unpushed (decided by the owner; `worktree.baseRef` is not read).
- The page's `@` suggestions inside a worktree: they search the project's folder until the composer
  follows `workingDir` too.
- Claude Code's `worktree.symlinkDirectories` and `sparsePaths` are not applied: the checkout is
  Cycle's, as for an owner-made one. A project that is a subfolder gets the worktree's root, not
  the same subfolder inside it, which the owner-made flow keeps.
- A `claude` on the owner's `PATH` older than the SDK's may not call the callbacks: it then makes
  its own worktree under `.claude/worktrees`, which Cycle does not record.
- A helper agent's worktrees are made through Cycle and left to the owner, so they pile up under
  `.agents/worktree` until removed in Settings, Worktrees.
- Moving an existing session into a worktree: codex's `turn/start` `cwd` would allow it, Claude Code's
  process cannot change it. Not designed.

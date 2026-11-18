# Agent Note: Worktrees live in the workspace, under `.agents/worktree/`

Status: accepted
Date: 2026-11-18
Basis: [the worktree design](../../docs/worktree.md) and the 2026-11-17 experiments with the real Claude Code
and with git (`.plans/2026-11-17-worktree/`); the owner's decision of the place, `<workspace>/.agents/worktree/`.
Step 11 of the migration to [the entities](../../docs/entities.md).

## Problem

A worktree under `CYCLE_HOME/worktrees` is outside the project: the owner cannot find it by looking at the
project, and Claude Code's own `EnterWorktree` makes another under `.claude/worktrees`, so there are two places
and two ways to end. Two repositories of one folder name, or the branches `a/b` and `a-b`, ask for one path.
One lock serves every repository, though its comment says one for each. `sessions.json` does not say where a
worktree is, or who made it: the path is guessed from the session's `cwd`.

## Decision

- **Where.** `<repo>/.agents/worktree/<name>`, `<repo>` being the main checkout's root, read from
  `git rev-parse --path-format=absolute --git-common-dir` (its dirname, when it is named `.git`). A worktree
  made from inside a linked worktree is still made in the main checkout, not nested in the linked one. When
  the common dir is not named `.git` (a submodule's, a `--separate-git-dir` repository's), or git is older
  than 2.31 and does not know `--path-format`, the folder's own root (`--show-toplevel`) is the checkout, as
  it was before; a worktree made from inside a linked worktree of such a repository then nests in it. Only a
  bare repository is refused ("A worktree needs a git checkout."): it has no toplevel, and
  `rev-parse --is-bare-repository` says so.
- **A project that is a subfolder of its repository** gets the worktree at the repository's root, not under
  the subfolder, so a repository has one `.agents/` and a whole checkout is not nested in a folder of itself.
  The session starts in the same subfolder inside the worktree, as before. When the project is the repository,
  which is the usual case, this is the owner's `<workspace>/.agents/worktree/`.
- **The name** is the branch made safe (`branchSlug`), after the existing suffix for a taken branch. The path is
  then made unique: while `test -e <path>` finds it, `-2`, `-3` are added to the name. The branch keeps the name
  the branch loop gave it.
- **The folder ignores itself.** Before every `git worktree add`, the daemon makes
  `.agents/worktree/.gitignore` holding `*`, idempotently: a file or a symlink (even a dangling one) already
  there is never written over. It does so through the
  harness's `exec` (`mkdir` and `printf`), because the daemon reaches the project only through the harness
  and `Machine` has no write; on a remote daemon this runs on the agent's machine.
- **The lock** is one for each repository, keyed by the git common dir. A call chains onto its repository's
  tail, and a failure does not hold the next call. Different repositories do not wait for each other. Removal
  resolves the common dir of its `repo` the same way, so an old record whose `repo` is a linked worktree
  shares the lock of its main checkout.
- **What is stored.** `sessions.json`'s `worktree` gains `path` (the worktree's root: its identity, and what
  removal acts on) and `origin` (`owner` when Cycle made it as the session was, `agent` when the agent entered
  it; this step writes only `owner`, and the type has both so the next step does not change the format again).
  A record without them is read as `origin: "owner"` and `path` the first two folders under
  `CYCLE_HOME/worktrees` of the session's `cwd` (`<repo folder>/<name>`), else the `cwd`. `repo` keeps its name.
- **`cwd` is unchanged.** It is the worktree's `path` plus the project's subfolder, still the key of the
  agent's record and where the agent works; no reader of `cwd` changes.
- **Old worktrees stay.** Nothing moves; a record under `CYCLE_HOME/worktrees` is valid and removable, and
  the files panel may still read there.
- **Search leaves the folder out.** `Files.search` drops a match with `.agents/worktree` as two folders in a
  row, relative to the searched root, beside `.git`; a session whose own root is a worktree still finds its
  files. Listing and reading are not changed.

## Alternatives considered

- `.git/info/exclude`, or a line in the owner's `.gitignore`. Both change a file outside the folder; ours
  ignores itself and changes nothing else.
- `.claude/worktrees`. One agent's folder, and the owner's decision was another.
- Keeping `CYCLE_HOME/worktrees`. Outside the project: the problem above.
- A `Machine.writeFile` for the ignore file: a method on both harnesses for one file. Later, if more is written.
- A unique id in the name. Hides the branch the owner chose.
- Moving the old worktrees: `git worktree move` while sessions run, and their history is keyed by the folder.
- Renaming `repo` to `workspace` now. The rename comes with the workspaces step.

## Consequences

- `WorktreeInfo.repo` now means the main checkout's root (it was `--show-toplevel` of the project). When the
  owner's project is itself a linked worktree, the session's `repo` is the main checkout and differs from the
  project. Its users are the sidebar grouping (`projectOf` in `packages/ui/src/client/app.ts`), the daemon's
  `useProject(info.worktree.repo)` and the folders the owner may read (`SessionHub.folders`): such a session is
  grouped under the main checkout, which is put first in the owner's projects, and its files are readable.
- A worktree is inside the repository it came from. A tool that does not read `.gitignore` sees it; the
  page's search is the one Cycle owns and leaves it out. A `git clean -fdx` in the main checkout would remove
  it (not checked), as would a repository that tracks `.agents/worktree/`.
- The session's `cwd` is still the path of the agent's record. Where the agent works, when it differs from
  `cwd`, is for the step that lets Claude Code enter a worktree through Cycle.
- Older daemons read the new records (the added fields are ignored) and the new daemon reads the old ones.
- A worktree registered whose folder is gone is not seen by the `test -e` loop; `git worktree prune` is not
  run.
- `CLAUDE.md`'s Runtime data line about `worktrees/` becomes: the worktrees older daemons made.

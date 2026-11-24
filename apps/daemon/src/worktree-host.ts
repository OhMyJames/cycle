// What EnterWorktree and ExitWorktree do to a session (docs/protocol.md §6 "Worktree"), for the agents that use Cycle's
// own tools. The session's folder changes at once for Cycle (files, diff, terminals); the agent's own folder changes
// from its next turn, when it is started again where the session now is.
import type { SessionEnvironment } from "@cycle/protocol";
import {
  type EnterInput,
  type ExitInput,
  ToolRefusal,
  type WorktreeHost,
} from "./connectors/worktree-mcp.ts";
import { environmentOf, scriptFor, sessionVariables } from "./environment.ts";
import type { SessionEntry } from "./index-file.ts";
import { CLEANUP_TIMEOUT_MS, runScript, SETUP_TIMEOUT_MS } from "./scripts.ts";
import type { Session } from "./session.ts";
import {
  createWorktree,
  findWorktree,
  removeWorktree,
  unsavedIn,
  WorktreeError,
} from "./worktree.ts";

export type WorktreeHostDeps = {
  /** A running session; undefined for one that is not loaded. */
  session(sessionId: string): Session | undefined;
  /** Changes the session's index entry and tells the clients. */
  remember(session: Session, patch: Partial<SessionEntry>): void;
  warn(event: string): void;
};

const refuse = (error: unknown): never => {
  if (error instanceof WorktreeError) throw new ToolRefusal(error.message);
  throw error;
};

export const worktreeHost = (deps: WorktreeHostDeps): WorktreeHost => ({
  async enter(sessionId, input: EnterInput) {
    const session = deps.session(sessionId);
    if (session === undefined) throw new ToolRefusal("This session is not running");
    if (session.entry.worktree !== undefined)
      throw new ToolRefusal(
        `Already in a worktree (${session.entry.worktree.path}). Call ExitWorktree first.`,
      );
    const environment: SessionEnvironment | undefined = environmentOf(session.entry);
    try {
      const made =
        input.path !== undefined
          ? { ...(await findWorktree(session.entry.cwd, input.path)), created: false }
          : await createWorktree(session.entry.cwd, { name: input.name });
      let setupFailed: string | undefined;
      const setup = made.created ? scriptFor(environment?.setup) : undefined;
      if (setup !== undefined) {
        const ran = await runScript(setup, {
          cwd: made.path,
          variables: sessionVariables(session.entry),
          timeoutMs: SETUP_TIMEOUT_MS,
        });
        if (!ran.ok) setupFailed = ran.output || "The setup script failed";
      }
      deps.remember(session, {
        cwd: made.path,
        worktree: {
          root: made.root,
          path: made.path,
          managed: made.created,
          ...(made.branch !== undefined ? { branch: made.branch } : {}),
          ...(setupFailed !== undefined ? { setupFailed } : {}),
        },
      });
      session.markStale("cwd");
      return {
        worktreePath: made.path,
        ...(made.branch !== undefined ? { worktreeBranch: made.branch } : {}),
        message: `${made.created ? "Created" : "Entered"} worktree at ${made.path}${
          made.branch !== undefined ? ` on branch ${made.branch}` : ""
        }. The working directory changes from the next turn.${
          setupFailed !== undefined ? ` The setup script failed: ${setupFailed}` : ""
        }`,
      };
    } catch (error) {
      return refuse(error);
    }
  },

  async exit(sessionId, input: ExitInput) {
    const session = deps.session(sessionId);
    if (session === undefined) throw new ToolRefusal("This session is not running");
    const tree = session.entry.worktree;
    if (tree === undefined) throw new ToolRefusal("Not in a worktree: nothing to exit.");
    const base = {
      action: input.action,
      originalCwd: tree.root,
      worktreePath: tree.path,
      ...(tree.branch !== undefined ? { worktreeBranch: tree.branch } : {}),
    };
    let discarded: { files: number; commits: number } | undefined;
    if (input.action === "remove") {
      if (!tree.managed)
        throw new ToolRefusal(
          'This worktree was not made by Cycle, so Cycle does not remove it. Use action "keep".',
        );
      const found = {
        root: tree.root,
        path: tree.path,
        ...(tree.branch !== undefined ? { branch: tree.branch } : {}),
      };
      const unsaved = await unsavedIn(found).catch(refuse);
      const lost = unsaved.files.length + unsaved.commits.length;
      if (lost > 0 && input.discard_changes !== true)
        throw new ToolRefusal(
          `The worktree holds work that would be lost: ${unsaved.files.length} uncommitted file(s)${
            unsaved.files.length > 0 ? ` (${unsaved.files.slice(0, 20).join(", ")})` : ""
          } and ${unsaved.commits.length} commit(s) on no other branch${
            unsaved.commits.length > 0 ? ` (${unsaved.commits.slice(0, 20).join("; ")})` : ""
          }. Pass discard_changes: true to remove it anyway, or use action "keep".`,
        );
      discarded = { files: unsaved.files.length, commits: unsaved.commits.length };
      const cleanup = scriptFor(environmentOf(session.entry)?.cleanup);
      if (cleanup !== undefined) {
        const ran = await runScript(cleanup, {
          cwd: tree.path,
          variables: sessionVariables(session.entry),
          timeoutMs: CLEANUP_TIMEOUT_MS,
        });
        if (!ran.ok) deps.warn("worktree_cleanup_failed");
      }
      // The agent's own folder is the worktree until its next turn; the turn that called this is still running in it.
      await removeWorktree(found, discarded.commits > 0).catch(refuse);
    }
    // `worktree: undefined` takes the key out of the entry.
    deps.remember(session, { cwd: tree.root, worktree: undefined } as Partial<SessionEntry>);
    session.markStale("cwd");
    return {
      ...base,
      ...(discarded !== undefined
        ? { discardedFiles: discarded.files, discardedCommits: discarded.commits }
        : {}),
      message:
        input.action === "keep"
          ? `Left the worktree at ${tree.path}; it and its branch are kept. The working directory changes from the next turn.`
          : `Removed the worktree at ${tree.path}${tree.branch !== undefined ? ` and its branch ${tree.branch}` : ""}. The working directory changes from the next turn.`,
    };
  },
});

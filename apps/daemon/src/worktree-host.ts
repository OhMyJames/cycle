// What EnterWorktree and ExitWorktree do to a session (docs/protocol.md §6 "Worktree"), for the agents that use Cycle's
// own tools. The session's folder changes at once for Cycle (files, diff, terminals); the agent's own folder changes
// from its next turn, when it is started again where the session now is.
import { resolve } from "node:path";
import type { SessionEnvironment } from "@cycle/protocol";
import {
  type EnterInput,
  type ExitInput,
  ToolRefusal,
  type WorktreeHost,
} from "./connectors/worktree-mcp.ts";
import { commandVariables, environmentOf, scriptFor } from "./environment.ts";
import type { SessionEntry } from "./index-file.ts";
import { CLEANUP_TIMEOUT_MS, runScript, SETUP_TIMEOUT_MS } from "./scripts.ts";
import type { Session } from "./session.ts";
import {
  createWorktree,
  findWorktree,
  listWorktrees,
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
  /** Where `secrets.env` is: the secrets a setup or cleanup script is given. */
};

const refuse = (error: unknown): never => {
  if (error instanceof WorktreeError) throw new ToolRefusal(error.message);
  throw error;
};

/** What Claude's hooks tell of its own EnterWorktree or ExitWorktree (harness/claude/src/worktree-hooks.ts). */
export type NativeWorktreeCall = {
  phase: "before" | "after";
  tool: string;
  toolUseId: string;
  input?: unknown;
  /** The tool's answer, in `after`. */
  response?: unknown;
};

const field = (value: unknown, key: string): unknown => {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;
};

/**
 * Claude's own worktree tools (docs/protocol.md §6 "中途进出"): setup after the tool made a worktree, cleanup before it
 * removes one. Only a worktree this session's EnterWorktree made is touched: one it entered, or any other, is not.
 * What is known is kept in memory: a daemon that restarts forgets which worktrees Claude made, and then leaves them.
 */
const nativeWorktrees = (deps: WorktreeHostDeps) => {
  /** The worktrees each session had before an EnterWorktree began, by tool call. */
  const before = new Map<string, Set<string>>();
  /** The worktrees a session's Claude made. */
  const made = new Map<string, Set<string>>();
  /** The worktree a session's Claude is in through EnterWorktree. */
  const inside = new Map<string, string>();
  const known = async (cwd: string) =>
    new Set((await listWorktrees(cwd).catch(() => [])).map((tree) => resolve(tree.path)));

  return async (sessionId: string, call: NativeWorktreeCall): Promise<{ note?: string }> => {
    const session = deps.session(sessionId);
    if (session === undefined) return {};
    if (call.tool === "EnterWorktree") {
      if (call.phase === "before") {
        before.set(call.toolUseId, await known(session.entry.cwd));
        return {};
      }
      const seen = before.get(call.toolUseId);
      before.delete(call.toolUseId);
      const path = field(call.response, "worktreePath");
      if (typeof path !== "string" || seen === undefined) return {};
      inside.set(sessionId, resolve(path));
      if (seen.has(resolve(path))) return {};
      if (!(await known(path)).has(resolve(path))) return {};
      const own = made.get(sessionId) ?? new Set<string>();
      own.add(resolve(path));
      made.set(sessionId, own);
      const setup = scriptFor(environmentOf(session.entry)?.setup);
      if (setup === undefined) return {};
      // The agent chose this moment and the code in the worktree: the script gets the literal variables only.
      const ran = await runScript(setup, {
        cwd: path,
        variables: commandVariables(session.entry),
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      if (ran.ok) return {};
      deps.warn("worktree_setup_failed");
      return { note: `The environment's setup script failed: ${ran.output || "no output"}` };
    }
    if (call.tool !== "ExitWorktree") return {};
    const path = inside.get(sessionId);
    if (call.phase === "after") {
      // A kept worktree is still one Claude made here: it is cleaned up when it is entered and removed later.
      if (path !== undefined && field(call.input, "action") === "remove")
        made.get(sessionId)?.delete(path);
      inside.delete(sessionId);
      return {};
    }
    if (path === undefined || !made.get(sessionId)?.has(path)) return {};
    if (field(call.input, "action") !== "remove") return {};
    const [tree] = (await listWorktrees(path).catch(() => [])).filter(
      (found) => resolve(found.path) === path,
    );
    // Claude refuses to remove unsaved work unless told to discard it: the worktree then stays, and so does its cleanup.
    if (tree !== undefined && field(call.input, "discard_changes") !== true) {
      const unsaved = await unsavedIn(tree).catch(() => undefined);
      if (unsaved === undefined || unsaved.files.length + unsaved.commits.length > 0) return {};
    }
    const cleanup = scriptFor(environmentOf(session.entry)?.cleanup);
    if (cleanup === undefined) return {};
    const ran = await runScript(cleanup, {
      cwd: path,
      variables: commandVariables(session.entry),
      timeoutMs: CLEANUP_TIMEOUT_MS,
    });
    if (!ran.ok) deps.warn("worktree_cleanup_failed");
    return {};
  };
};

export const worktreeHost = (
  deps: WorktreeHostDeps,
): WorktreeHost & { native: ReturnType<typeof nativeWorktrees> } => {
  // One call at a time for a session: a retry of a call that is still running must not race it.
  const tails = new Map<string, Promise<unknown>>();
  const serial = <T>(sessionId: string, run: () => Promise<T>): Promise<T> => {
    const result = (tails.get(sessionId) ?? Promise.resolve()).then(run, run);
    const tail = result.catch(() => undefined);
    tails.set(sessionId, tail);
    void tail.then(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId);
    });
    return result;
  };
  return {
    enter: (sessionId, input) => serial(sessionId, () => enter(deps, sessionId, input)),
    exit: (sessionId, input) => serial(sessionId, () => exit(deps, sessionId, input)),
    native: nativeWorktrees(deps),
  };
};

const enter = async (deps: WorktreeHostDeps, sessionId: string, input: EnterInput) => {
  {
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
        // The agent chose this moment and the code in the worktree: the script gets the literal variables only.
        const ran = await runScript(setup, {
          cwd: made.path,
          variables: commandVariables(session.entry),
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
  }
};

const exit = async (deps: WorktreeHostDeps, sessionId: string, input: ExitInput) => {
  {
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
          variables: commandVariables(session.entry),
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
  }
};

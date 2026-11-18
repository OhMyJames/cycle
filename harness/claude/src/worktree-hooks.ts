import type { WorktreePort } from "@cycle/protocol";
import type { QueryOptions } from "./sdk.ts";
import type {
  WireWorktreeCreateInput,
  WireWorktreeOutput,
  WireWorktreeRemoveInput,
} from "./wire.ts";

/**
 * Longest a hook may take, in seconds: making a worktree may wait for its repository's lock, and
 * its checkout may run for two minutes.
 */
const HOOK_SECONDS = 180;

/** What a name the model chose may be: it becomes a branch and a folder. */
const NAME = /^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,63}$/;
const BAD_NAME = "A worktree's name is letters, digits, dots, dashes and slashes, 64 at most.";

/**
 * The name Claude Code gives the worktree of a helper agent started with `isolation: "worktree"`:
 * `agent-` and the helper's id. It asks through the main agent's own call, so the hook's input
 * names no helper (tried: no `agent_id`), and it comes before the stream says the helper began.
 * shortcut: a helper is known by this name and by `agent_id`; upgrade when the input names it.
 */
const HELPER_NAME = /^agent-[0-9a-f]{8,}$/;

/** The tools Claude Code makes a worktree with on its own, which only Cycle makes. */
export const WORKTREE_TOOLS = ["EnterWorktree", "ExitWorktree"];

/** What the harness does with where the agent works: its stream's folder follows. */
export interface WorktreeMoves {
  /** The agent is in this worktree now. */
  entered(path: string): void;
  /** The agent is back in its own folder. */
  left(): void;
}

/** What every refusal's path begins with, so that no message can plausibly name a folder. */
const REFUSED = "/cycle-refused: ";
/** The longest the words of a refusal go: a path is at most 255 to a name, and the model reads it. */
const WORDS_LIMIT = 200;

/**
 * Claude Code carries no refusal's words from a hook to its model (tried: a throw, `continue:
 * false`, `decision: "block"` and `onFailure: "block"` all end in "returned no worktree path"),
 * except in one place: a path that is not there is named in its error. The refusal is that path.
 * What it is made of is the port's message, which is git's stderr at times, so it is one line (a
 * path's last line is what resolves), at most `WORDS_LIMIT` long, with no segment of `.` or `..`
 * (a path is cleaned before it is looked for), and after a prefix no folder has: a message of
 * `etc` alone was once a folder Claude Code entered.
 */
function refusal(why: string): WireWorktreeOutput {
  const words = why
    .replaceAll("\0", " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, WORDS_LIMIT)
    // After the cut, which may leave a `..` at the end.
    .replaceAll(/\/(?=\.{1,2}(\/|$))/g, "/ ")
    .trim();
  const said = words || "Cycle could not make a worktree.";
  return {
    hookSpecificOutput: { hookEventName: "WorktreeCreate", worktreePath: `${REFUSED}${said}` },
  };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The two hooks that make Claude Code's worktrees Cycle's: the callback is in this process, so it
 * runs where the daemon's own state is and needs no command and no credential. `sessionId` is the
 * session the process runs, not what the hook's input says of it.
 */
export function worktreeHooks(
  port: WorktreePort,
  sessionId: string,
  moves: WorktreeMoves,
  log: (line: string) => void,
): NonNullable<QueryOptions["hooks"]> {
  return {
    WorktreeCreate: [
      {
        timeout: HOOK_SECONDS,
        hooks: [
          async (input: WireWorktreeCreateInput) => {
            if (!NAME.test(input.name) || input.name.includes("..")) return refusal(BAD_NAME);
            const helper = input.agent_id !== undefined || HELPER_NAME.test(input.name);
            try {
              const { path } = await port.enter({ sessionId, name: input.name, helper });
              // The agent of a helper is not the session's own: it stays where it was.
              if (!helper) moves.entered(path);
              return {
                hookSpecificOutput: { hookEventName: "WorktreeCreate", worktreePath: path },
              };
            } catch (error) {
              return refusal(messageOf(error));
            }
          },
        ],
      },
    ],
    WorktreeRemove: [
      {
        timeout: HOOK_SECONDS,
        hooks: [
          async (input: WireWorktreeRemoveInput) => {
            const helper = input.agent_id !== undefined;
            try {
              await port.leave({ sessionId, path: input.worktree_path, helper });
            } catch (error) {
              // Claude Code tells its model "removed" whatever this answers, and a failed hook ends
              // as an empty answer: what is known of it is for the log.
              log(`WorktreeRemove: ${messageOf(error)}`);
            }
            // Claude Code puts the agent back in its own folder, as for any removal.
            if (!helper) moves.left();
            return {};
          },
        ],
      },
    ],
  };
}

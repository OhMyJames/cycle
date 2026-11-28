// Claude's own EnterWorktree and ExitWorktree, told to the daemon (docs/protocol.md §6 "Worktree", "中途进出"). The tools
// make and remove the worktree inside the process, so only a hook that the process waits for can run the environment's
// cleanup before the removal and its setup before the agent goes on. The daemon owns the environment and the scripts:
// the hooks only say which tool is about to run (`before`) and what it answered (`after`), and wait for the daemon.
import type { AgentContext } from "@agentclientprotocol/sdk/experimental/v2";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionState } from "./session.ts";

/** `@cycle/protocol`'s `WORKTREE_HOOK`; the adapter stays self-contained. */
export const WORKTREE_HOOK = "_cycle/worktree/hook";

/** Setup may run 10 minutes in the daemon (SETUP_TIMEOUT_MS), cleanup 60 seconds: the hook waits a little longer. */
const AFTER_ENTER_SECONDS = 11 * 60;
const BEFORE_EXIT_SECONDS = 2 * 60;

const tell =
  (client: AgentContext, session: SessionState, phase: "before" | "after"): HookCallback =>
  async (input, _id, { signal }) => {
    if (input.hook_event_name !== "PreToolUse" && input.hook_event_name !== "PostToolUse")
      return {};
    const answer = await client
      .request<unknown, unknown, string>(
        WORKTREE_HOOK,
        {
          sessionId: session.id,
          phase,
          tool: input.tool_name,
          toolUseId: input.tool_use_id,
          input: input.tool_input,
          ...(input.hook_event_name === "PostToolUse" ? { response: input.tool_response } : {}),
        },
        { cancellationSignal: signal },
      )
      // A daemon that does not know the request: the tool goes ahead as it would without the hook.
      .catch(() => undefined);
    const note = (answer as { note?: unknown } | undefined)?.note;
    if (typeof note !== "string" || note === "") return {};
    return input.hook_event_name === "PostToolUse"
      ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } }
      : {};
  };

/** Decides nothing: the tool goes ahead whatever the daemon says (a failed script never stops a worktree's making or removal). */
export const worktreeHooks = (
  client: AgentContext,
  session: SessionState,
): NonNullable<Options["hooks"]> => ({
  PreToolUse: [
    { matcher: "EnterWorktree", hooks: [tell(client, session, "before")] },
    {
      matcher: "ExitWorktree",
      hooks: [tell(client, session, "before")],
      timeout: BEFORE_EXIT_SECONDS,
    },
  ],
  PostToolUse: [
    {
      matcher: "EnterWorktree",
      hooks: [tell(client, session, "after")],
      timeout: AFTER_ENTER_SECONDS,
    },
    { matcher: "ExitWorktree", hooks: [tell(client, session, "after")] },
  ],
});

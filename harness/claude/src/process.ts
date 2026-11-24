import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AskingOptions } from "./permissions.ts";
import type { AdapterConfig, Live, QueryFn, SessionState } from "./session.ts";
import { claudeJsonPath, recordTrust } from "./trust.ts";

/** Claude's task-list tools: what a plan is made of (docs/adapters/claude.md). */
export const TASK_TOOLS = ["TaskCreate", "TaskGet", "TaskUpdate", "TaskList"];

/** What a process calls back that is not the session's settings: how it asks the person, and its hooks. */
export type ProcessCallbacks = AskingOptions & { hooks: NonNullable<Options["hooks"]> };

/**
 * Starts a Claude process for the session, in streaming-input mode: its input is a queue that prompts are pushed into,
 * so one process serves many turns. Only the process: what it says is read by whoever holds the `Live`.
 */
export const spawn = (
  config: AdapterConfig,
  runQuery: QueryFn,
  session: SessionState,
  callbacks: ProcessCallbacks,
): Live => {
  // Before the process reads it: whether this folder may run its own configuration's commands.
  if (session.setup.trusted !== undefined) {
    const file = claudeJsonPath(config.env);
    const result =
      file === undefined ? undefined : recordTrust(file, session.cwd, session.setup.trusted);
    if (typeof result === "object") {
      console.error(`cycle: folder trust not recorded for ${session.cwd}: ${result.failed}`);
    }
  }
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* input(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (queue.length > 0) yield queue.shift() as SDKUserMessage;
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const abort = new AbortController();
  const options: Options = {
    cwd: session.cwd,
    // The session's variables reach the commands Claude runs, through a file it sources before each, never its own
    // environment (env-file.ts).
    env:
      config.sessionEnvFile !== undefined
        ? { ...config.env, CLAUDE_ENV_FILE: config.sessionEnvFile }
        : config.env,
    ...(session.setup.additionalDirectories.length > 0
      ? { additionalDirectories: session.setup.additionalDirectories }
      : {}),
    ...(Object.keys(session.setup.mcpServers).length > 0
      ? // Over stdin, not argv: a server's env and headers can hold secrets.
        { mcpServers: session.setup.mcpServers, mcpServersDelivery: "initialize" as const }
      : {}),
    ...(session.setup.systemPrompt !== undefined
      ? { systemPrompt: session.setup.systemPrompt }
      : {}),
    ...callbacks,
    abortController: abort,
    includePartialMessages: true,
    // Claude Code leaves thinking's text out ("omitted") unless asked: every thought would reach the
    // conversation empty. The setting asks for the API's summaries and leaves the kind of thinking
    // (adaptive, a budget, none) to the model, as `thinking: { display }` would not.
    settings: {
      showThinkingSummaries: true,
      // Not asked for (yet): none is made. When asked for, the person's own settings.json may still say no.
      ...(session.suggestions ? {} : { promptSuggestionEnabled: false }),
      // The advisor tool, when one is chosen. None chosen sets nothing: what the person's settings.json says stands.
      ...(session.advisor !== undefined ? { advisorModel: session.advisor } : {}),
    },
    // A guess at what the person says next, after each turn (CYCL-225). Whether one is made is the flag above.
    promptSuggestions: true,
    // A sub-agent's row can say what it is doing, not only that it is busy. The SDK makes a
    // model call for each summary, so it is asked for only when the configuration says to.
    ...(config.progressSummaries === true ? { agentProgressSummaries: true } : {}),
    // A sub-agent's words, not only its tool calls: clients show its conversation (CYCL-134).
    forwardSubagentText: true,
    // The task list, which the plan is made of. Claude Code gives models newer than its own list none unless asked, and
    // naming these tools is the asking: it turns on TaskCreate/TaskGet/TaskUpdate/TaskList, not TodoWrite, and only
    // allows calls that change nothing outside the session. CLAUDE_CODE_ENABLE_TODO_TOOLS would do the same for the
    // whole process; this keeps it to the tools.
    allowedTools: TASK_TOOLS,
    permissionMode: session.mode,
    // The SDK's guard against starting in bypassPermissions by accident. Here the mode is only
    // ever the one a person chose, and without this a switch to it mid-session would be refused
    // and cost the process. The flag allows the mode; it does not turn it on.
    allowDangerouslySkipPermissions: true,
    ...(session.model !== undefined ? { model: session.model } : {}),
    ...(session.effort !== undefined ? { effort: session.effort } : {}),
    ...(config.claudeExecutable !== undefined
      ? { pathToClaudeCodeExecutable: config.claudeExecutable }
      : {}),
    ...(session.started ? { resume: session.id } : { sessionId: session.id }),
  };
  const query = runQuery({ prompt: input(), options });
  return {
    query,
    abort,
    push: (content, uuid, priority) => {
      queue.push({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        uuid,
        ...(priority !== undefined ? { priority } : {}),
      } as SDKUserMessage);
      wake?.();
    },
    end: () => {
      closed = true;
      wake?.();
    },
    idle: undefined,
    suggestions: session.suggestions,
  };
};

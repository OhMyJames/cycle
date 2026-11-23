import {
  type AgentContext,
  type AvailableCommand,
  agent,
  methods,
  type NewSessionRequest,
  RequestError,
  type ResumeSessionRequest,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import { approval } from "./approval.ts";
import { itemUpdate } from "./items.ts";
import { CODEX_NOTIFICATION_METHODS, CODEX_PROMPT_CAPABILITIES } from "./protocol.ts";
import { type AdapterConfig, AppServer, CodexRpcError } from "./server.ts";
import { type Catalog, type Mode, modes, options, policy, turnPolicy } from "./settings.ts";
import type {
  AgentMessageDeltaNotification,
  ItemCompletedNotification,
  PlanDeltaNotification,
  ThreadNameUpdatedNotification,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnError,
  TurnPlanUpdatedNotification,
  UserInput,
} from "./wire.generated.ts";

/** A failed turn's message; one Codex failed for want of a login says how to sign in. */
export function turnErrorMessage(error: TurnError | null | undefined): string | undefined {
  if (error?.codexErrorInfo === "unauthorized")
    return "Codex is not signed in. Run `cycle login codex` on the daemon's machine.";
  return error?.message;
}
type Turn = {
  id?: string;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  approvals: AbortController;
  streamed: Set<string>;
  tools: Set<string>;
  /** Compactions begun in this turn and not yet ended: one left open when the turn ends has failed. */
  compactions: Set<string>;
};
export function createAdapter(config: AdapterConfig) {
  // One daemon session owns this adapter and its process.
  let session: string | undefined,
    server: AppServer | undefined,
    owner: AgentContext | undefined,
    turn: Turn | undefined;
  let mode: Mode = "default";
  let catalog: Catalog = [];
  let model = "default";
  let effort = "default";
  /** What the thread was opened with: what "default" means, since a turn's choices stay for the turns after it. */
  let threadModel: string | undefined;
  let threadEffort: string | null = null;
  /** The collaboration mode last sent: plan stays until a turn says otherwise. */
  let sentPlan = false;
  /** Closed on purpose (session/close, the adapter's end): any other end of the app-server is its death. */
  let closing = false;
  let additionalDirectories: string[] = [];
  let developerInstructions: string | undefined;
  let mcpConfig: Record<string, unknown> = {};
  let trusted: boolean | undefined;
  let codexConfig: Record<string, unknown> = {};
  const children = new Set<string>();
  const childTurns = new Map<string, string>();
  /** Items of sub-agent threads that came as deltas, for when no turn of the parent's is running. */
  const childStreamed = new Set<string>();
  /** Sub-agents' approvals are not a turn's of the parent's: they end with the session. */
  let childApprovals = new AbortController();
  const planId = () => `${session ?? "codex"}-plan`;
  function notifyFor(sessionId: string, update: SessionUpdate) {
    if (owner)
      void owner.notify(methods.client.session.update, { sessionId, update }).catch(() => {});
  }
  function notify(update: SessionUpdate) {
    if (session) notifyFor(session, update);
  }
  /** A sub-agent's state, told in the parent's session: the daemon takes a child's state only from there. */
  function subagent(threadId: string, state: "running" | "idle") {
    notify({
      sessionUpdate: "subagent_update",
      sessionId: threadId,
      state: { sessionUpdate: "state_update", state },
    } as unknown as SessionUpdate);
  }
  function finish(stopReason: "end_turn" | "error" | "cancelled", message?: string) {
    if (!turn) return;
    turn.approvals.abort();
    clearTimeout(turn.timer);
    for (const compactionId of turn.compactions)
      notify({
        sessionUpdate: "compaction_update",
        compactionId,
        status: "failed",
      } as SessionUpdate);
    for (const toolCallId of turn.tools)
      notify({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: stopReason === "cancelled" ? "cancelled" : "failed",
      });
    turn = undefined;
    notify({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason,
      ...(stopReason === "error"
        ? { error: { code: -32603, message: message ?? "Codex turn failed" } }
        : {}),
    } as SessionUpdate);
  }
  function event(method: string, raw: unknown) {
    if (!(CODEX_NOTIFICATION_METHODS as readonly string[]).includes(method)) return;
    if (!raw || typeof raw !== "object" || !("threadId" in raw)) return;
    const threadId = typeof raw.threadId === "string" ? raw.threadId : undefined;
    if (!threadId || (threadId !== session && !children.has(threadId))) return;
    const child = threadId !== session;
    const send = (update: SessionUpdate) => notifyFor(threadId, update);
    // The session's title and context use are the thread's, not a turn's: they are told whenever they come.
    if (method === "thread/name/updated") {
      if (!child)
        notify({
          sessionUpdate: "session_info_update",
          title: (raw as ThreadNameUpdatedNotification).threadName ?? null,
        } as SessionUpdate);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = raw as ThreadTokenUsageUpdatedNotification;
      if (usage.tokenUsage.modelContextWindow !== null)
        send({
          sessionUpdate: "usage_update",
          used: usage.tokenUsage.last.totalTokens,
          size: usage.tokenUsage.modelContextWindow,
        } as SessionUpdate);
      return;
    }
    // A sub-agent's thread runs on its own turns, and may outlive the parent's: it is not held to one.
    const active = turn;
    if (!child && !active) return;
    if (!child && active && "turnId" in raw && active.id && raw.turnId !== active.id) return;
    const streamed = active?.streamed ?? childStreamed;
    // A turn this adapter did not start itself (a /compact) is known by its id from here on.
    if (method === "turn/started") {
      const started = (raw as { turn?: { id?: unknown } }).turn?.id;
      if (!child && active && active.id === undefined && typeof started === "string") {
        active.id = started;
        if (active.cancelled) interrupt(active);
      }
      return;
    }
    // A sub-agent's own turn, the one a cancel of its session interrupts.
    if (child && "turnId" in raw && typeof raw.turnId === "string")
      childTurns.set(threadId, raw.turnId);
    if (method === "turn/completed") {
      const result = (raw as TurnCompletedNotification).turn;
      if (child) {
        childTurns.delete(threadId);
        subagent(threadId, "idle");
        return;
      }
      if (active?.id && result.id !== active.id) return;
      finish(
        result.status === "interrupted"
          ? "cancelled"
          : result.status === "completed"
            ? "end_turn"
            : "error",
        turnErrorMessage(result.error),
      );
    } else if (method === "item/started" || method === "item/completed") {
      const { item } = raw as ItemCompletedNotification;
      const completedItem = method === "item/completed";
      if (item.type === "contextCompaction") {
        if (!child && active) {
          if (completedItem) active.compactions.delete(item.id);
          else active.compactions.add(item.id);
        }
        send({
          sessionUpdate: "compaction_update",
          compactionId: item.id,
          status: completedItem ? "completed" : "in_progress",
        } as SessionUpdate);
        return;
      }
      const update = itemUpdate(item, method === "item/completed", streamed.has(item.id), planId());
      if (!child && active && update?.sessionUpdate === "tool_call_update") {
        if (method === "item/started") active.tools.add(item.id);
        else active.tools.delete(item.id);
      }
      if (update) send(update);
      if (item.type === "collabAgentToolCall")
        for (const receiver of item.receiverThreadIds) {
          children.add(receiver);
          // The call ending is not the agent ending (a spawn ends once it is launched): its own state says.
          const status = item.agentsStates[receiver]?.status;
          const running =
            status === undefined
              ? !completedItem
              : status === "running" || status === "pendingInit";
          subagent(receiver, running ? "running" : "idle");
        }
    } else if (method === "turn/plan/updated") {
      const plan = raw as TurnPlanUpdatedNotification;
      send({
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: `${plan.threadId}-${plan.turnId}`,
          entries: plan.plan.map((item) => ({
            content: item.step,
            priority: "medium",
            status: item.status === "inProgress" ? "in_progress" : item.status,
          })),
        },
      } as unknown as SessionUpdate);
    } else if (method === "item/plan/delta") {
      const delta = raw as PlanDeltaNotification;
      send({
        sessionUpdate: "agent_message_chunk",
        messageId: delta.itemId,
        content: { type: "text", text: delta.delta },
      } as SessionUpdate);
    } else if (
      [
        "item/agentMessage/delta",
        "item/reasoning/textDelta",
        "item/reasoning/summaryTextDelta",
      ].includes(method)
    ) {
      const { itemId, delta } = raw as AgentMessageDeltaNotification;
      streamed.add(itemId);
      send({
        sessionUpdate:
          method === "item/agentMessage/delta" ? "agent_message_chunk" : "agent_thought_chunk",
        messageId: itemId,
        content: { type: "text", text: delta },
      } as SessionUpdate);
    }
  }
  function interrupt(active: Turn) {
    if (!active.id || !server) return;
    void server
      .request("turn/interrupt", { threadId: session, turnId: active.id })
      .catch((error) => {
        if (turn === active) server?.close(error);
      });
  }
  function requireSession(id: string) {
    if (id !== session || !server) throw new RequestError(-32002, "Codex session unavailable");
    return server;
  }
  const inputOf = (prompt: readonly unknown[]): UserInput[] =>
    prompt.map((raw) => {
      const block = (typeof raw === "object" && raw !== null ? raw : {}) as {
        type?: string;
        text?: string;
        mimeType?: string;
        data?: string;
        name?: string;
        uri?: string;
        resource?: { uri?: string; text?: string };
      };
      if (
        block.type === "image" &&
        typeof block.mimeType === "string" &&
        typeof block.data === "string"
      )
        return { type: "image", url: `data:${block.mimeType};base64,${block.data}` };
      if (
        block.type === "resource_link" &&
        typeof block.name === "string" &&
        typeof block.uri === "string"
      )
        return { type: "text", text: `${block.name}\n${block.uri}`, text_elements: [] };
      if (block.type === "resource" && typeof block.resource?.text === "string")
        return {
          type: "text",
          text: `${block.resource.uri ?? "resource"}\n${block.resource.text}`,
          text_elements: [],
        };
      if (block.type !== "text" || typeof block.text !== "string")
        throw new RequestError(
          -32602,
          "Codex takes text, images, embedded text and resource links only",
        );
      return { type: "text", text: block.text, text_elements: [] };
    });
  const optionsOf = () => options(mode, catalog, model, effort);
  /** The model and effort a turn runs with, always explicit: Codex keeps a turn's choice for the turns after it. */
  function resolved() {
    const chosenModel = model !== "default" ? model : threadModel;
    const chosenEffort =
      effort !== "default"
        ? effort
        : model === "default"
          ? threadEffort
          : (catalog.find((item) => item.model === model)?.defaultReasoningEffort ?? null);
    return { model: chosenModel, effort: chosenEffort };
  }
  function turnSettings() {
    const { model: chosenModel, effort: chosenEffort } = resolved();
    const plan = mode === "plan";
    // Into plan and out of it again: Codex needs the mode with its settings, which need a model.
    const collaborationMode =
      chosenModel !== undefined && (plan || sentPlan)
        ? {
            mode: plan ? "plan" : "default",
            settings: {
              model: chosenModel,
              reasoning_effort: chosenEffort,
              developer_instructions: null,
            },
          }
        : undefined;
    if (collaborationMode) sentPlan = plan;
    return {
      ...turnPolicy(mode, additionalDirectories),
      ...(chosenModel !== undefined ? { model: chosenModel } : {}),
      ...(chosenEffort !== null ? { effort: chosenEffort } : {}),
      ...(collaborationMode ? { collaborationMode } : {}),
    };
  }
  async function open(
    params: NewSessionRequest | ResumeSessionRequest,
    client: AgentContext,
    resume?: ResumeSessionRequest,
  ) {
    if (server) throw new RequestError(-32600, "This adapter already has a session");
    if (resume?.replayFrom) throw new RequestError(-32602, "Cycle owns the conversation replay");
    mode = "default";
    model = "default";
    effort = "default";
    sentPlan = false;
    closing = false;
    childApprovals = new AbortController();
    additionalDirectories = params.additionalDirectories ?? [];
    developerInstructions =
      params.systemPrompt?.mode === "append"
        ? (params.systemPrompt.content as Array<{ type: string; text?: string }>)
            .filter((item) => item.type === "text")
            .map((item) => item.text ?? "")
            .join("\n")
        : undefined;
    mcpConfig = Object.fromEntries(
      (params.mcpServers ?? []).map((server) => {
        if (server.type === "http")
          return [
            server.name,
            {
              url: server.url,
              http_headers: Object.fromEntries(
                ((server.headers ?? []) as unknown as { name: string; value: string }[]).map(
                  (header) => [header.name, header.value],
                ),
              ),
            },
          ];
        if (server.type === "stdio")
          return [
            server.name,
            {
              command: server.command,
              args: server.args ?? [],
              env: Object.fromEntries(
                ((server.env ?? []) as unknown as { name: string; value: string }[]).map(
                  (entry) => [entry.name, entry.value],
                ),
              ),
            },
          ];
        throw new RequestError(-32602, "Unsupported MCP transport");
      }),
    );
    trusted =
      typeof params._meta?.["cycle/trusted"] === "boolean"
        ? params._meta["cycle/trusted"]
        : undefined;
    codexConfig = {
      ...(Object.keys(mcpConfig).length > 0 ? { mcp_servers: mcpConfig } : {}),
      ...(trusted !== undefined
        ? { projects: { [params.cwd]: { trust_level: trusted ? "trusted" : "untrusted" } } }
        : {}),
    };
    const child = new AppServer(
      config,
      event,
      (error) => {
        finish(turn?.cancelled ? "cancelled" : "error", error.message);
        // The session cannot go on without it: the adapter ends too, so the daemon starts a new one and resumes.
        if (session !== undefined && !closing) config.onServerExit?.();
      },
      (method, raw) =>
        approval(
          method,
          raw,
          owner,
          session,
          turn?.id,
          children.has((raw as { threadId?: string } | undefined)?.threadId ?? "")
            ? childApprovals.signal
            : turn?.approvals.signal,
          (threadId) => children.has(threadId),
        ),
    );
    server = child;
    const settings = {
      cwd: params.cwd,
      ...policy(mode),
      ...(Object.keys(codexConfig).length > 0 ? { config: codexConfig } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
    };
    type Thread = { thread: { id: string }; model?: string; reasoningEffort?: string | null };
    try {
      await child.initialize();
      try {
        let cursor: string | null = null;
        do {
          const page: { data: Catalog[number][]; nextCursor: string | null } = await child.request(
            "model/list",
            { cursor, limit: 100 },
          );
          catalog = [...catalog, ...page.data];
          cursor = page.nextCursor;
        } while (cursor !== null);
      } catch {
        catalog = [];
      }
      let result: Thread;
      if (resume) {
        try {
          result = await child.request<Thread>("thread/resume", {
            ...settings,
            threadId: resume.sessionId,
            excludeTurns: true,
          });
        } catch (error) {
          if (
            resume._meta?.["cycle/hadTurn"] === true ||
            !(error instanceof CodexRpcError) ||
            error.code !== -32600 ||
            error.message !== `no rollout found for thread id ${resume.sessionId}`
          )
            throw error;
          result = await child.request<Thread>("thread/start", settings);
        }
      } else result = await child.request<Thread>("thread/start", settings);
      owner = client;
      session = result.thread.id;
      threadModel = result.model;
      threadEffort = result.reasoningEffort ?? null;
      if (resume)
        await client.notify(methods.client.session.update, {
          sessionId: session,
          update: { sessionUpdate: "state_update", state: "idle" },
        });
      return {
        sessionId: session,
        configOptions: optionsOf(),
        availableCommands: [
          {
            type: "command",
            name: "compact",
            description: "Compact the Codex conversation context.",
          },
        ] satisfies AvailableCommand[],
        ...(resume && session !== resume.sessionId
          ? { _meta: { "cycle/agentSessionId": session } }
          : {}),
      };
    } catch (error) {
      child.close();
      server = undefined;
      throw error;
    }
  }
  const app = agent({ name: "cycle-codex-adapter" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 2,
      info: { name: "cycle-codex-adapter", version: "0.0.0" },
      capabilities: {
        session: {
          prompt: CODEX_PROMPT_CAPABILITIES,
          mcp: { http: {}, stdio: {} },
          additionalDirectories: {},
          systemPrompt: {},
        },
      },
    }))
    .onRequest(methods.agent.session.new, ({ params, client }) => open(params, client))
    .onRequest(methods.agent.session.resume, ({ params, client }) => open(params, client, params))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      requireSession(params.sessionId);
      if (params.type !== "id") throw new RequestError(-32602, "Expected an option ID");
      if (params.configId === "mode") {
        const choice = modes.find((m) => m.value === params.value);
        if (!choice) throw new RequestError(-32602, "Unknown permission mode");
        mode = choice.value;
      } else if (params.configId === "model") {
        if (typeof params.value !== "string")
          throw new RequestError(-32602, "Expected a string value");
        if (params.value !== "default" && !catalog.some((item) => item.model === params.value))
          throw new RequestError(-32602, "Unknown Codex model");
        model = params.value;
        if (
          effort !== "default" &&
          !catalog
            .find((item) => item.model === model)
            ?.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)
        )
          effort = "default";
      } else if (params.configId === "effort") {
        if (typeof params.value !== "string")
          throw new RequestError(-32602, "Expected a string value");
        if (
          params.value !== "default" &&
          !catalog
            .find((item) => item.model === model)
            ?.supportedReasoningEfforts.some((item) => item.reasoningEffort === params.value)
        )
          throw new RequestError(-32602, "Unknown Codex reasoning effort");
        effort = params.value;
      } else throw new RequestError(-32602, "Unknown Codex setting");
      const configOptions = optionsOf();
      notify({ sessionUpdate: "config_option_update", configOptions });
      return { configOptions };
    })
    .onRequest(methods.agent.session.prompt, async ({ params }) => {
      const child = requireSession(params.sessionId);
      if (child.closed) throw new RequestError(-32600, "Codex app-server has exited");
      const compact =
        params._meta?.["cycle/steer"] !== true &&
        params.prompt.length === 1 &&
        params.prompt[0]?.type === "text" &&
        (params.prompt[0] as { text?: unknown }).text === "/compact";
      const input = compact ? [] : inputOf(params.prompt);
      if (params._meta?.["cycle/steer"] === true) {
        if (!turn?.id) throw new RequestError(-32600, "No Codex turn is running");
        const messageId = crypto.randomUUID();
        await child.request("turn/steer", {
          threadId: session,
          expectedTurnId: turn.id,
          clientUserMessageId: messageId,
          input,
        });
        notify({ sessionUpdate: "user_message", messageId, content: params.prompt });
        return { messageId };
      }
      if (turn) throw new RequestError(-32600, "A Codex turn is already running");
      const messageId = crypto.randomUUID();
      const active: Turn = {
        cancelled: false,
        approvals: new AbortController(),
        streamed: new Set(),
        tools: new Set(),
        compactions: new Set(),
      };
      turn = active;
      notify({ sessionUpdate: "user_message", messageId, content: params.prompt });
      notify({ sessionUpdate: "state_update", state: "running" });
      if (compact) {
        // Codex compacts in a turn of its own: its contextCompaction item and turn/completed end it like any other.
        void child.request("thread/compact/start", { threadId: session }).catch((error) => {
          if (turn === active) finish(active.cancelled ? "cancelled" : "error", String(error));
        });
        return { messageId };
      }
      void child
        .request<{ turn: { id: string } }>("turn/start", {
          threadId: session,
          input,
          ...turnSettings(),
        })
        .then(({ turn: started }) => {
          // turn/started may have said it first, and an early cancel has then been sent.
          if (turn !== active || active.id !== undefined) return;
          active.id = started.id;
          if (active.cancelled) interrupt(active);
        })
        .catch((error) => {
          if (turn === active) finish(active.cancelled ? "cancelled" : "error", String(error));
        });
      return { messageId };
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      if (children.has(params.sessionId)) {
        const childTurn = childTurns.get(params.sessionId);
        if (childTurn && server)
          void server
            .request("turn/interrupt", { threadId: params.sessionId, turnId: childTurn })
            .catch(() => {});
        return;
      }
      if (params.sessionId !== session || !turn || turn.cancelled) return;
      turn.cancelled = true;
      turn.approvals.abort();
      turn.timer = setTimeout(
        () => server?.close(new Error("Codex did not acknowledge cancellation")),
        4000,
      );
      interrupt(turn);
    })
    .onRequest(methods.agent.session.close, ({ params }) => {
      requireSession(params.sessionId);
      closing = true;
      childApprovals.abort();
      finish("cancelled");
      server?.close();
      server = undefined;
      session = undefined;
      return {};
    });
  return {
    app,
    close: () => {
      closing = true;
      childApprovals.abort();
      server?.close();
    },
  };
}

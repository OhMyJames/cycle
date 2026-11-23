import {
  type AgentContext,
  agent,
  methods,
  type NewSessionRequest,
  RequestError,
  type ResumeSessionRequest,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import { approval } from "./approval.ts";
import { itemUpdate } from "./items.ts";
import { type AdapterConfig, AppServer, CodexRpcError } from "./server.ts";
import { type Catalog, type Mode, modes, options, policy, turnPolicy } from "./settings.ts";
import type {
  AgentMessageDeltaNotification,
  ItemCompletedNotification,
  PlanDeltaNotification,
  ThreadNameUpdatedNotification,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnPlanUpdatedNotification,
  UserInput,
} from "./wire.generated.ts";

type Turn = {
  id?: string;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  approvals: AbortController;
  streamed: Set<string>;
  tools: Set<string>;
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
  let additionalDirectories: string[] = [];
  let developerInstructions: string | undefined;
  let mcpConfig: Record<string, unknown> = {};
  let trusted: boolean | undefined;
  let codexConfig: Record<string, unknown> = {};
  function notify(update: SessionUpdate) {
    if (session && owner)
      void owner
        .notify(methods.client.session.update, { sessionId: session, update })
        .catch(() => {});
  }
  function finish(stopReason: "end_turn" | "error" | "cancelled", message?: string) {
    if (!turn) return;
    turn.approvals.abort();
    clearTimeout(turn.timer);
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
    const active = turn;
    if (
      !active ||
      !raw ||
      typeof raw !== "object" ||
      !("threadId" in raw) ||
      raw.threadId !== session
    )
      return;
    if ("turnId" in raw && active.id && raw.turnId !== active.id) return;
    if (method === "turn/completed") {
      const result = (raw as TurnCompletedNotification).turn;
      if (active.id && result.id !== active.id) return;
      finish(
        result.status === "interrupted"
          ? "cancelled"
          : result.status === "completed"
            ? "end_turn"
            : "error",
        result.error?.message,
      );
    } else if (method === "item/started" || method === "item/completed") {
      const { item } = raw as ItemCompletedNotification;
      const update = itemUpdate(item, method === "item/completed", active.streamed.has(item.id));
      if (update?.sessionUpdate === "tool_call_update") {
        if (method === "item/started") active.tools.add(item.id);
        else active.tools.delete(item.id);
      }
      if (update) notify(update);
      if (item.type === "collabAgentToolCall" && item.receiverThreadIds[0])
        notify({
          sessionUpdate: "subagent_update",
          sessionId: item.receiverThreadIds[0],
          state: {
            sessionUpdate: "state_update",
            state: method === "item/completed" ? "idle" : "running",
          },
        } as unknown as SessionUpdate);
    } else if (method === "turn/plan/updated") {
      const plan = raw as TurnPlanUpdatedNotification;
      notify({
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: `${plan.threadId}-${plan.turnId}`,
          entries: plan.plan.map((item) => ({
            content: item.step,
            priority: "medium",
            status: item.status,
          })),
        },
      } as unknown as SessionUpdate);
    } else if (method === "item/plan/delta") {
      const delta = raw as PlanDeltaNotification;
      notify({
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
      active.streamed.add(itemId);
      notify({
        sessionUpdate:
          method === "item/agentMessage/delta" ? "agent_message_chunk" : "agent_thought_chunk",
        messageId: itemId,
        content: { type: "text", text: delta },
      } as SessionUpdate);
    } else if (method === "thread/name/updated") {
      const name = raw as ThreadNameUpdatedNotification;
      notify({
        sessionUpdate: "session_info_update",
        title: name.threadName ?? null,
      } as SessionUpdate);
    } else if (method === "thread/tokenUsage/updated") {
      const usage = raw as ThreadTokenUsageUpdatedNotification;
      if (usage.tokenUsage.modelContextWindow !== null)
        notify({
          sessionUpdate: "usage_update",
          used: usage.tokenUsage.last.totalTokens,
          size: usage.tokenUsage.modelContextWindow,
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
        resource?: { text?: string };
      };
      if (
        block.type === "image" &&
        typeof block.mimeType === "string" &&
        typeof block.data === "string"
      )
        return { type: "image", url: `data:${block.mimeType};base64,${block.data}` };
      if (block.type === "resource" && typeof block.resource?.text === "string")
        return { type: "text", text: block.resource.text, text_elements: [] };
      if (block.type !== "text" || typeof block.text !== "string")
        throw new RequestError(-32602, "Codex supports text, images and text resources only");
      return { type: "text", text: block.text, text_elements: [] };
    });
  const optionsOf = () => options(mode, catalog, model, effort);
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
      (error) => finish(turn?.cancelled ? "cancelled" : "error", error.message),
      (method, raw) => approval(method, raw, owner, session, turn?.id, turn?.approvals.signal),
    );
    server = child;
    const settings = {
      cwd: params.cwd,
      ...policy(mode),
      ...(Object.keys(codexConfig).length > 0 ? { config: codexConfig } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
    };
    type Thread = { thread: { id: string } };
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
        ] as never,
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
          prompt: { image: {}, embeddedContext: {} },
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
      if (
        params._meta?.["cycle/steer"] !== true &&
        params.prompt.length === 1 &&
        params.prompt[0]?.type === "text" &&
        (params.prompt[0] as { text?: unknown }).text === "/compact"
      ) {
        const compactionId = crypto.randomUUID();
        notify({
          sessionUpdate: "compaction_update",
          compactionId,
          status: "in_progress",
        } as SessionUpdate);
        await child.request("thread/compact/start", { threadId: session });
        notify({
          sessionUpdate: "compaction_update",
          compactionId,
          status: "completed",
        } as SessionUpdate);
        return { messageId: crypto.randomUUID() };
      }
      const input = inputOf(params.prompt);
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
      };
      turn = active;
      notify({ sessionUpdate: "user_message", messageId, content: params.prompt });
      notify({ sessionUpdate: "state_update", state: "running" });
      void child
        .request<{ turn: { id: string } }>("turn/start", {
          threadId: session,
          input,
          ...turnPolicy(mode, additionalDirectories),
          ...(developerInstructions ? { developerInstructions } : {}),
          ...(Object.keys(codexConfig).length > 0 ? { config: codexConfig } : {}),
          ...(model !== "default" ? { model } : {}),
          ...(effort !== "default" ? { effort } : {}),
        })
        .then(({ turn: started }) => {
          if (turn !== active) return;
          active.id = started.id;
          if (active.cancelled) interrupt(active);
        })
        .catch((error) => {
          if (turn === active) finish("error", String(error));
        });
      return { messageId };
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
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
      finish("cancelled");
      server?.close();
      server = undefined;
      session = undefined;
      return {};
    });
  return { app, close: () => server?.close() };
}

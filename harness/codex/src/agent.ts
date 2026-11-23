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
import { type Mode, modes, options, policy, turnPolicy } from "./settings.ts";
import type {
  AgentMessageDeltaNotification,
  ItemCompletedNotification,
  TurnCompletedNotification,
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
  async function open(
    params: NewSessionRequest | ResumeSessionRequest,
    client: AgentContext,
    resume?: ResumeSessionRequest,
  ) {
    if (server) throw new RequestError(-32600, "This adapter already has a session");
    if (resume?.replayFrom) throw new RequestError(-32602, "Cycle owns the conversation replay");
    mode = "default";
    const child = new AppServer(
      config,
      event,
      (error) => finish(turn?.cancelled ? "cancelled" : "error", error.message),
      (method, raw) => approval(method, raw, owner, session, turn?.id, turn?.approvals.signal),
    );
    server = child;
    const settings = { cwd: params.cwd, ...policy(mode) };
    type Thread = { thread: { id: string } };
    try {
      await child.initialize();
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
        configOptions: options(mode),
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
      capabilities: { session: { prompt: {} } },
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
      } else if (!(["model", "effort"].includes(params.configId) && params.value === "default"))
        throw new RequestError(-32602, "Unknown Codex setting");
      const configOptions = options(mode);
      notify({ sessionUpdate: "config_option_update", configOptions });
      return { configOptions };
    })
    .onRequest(methods.agent.session.prompt, ({ params }) => {
      const child = requireSession(params.sessionId);
      if (child.closed) throw new RequestError(-32600, "Codex app-server has exited");
      if (turn || params._meta?.["cycle/steer"])
        throw new RequestError(-32600, "Codex cannot accept an overlapping prompt");
      const input: UserInput[] = params.prompt.map((block) => {
        if (block.type !== "text" || typeof block.text !== "string")
          throw new RequestError(-32602, "Only text prompts are supported");
        return { type: "text", text: block.text, text_elements: [] };
      });
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
          ...turnPolicy(mode),
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

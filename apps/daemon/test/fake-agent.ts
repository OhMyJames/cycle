import { randomUUID } from "node:crypto";
import {
  type AgentConnection,
  agent,
  methods,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentDefinition } from "../src/index.ts";

type Script = {
  /** Called on `session/new` before creating the session (e.g. to reject with `-32000`). */
  onNew?: () => Promise<void>;
  /** Called when a prompt arrives: what the agent does with it. */
  onPrompt?: (ctx: Turn) => Promise<unknown>;
  /** How every turn ends. Default `end_turn`. */
  stopReason?: string;
};

export type Turn = {
  prompt: string;
  /** The blocks of the prompt, as the agent got them. */
  blocks: unknown[];
  /**
   * Asks the user for a form (`elicitation/create`); the answer is whatever the daemon says. Aborting `signal` takes
   * the request back (`$/cancel_request`).
   */
  elicit: (signal?: AbortSignal) => Promise<unknown>;
  /** Tells the daemon an update; `as` is the session it names, a sub-agent's it announced (ACP v2), or the session's own. */
  say: (update: object, as?: string) => Promise<void>;
  /** Asks the user for permission; `extra` is added to the request (a `toolCall`, say). */
  ask: (extra?: object) => Promise<unknown>;
  /** Resolves when a cancel has come in. */
  cancelled: Promise<void>;
};

/**
 * An ACP v2 agent in this process, which does what a test tells it to. It records how it was
 * called, and can be made to crash.
 */
export const fakeAgent = (
  script: Script = {},
  options: {
    promptCapabilities?: Record<string, unknown>;
    /**
     * What `session/new` answers with: the settings a new session starts with. A change answers
     * with the same set, the changed one's `currentValue` replaced.
     */
    configOptions?: { configId: string; currentValue: string }[];
    /** What `session/resume` answers with: the settings a resumed session is in. */
    resumeConfigOptions?: { configId: string; currentValue: string }[];
    /**
     * Says it can take a prompt into a running turn (`cycle/steer`). `take`: it does, while a turn
     * runs; `refuse`: it says it can, and refuses every one.
     */
    steer?: "take" | "refuse";
    /** The settings the agent says it has. */
    configSchema?: Record<string, unknown>;
    /** Says it reaches MCP servers over http (`capabilities.session.mcp.http`), so it is given connectors. */
    mcpHttp?: boolean;
    /** Emits a `config_option_update` notification inside `setConfigOption` (like Claude announcing model-dependent options). */
    emitConfigOnSet?: boolean;
  } = {},
) => {
  const log = {
    news: [] as Record<string, unknown>[],
    resumes: [] as Record<string, unknown>[],
    prompts: [] as string[],
    /** The `_meta` each prompt (not taken into a running turn) came with, in the order of `prompts`. */
    promptMetas: [] as (Record<string, unknown> | undefined)[],
    /** Prompts taken into a running turn. */
    steers: [] as string[],
    blocks: [] as unknown[][],
    cancels: 0,
    /** A cancel in a sub-agent's session (ACP v2 child, CYCL-143): its id. It is not the turn's. */
    childCancels: [] as string[],
    launches: 0,
    /** What each launch was given (`LaunchContext`), in order. */
    launchContexts: [] as unknown[],
    /** Launches asked for, including one still held. */
    launchRequests: 0,
    configs: [] as Record<string, unknown>[],
  };
  const connections: AgentConnection[] = [];
  /** What a test may switch: the next launch fails. */
  const control: {
    failLaunch: boolean;
    failInitialize: boolean;
    /** While set, a launch waits for it: the agent is slow to start. */
    holdLaunch: Promise<void> | undefined;
    /** Settings (by configId) the agent refuses to be set to anything: it no longer has them. */
    rejectConfig: Set<string>;
  } = { failLaunch: false, failInitialize: false, holdLaunch: undefined, rejectConfig: new Set() };
  const cancelResolvers: (() => void)[] = [];

  const build = () => {
    const sessions = new Set<string>();
    let running = 0;
    const app = agent({ name: "fake" })
      .onConnect((connection) => {
        connections.push(connection);
      })
      .onRequest(methods.agent.initialize, () => {
        if (control.failInitialize) throw new RequestError(-32603, "cannot initialize");
        return {
          protocolVersion: 2,
          info: { name: "fake", version: "0" },
          capabilities: options.mcpHttp === true ? { session: { mcp: { http: {} } } } : {},
        };
      })
      .onRequest(methods.agent.session.new, async ({ params }) => {
        log.news.push(params as unknown as Record<string, unknown>);
        if (script.onNew) {
          try {
            await script.onNew();
          } catch (error) {
            const code = (error as { code?: unknown })?.code;
            if (typeof code === "number") {
              throw new RequestError(code, error instanceof Error ? error.message : String(error));
            }
            throw error;
          }
        }
        const proposed = (params._meta as Record<string, unknown> | null)?.["cycle/sessionId"];
        const id = typeof proposed === "string" ? proposed : randomUUID();
        sessions.add(id);
        return { sessionId: id, configOptions: (options.configOptions ?? []) as never };
      })
      .onRequest(methods.agent.session.resume, async ({ params, client }) => {
        log.resumes.push(params as unknown as Record<string, unknown>);
        sessions.add(params.sessionId);
        // ACP v2: the state, before the answer.
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "state_update", state: "idle" } as SessionUpdate,
        });
        return options.resumeConfigOptions
          ? { configOptions: options.resumeConfigOptions as never }
          : {};
      })
      .onRequest(methods.agent.session.setConfigOption, async ({ params, client }) => {
        log.configs.push(params as unknown as Record<string, unknown>);
        if (control.rejectConfig.has(params.configId))
          throw new RequestError(-32602, "No such setting");
        const value = (params as { value?: unknown }).value;
        const nextOptions = (options.configOptions ?? []).map((o) =>
          o.configId === params.configId ? { ...o, currentValue: value } : o,
        );
        if (options.emitConfigOnSet) {
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "config_option_update",
              configOptions: nextOptions,
            } as SessionUpdate,
          });
        }
        return { configOptions: nextOptions as never };
      })
      .onNotification(methods.agent.session.cancel, ({ params }) => {
        if (params.sessionId.startsWith("task-")) {
          log.childCancels.push(params.sessionId);
          return;
        }
        log.cancels++;
        for (const resolve of cancelResolvers.splice(0)) resolve();
      })
      .onRequest(methods.agent.session.prompt, ({ params, client }) => {
        const sessionId = params.sessionId;
        const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
        if (
          (params._meta as Record<string, unknown> | null | undefined)?.["cycle/steer"] === true
        ) {
          if (options.steer !== "take" || running === 0) {
            throw new RequestError(-32600, "No turn is running to take it");
          }
          log.steers.push(text);
          const steered = randomUUID();
          void client
            .notify(methods.client.session.update, {
              sessionId,
              update: {
                sessionUpdate: "user_message",
                messageId: steered,
                content: params.prompt,
              } as SessionUpdate,
            })
            .catch(() => {});
          return { messageId: steered };
        }
        log.prompts.push(text);
        log.promptMetas.push(
          (params._meta as Record<string, unknown> | null | undefined) ?? undefined,
        );
        log.blocks.push(params.prompt as unknown[]);
        const messageId = randomUUID();
        const say = (update: object, as?: string) =>
          client.notify(methods.client.session.update, {
            sessionId: as ?? sessionId,
            update: update as SessionUpdate,
          });
        const cancelled = new Promise<void>((resolve) => cancelResolvers.push(resolve));
        const elicit = (signal?: AbortSignal) =>
          client.request(
            methods.client.elicitation.create,
            {
              sessionId,
              mode: "form",
              message: "Which one?",
              requestedSchema: { type: "object", properties: { pick: { type: "string" } } },
            } as never,
            signal ? { cancellationSignal: signal, stopWaitingOnCancel: true } : undefined,
          );
        const ask = (extra: object = {}) =>
          client.request(methods.client.session.requestPermission, {
            sessionId,
            ...extra,
            title: "Allow it?",
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ],
          } as never);
        void (async () => {
          await say({ sessionUpdate: "user_message", messageId, content: params.prompt });
          await say({ sessionUpdate: "state_update", state: "running" });
          running++;
          let ended = false;
          if (script.onPrompt) {
            ended =
              (await script.onPrompt({
                prompt: text,
                blocks: params.prompt,
                say,
                ask,
                elicit,
                cancelled,
              })) === "ended";
          } else {
            await say({
              sessionUpdate: "agent_message_chunk",
              messageId: "a1",
              content: { type: "text", text: `echo: ${text}` },
            });
          }
          running--;
          // A script that ended the turn itself (an error, say) is not given a second ending.
          if (!ended)
            await say({
              sessionUpdate: "state_update",
              state: "idle",
              stopReason: script.stopReason ?? "end_turn",
            });
        })().catch(() => {});
        return { messageId };
      });
    return app;
  };

  const definition: AgentDefinition = {
    id: "fake",
    name: "Fake",
    configSchema: options.configSchema ?? {
      type: "object",
      properties: { mode: { type: "string" } },
    },
    ...(options.promptCapabilities !== undefined
      ? { promptCapabilities: options.promptCapabilities }
      : {}),
    ...(options.steer !== undefined ? { steer: true } : {}),
    launch: async (context?: unknown) => {
      log.launchRequests++;
      log.launchContexts.push(context);
      await control.holdLaunch;
      if (control.failLaunch) throw new Error("The agent cannot start");
      log.launches++;
      return { target: build() };
    },
  };
  return { definition, log, control, crash: () => connections.at(-1)?.close() };
};

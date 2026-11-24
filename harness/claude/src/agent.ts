import { randomUUID } from "node:crypto";
import {
  agent as acpAgent,
  methods,
  RequestError,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import {
  configOptions,
  DEFAULT_PERMISSION_MODE,
  effortOptions,
  PERMISSION_MODES,
  type PermissionMode,
} from "./config-options.ts";
import { toSdkContent } from "./content.ts";
import { announceConfigOptions } from "./events.ts";
import { Lifecycle } from "./lifecycle.ts";
import { type AdapterConfig, newSession, newTurn, notify, type QueryFn } from "./session.ts";
import { NO_SETUP, setupOf } from "./setup.ts";

export {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_MODELS,
  CLAUDE_PERMISSION_MODES,
  DEFAULT_EFFORT_LEVEL,
  DEFAULT_PERMISSION_MODE,
  EFFORTS_META,
} from "./config-options.ts";
export type { AdapterConfig, QueryFn, SessionInfo } from "./session.ts";

/** What this agent takes in a prompt beyond text and links (decision 0010). */
export const CLAUDE_PROMPT_CAPABILITIES = { image: {}, embeddedContext: {} } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The key the daemon uses to propose the agent's own session id (docs/protocol.md §6). */
const PROPOSED_ID = "cycle/sessionId";
/** In `session/resume`: a turn of the session was answered, so Claude must have a record of it (`META.hadTurn`). */
const HAD_TURN = "cycle/hadTurn";
/** On `session/prompt`: put it into the turn that is running (`META.steer`, docs/protocol.md §8). */
const STEER = "cycle/steer";
/** On `session/prompt`: whether a suggestion of what to say next is wanted (`META.promptSuggestions`, §8). */
const PROMPT_SUGGESTIONS = "cycle/promptSuggestions";

const metaOf = (params: { _meta?: unknown }) =>
  params._meta as Record<string, unknown> | null | undefined;

/**
 * An ACP v2 agent over the Claude Agent SDK. This is the ACP side only: each request is read and answered here, and
 * what it asks of a session, its process and its turns is the `Lifecycle`'s (decision 0007).
 */
export const createAgent = (config: AdapterConfig, runQuery: QueryFn) => {
  const lifecycle = new Lifecycle(config, runQuery);
  const { sessions } = lifecycle;

  return acpAgent({ name: "cycle-claude-adapter" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      lifecycle.canElicit = params.capabilities?.elicitation?.form != null;
      return {
        protocolVersion: 2,
        info: { name: "cycle-claude-adapter", version: "0.0.0" },
        capabilities: {
          session: {
            prompt: CLAUDE_PROMPT_CAPABILITIES,
            mcp: { stdio: {}, http: {} },
            additionalDirectories: {},
            systemPrompt: {},
          },
        },
      };
    })
    .onRequest(methods.agent.session.new, ({ params, client }) => {
      const proposed = metaOf(params)?.[PROPOSED_ID];
      // Take the daemon's id when it is a UUID, which is all the SDK accepts; otherwise make one.
      const id = typeof proposed === "string" && UUID.test(proposed) ? proposed : randomUUID();
      const session = newSession({
        id,
        cwd: params.cwd,
        started: false,
        mode: DEFAULT_PERMISSION_MODE,
        setup: setupOf(params),
      });
      sessions.set(id, session);
      if (config.warmStart === true) {
        try {
          lifecycle.warmStart(client, session, config.maxWarm ?? 3);
        } catch {
          // A process that cannot start now is started, or fails, at the first prompt.
        }
      }
      return { sessionId: id, configOptions: configOptions(session, lifecycle.models) };
    })
    .onRequest(methods.agent.session.resume, async ({ params, client }) => {
      if (params.replayFrom !== undefined && params.replayFrom !== null) {
        // The daemon keeps the history. Replaying it here would put every record in the log twice.
        throw new RequestError(-32602, "This agent does not replay history", {
          replayFrom: params.replayFrom,
        });
      }
      const hadTurn = metaOf(params)?.[HAD_TURN] === true;
      // Looked at before the session is taken or made: nothing is awaited between the two.
      const started =
        sessions.has(params.sessionId) ||
        (await lifecycle.recordOf(params.sessionId, params.cwd, hadTurn));
      const session =
        sessions.get(params.sessionId) ??
        newSession({
          id: params.sessionId,
          cwd: params.cwd,
          // Whether Claude has this session on disk (see `recordOf`): it is resumed if so, and made if not.
          started,
          // Not the default for new sessions: a session with no mode on record was made before
          // that default was auto, and ran asking first. Resuming it must not loosen that.
          mode: "default",
          setup: NO_SETUP,
        });
      // What the daemon sends again on a resume is what the next process is started with.
      session.setup = setupOf(params);
      sessions.set(session.id, session);
      // ACP v2: a successful resume sends the current state before it answers.
      await notify(client, session.id, {
        sessionUpdate: "state_update",
        state: session.turn ? "running" : "idle",
      } as SessionUpdate);
      return { configOptions: configOptions(session, lifecycle.models) };
    })
    .onRequest(methods.agent.session.prompt, ({ params, client }) => {
      const session = lifecycle.require(params.sessionId);
      const running = session.turn;
      if (metaOf(params)?.[STEER] === true) {
        // Only into a turn that is going on, in a process that has it: anything else is the
        // daemon's to queue or send (docs/protocol.md §8).
        const live = session.live;
        // Not before the turn's own prompt is in the process, or Claude would read this one first.
        if (
          running === undefined ||
          running.done ||
          running.cancelled ||
          !running.pushed ||
          live === undefined
        ) {
          throw new RequestError(-32600, "No turn is running to take it", {
            sessionId: session.id,
          });
        }
        const content = toSdkContent(params.prompt);
        const messageId = randomUUID();
        running.steers.add(messageId);
        live.push(content, messageId, "next");
        void notify(client, session.id, {
          sessionUpdate: "user_message",
          messageId,
          content: params.prompt,
        } as SessionUpdate).catch(() => undefined);
        return { messageId };
      }
      if (running !== undefined) {
        throw new RequestError(-32600, "A turn is already running", { sessionId: session.id });
      }
      // Refused whole, before there is a turn: a block that cannot be carried is not dropped.
      const content = toSdkContent(params.prompt);
      lifecycle.wantSuggestions(session, metaOf(params)?.[PROMPT_SUGGESTIONS] === true);
      const messageId = randomUUID();
      // The turn exists from here, before anything is awaited: a cancel or a second prompt that
      // arrives while the first notifications are going out must find it.
      const turn = newTurn(session);
      session.turn = turn;
      // The turn goes on after this answers: ACP v2 ends a turn with an idle state_update.
      void (async () => {
        try {
          await notify(client, session.id, {
            sessionUpdate: "user_message",
            messageId,
            content: params.prompt,
          } as SessionUpdate);
          await notify(client, session.id, {
            sessionUpdate: "state_update",
            state: "running",
          } as SessionUpdate);
          await lifecycle.runTurn(client, session, turn, content, messageId);
        } catch {
          // The connection is gone: there is no one to tell.
        }
      })();
      return { messageId };
    })
    .onNotification(methods.agent.session.cancel, async ({ params, client }) => {
      // A sub-agent's session (ACP v2 child, CYCL-143): only that sub-agent stops; the turn and the session go on. Its
      // end is told as any other, by the SDK's `task_notification` (stopped → cancelled). A session's own id is always
      // its turn's cancel, even if a task were named the same: that one is not looked for among the sub-agents.
      for (const parent of sessions.has(params.sessionId) ? [] : sessions.values()) {
        if (!parent.subagents.running(params.sessionId)) continue;
        await parent.live?.query.stopTask(params.sessionId).catch(() => undefined);
        return;
      }
      const session = sessions.get(params.sessionId);
      if (session !== undefined) await lifecycle.cancel(client, session);
    })
    .onRequest(methods.agent.session.setConfigOption, ({ params, client }) => {
      const session = lifecycle.require(params.sessionId);
      const value = "value" in params ? params.value : undefined;
      let modelChanged = false;
      if (params.configId === "mode") {
        if (!PERMISSION_MODES.includes(value as PermissionMode)) {
          throw new RequestError(-32602, "Unknown permission mode", { value });
        }
        session.mode = value as PermissionMode;
        // What the process says about its mode before it has this one is old news: not a change.
        // A count, not a flag: with two changes in flight the first to finish is not the last.
        session.modeChanging++;
        lifecycle
          .apply(session, (query) => query.setPermissionMode(session.mode))
          .finally(() => {
            session.modeChanging--;
          });
      } else if (params.configId === "model" && typeof value === "string") {
        // "default" is no choice: Claude Code picks.
        session.model = value === "default" ? undefined : value;
        // Another model may have another window: none is known until it reports one.
        session.contextSize = undefined;
        modelChanged = true;
        const model = session.model;
        lifecycle.apply(session, (query) => query.setModel(model));
        lifecycle.reconcileEffort(session);
      } else if (params.configId === "effort") {
        const allowed = effortOptions(session, lifecycle.models);
        if (typeof value !== "string" || !allowed.some((option) => option.value === value)) {
          throw new RequestError(-32602, "Unknown effort level", { value });
        }
        session.effort = value === "default" ? undefined : (value as EffortLevel);
        lifecycle.applyEffort(session);
      } else {
        throw new RequestError(-32602, "Unknown configuration option", {
          configId: params.configId,
        });
      }
      const nextOptions = configOptions(session, lifecycle.models);
      if (modelChanged && lifecycle.models !== undefined) {
        void announceConfigOptions(client, session, lifecycle.models).catch(() => undefined);
      }
      return { configOptions: nextOptions };
    })
    .onRequest(methods.agent.session.close, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (session) lifecycle.close(session);
      return {};
    });
};

import {
  type ClientContext,
  client,
  methods,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import { META } from "@cycle/protocol";
import type { Daemon } from "../src/index.ts";

export const until = async (condition: () => boolean, what: string, ms = 2_000): Promise<void> => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

export type Seen = { update: SessionUpdate; seq: number | undefined; ts: string | undefined };

/** A client of the daemon, in this process, that writes down everything it is sent. */
export const connectClient = async (
  daemon: Daemon,
  options: {
    ackReturns?: boolean;
    onPermission?: (params: unknown) => "allow" | "deny" | "cancel" | "never";
    /** Declares that this client can answer forms, and how it does. */
    onElicitation?: (params: unknown) => Record<string, unknown> | "never";
  } = {},
) => {
  let agent: ClientContext | undefined;
  const seen: Seen[] = [];
  const permissions: unknown[] = [];
  const elicitations: unknown[] = [];
  const resolved: unknown[] = [];
  const planUsage: unknown[] = [];
  /** Every `_cycle/terminal/*` notification, in order, by its method's last part. */
  const terminal: { kind: "output" | "reset" | "changed"; params: Record<string, unknown> }[] = [];
  let listChanged = 0;
  let defaultsChanged = 0;
  let connectorsChanged = 0;
  /** The agent of every `_cycle/plugins_changed` this client was sent, in order. */
  const pluginsChanged: string[] = [];
  /** Every `_cycle/agent_setup_changed` this client was sent, in order. */
  const setupChanged: { agent: string; revision?: number }[] = [];
  const app = client({ name: "test-client" })
    .onConnect((connection) => {
      agent = connection.agent;
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      const meta = params._meta as Record<string, unknown> | null | undefined;
      const seq = meta?.[META.seq];
      const ts = meta?.[META.ts];
      seen.push({
        update: params.update,
        seq: typeof seq === "number" ? seq : undefined,
        ts: typeof ts === "string" ? ts : undefined,
      });
    })
    .onNotification(
      "_cycle/request_resolved",
      (p: unknown) => p as object,
      ({ params }) => {
        resolved.push(params);
      },
    )
    .onNotification(
      "_cycle/agent_defaults_changed",
      (p: unknown) => p as object,
      () => {
        defaultsChanged++;
      },
    )
    .onNotification(
      "_cycle/plan_usage_changed",
      (p: unknown) => p as object,
      ({ params }) => {
        planUsage.push(params);
      },
    )
    .onNotification(
      "_cycle/connectors_changed",
      (p: unknown) => p as object,
      () => {
        connectorsChanged++;
      },
    )
    .onNotification(
      "_cycle/plugins_changed",
      (p: unknown) => p as { agentId: string },
      ({ params }) => {
        pluginsChanged.push(params.agentId);
      },
    )
    .onNotification(
      "_cycle/agent_setup_changed",
      (p: unknown) => p as { agent: string; revision?: number },
      ({ params }) => {
        setupChanged.push(params);
      },
    )
    .onNotification(
      "_cycle/terminal/output",
      (p: unknown) => p as Record<string, unknown>,
      ({ params }) => {
        terminal.push({ kind: "output", params });
      },
    )
    .onNotification(
      "_cycle/terminal/reset",
      (p: unknown) => p as Record<string, unknown>,
      ({ params }) => {
        terminal.push({ kind: "reset", params });
      },
    )
    .onNotification(
      "_cycle/terminal/changed",
      (p: unknown) => p as Record<string, unknown>,
      ({ params }) => {
        terminal.push({ kind: "changed", params });
      },
    )
    .onNotification(
      "_cycle/session_list_changed",
      (p: unknown) => p as object,
      () => {
        listChanged++;
      },
    )
    .onRequest(methods.client.elicitation.create, async ({ params }) => {
      elicitations.push(params);
      const answer = options.onElicitation?.(params) ?? { action: "decline" };
      if (answer === "never") return new Promise<never>(() => {});
      return answer as never;
    })
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      permissions.push(params);
      const answer = options.onPermission?.(params) ?? "allow";
      if (answer === "never") return new Promise<never>(() => {});
      return answer === "cancel"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: answer } };
    });
  const handle = daemon.acceptApp(app);
  if (agent === undefined) throw new Error("the client was not connected");
  const api = agent;
  const init = await api.request(methods.agent.initialize, {
    protocolVersion: 2,
    info: { name: "test", version: "0" },
    _meta: { [META.ackReturns]: options.ackReturns === true },
    ...(options.onElicitation !== undefined ? { capabilities: { elicitation: { form: {} } } } : {}),
  } as never);
  return {
    agent: api,
    init,
    seen,
    permissions,
    elicitations,
    resolved,
    listChanged: () => listChanged,
    defaultsChanged: () => defaultsChanged,
    connectorsChanged: () => connectorsChanged,
    pluginsChanged,
    setupChanged,
    /** Every `_cycle/plan_usage_changed` this client was sent, in order. */
    planUsage,
    terminal,
    /** The output of one terminal this client was sent, joined. */
    terminalText: (terminalId: string) =>
      terminal
        .filter((t) => t.kind === "output" && t.params.terminalId === terminalId)
        .map((t) => t.params.data as string)
        .join(""),
    kinds: () => seen.map((s) => s.update.sessionUpdate),
    /** Turns that have ended: an idle that says why, as opposed to a state snapshot. */
    ended: () =>
      seen.filter((s) => {
        const u = s.update as { state?: string; stopReason?: string };
        return u.state === "idle" && u.stopReason !== undefined;
      }).length,
    idle: () => seen.filter((s) => (s.update as { state?: string }).state === "idle").length,
    close: () => handle.close(),
    closed: handle.closed,
  };
};

import {
  type ClientMessage,
  type Harness,
  type Methods,
  type MethodName,
  type ServerMessage,
  type SessionEvent,
  type SessionState,
  WS_PATH,
  initialSessionState,
  reduceSession,
} from "@cycle/protocol";

export const DAEMON_VERSION = "0.0.0";

export interface DaemonOptions {
  harness: Harness;
  port?: number;
  hostname?: string;
}

export interface Daemon {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

type Handlers = { [M in MethodName]: (params: Methods[M]["params"]) => Promise<Methods[M]["result"]> };

/**
 * The daemon owns agent sessions so they outlive any single UI window.
 * It exposes the `@cycle/protocol` wire API over a local WebSocket and
 * fans harness events out to every connected client.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { harness } = options;
  const sessions = new Map<string, SessionState>();
  const TOPIC = "events";

  await harness.start();

  const session = (id: string): SessionState => {
    const state = sessions.get(id);
    if (!state) throw new Error(`unknown session: ${id}`);
    return state;
  };

  const handlers: Handlers = {
    "daemon.info": async () => ({ version: DAEMON_VERSION, harness: harness.name }),
    "session.create": async (params) => {
      const info = await harness.createSession(params);
      sessions.set(info.id, initialSessionState(info));
      return info;
    },
    "session.list": async () => [...sessions.values()].map((s) => s.info),
    "session.get": async ({ sessionId }) => session(sessionId),
    "session.send": async ({ sessionId, text }) => {
      session(sessionId);
      return harness.sendMessage(sessionId, text);
    },
    "session.interrupt": async ({ sessionId }) => {
      session(sessionId);
      await harness.interrupt(sessionId);
      return {};
    },
    "approval.respond": async ({ approvalId, decision }) => {
      harness.respondApproval(approvalId, decision);
      return {};
    },
  };

  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    fetch(request, server) {
      const { pathname } = new URL(request.url);
      if (pathname === WS_PATH) {
        return server.upgrade(request) ? undefined : new Response("expected websocket", { status: 426 });
      }
      if (pathname === "/health") {
        return Response.json({ ok: true, version: DAEMON_VERSION, harness: harness.name });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe(TOPIC);
      },
      async message(ws, raw) {
        const reply = (message: ServerMessage) => ws.send(JSON.stringify(message));
        let message: ClientMessage;
        try {
          message = JSON.parse(String(raw));
        } catch {
          return;
        }
        const handler = handlers[message.method] as ((params: unknown) => Promise<unknown>) | undefined;
        if (!handler) {
          reply({ id: message.id, error: { message: `unknown method: ${message.method}` } });
          return;
        }
        try {
          reply({ id: message.id, result: await handler(message.params) });
        } catch (error) {
          reply({ id: message.id, error: { message: error instanceof Error ? error.message : String(error) } });
        }
      },
    },
  });

  const unsubscribe = harness.onEvent((event: SessionEvent) => {
    const state = sessions.get(event.sessionId);
    if (state) sessions.set(event.sessionId, reduceSession(state, event));
    server.publish(TOPIC, JSON.stringify({ event } satisfies ServerMessage));
  });

  const port = server.port!;
  return {
    port,
    url: `ws://127.0.0.1:${port}${WS_PATH}`,
    async stop() {
      unsubscribe();
      await server.stop(true);
      await harness.dispose();
    },
  };
}

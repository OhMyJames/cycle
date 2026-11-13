import { homedir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import {
  CLOSE_UNAUTHORIZED,
  type ClientMessage,
  type DaemonEvent,
  type EventFrame,
  type Harness,
  type MethodName,
  type Params,
  type Result,
  type ServerMessage,
  type Settings,
  WS_PATH,
} from "@cycle/protocol";
import { allowedRequest, newToken, sameToken } from "./auth.ts";
import { Files } from "./files.ts";
import { Git } from "./git.ts";
import { LaunchError, Scheduler, type SchedulesFile } from "./schedules.ts";
import { type MetaFile, SessionHub } from "./sessions.ts";
import { JsonStore, diskFile, realDelay } from "./store.ts";
import { Terminals } from "./terminals.ts";
import { type UsageFile, UsageLedger } from "./usage.ts";

export const DAEMON_VERSION = "0.1.0";

export interface DaemonOptions {
  harness: Harness;
  /** Where the daemon keeps its data: an absolute path. */
  home: string;
  port?: number;
  /** The connection token. A new one is made when not given. */
  token?: string;
  /** A built page to serve at `/`, so a browser can be the client. */
  uiDir?: string;
  /** Origins besides the daemon's own that may connect. */
  extraOrigins?: string[];
}

export interface Daemon {
  readonly port: number;
  readonly token: string;
  /** The WebSocket address, token included. */
  readonly url: string;
  /** The page's address, token included, when a page is served. */
  readonly pageUrl: string;
  stop(): Promise<void>;
}

interface Client {
  sessions: Set<string>;
  terminals: Set<string>;
}

type Socket = Bun.ServerWebSocket<Client>;
type Routes = {
  [M in MethodName]: (params: Params<M>, socket: Socket) => Promise<Result<M>> | Result<M>;
};

const DEFAULT_SETTINGS: Settings = {
  model: null,
  effort: null,
  mode: "auto",
  worktree: false,
  projects: [],
};
const MAX_PROJECTS = 30;
const SCHEDULE_TICK_MS = 15_000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function sessionTopic(sessionId: string): string {
  return `s:${sessionId}`;
}

function terminalTopic(id: string): string {
  return `t:${id}`;
}

/**
 * The daemon owns agent sessions so they outlive any single window. It
 * serves the `@cycle/protocol` wire API over a WebSocket on loopback, behind
 * a connection token, and sends each client only what it follows.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { harness, home } = options;
  const token = options.token ?? newToken();

  const [settings, meta, usageFile, schedulesFile] = await Promise.all([
    JsonStore.open<Settings>(diskFile(join(home, "settings.json")), { ...DEFAULT_SETTINGS }),
    JsonStore.open<MetaFile>(diskFile(join(home, "sessions.json")), { sessions: {} }),
    JsonStore.open<UsageFile>(diskFile(join(home, "usage.json")), { days: {} }),
    JsonStore.open<SchedulesFile>(diskFile(join(home, "schedules.json")), { schedules: [] }),
  ]);

  await harness.start();

  const viewers = new Map<string, number>();
  const push = (event: DaemonEvent) => {
    server.publish("all", JSON.stringify({ push: event } satisfies ServerMessage));
  };
  const usage = new UsageLedger(usageFile, Date.now);
  const git = new Git((argv, execOptions) => harness.exec(argv, execOptions));
  const hub = new SessionHub({
    harness,
    meta,
    settings: () => settings.value,
    usage,
    git,
    worktreeParent: join(home, "worktrees"),
    schedule: realDelay,
    now: Date.now,
    viewers: (sessionId) => viewers.get(sessionId) ?? 0,
    publish: {
      frame(frame: EventFrame) {
        server.publish(
          sessionTopic(frame.sessionId),
          JSON.stringify({ frame } satisfies ServerMessage),
        );
      },
      sessions: (sessions) => push({ type: "sessions.changed", sessions }),
      removed: (sessionIds) => push({ type: "sessions.removed", sessionIds }),
      usage: (day) => push({ type: "usage.today", day }),
    },
  });
  const terminals = new Terminals({
    harness,
    schedule: realDelay,
    shell: process.env["SHELL"] || "/bin/bash",
    env: { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Cycle" },
    publish: {
      output(id, data) {
        server.publish(
          terminalTopic(id),
          JSON.stringify({
            push: { type: "terminal.output", id, data: Buffer.from(data).toString("base64") },
          } satisfies ServerMessage),
        );
      },
      changed: (sessionId, list) => push({ type: "terminals.changed", sessionId, terminals: list }),
    },
  });
  const files = new Files(harness, () => [
    ...hub.folders(),
    ...settings.value.projects,
    join(home, "worktrees"),
  ]);

  const scheduler = new Scheduler({
    file: schedulesFile,
    isWorking: (sessionId) => hub.working(sessionId),
    now: Date.now,
    newId: () => crypto.randomUUID(),
    onChange: (schedules) => push({ type: "schedules.changed", schedules }),
    // A run starts as the composer would: a new session, then its first prompt.
    // An approval it asks for waits for the owner, as in any session.
    async launch(schedule) {
      const info = await hub.create(
        {
          cwd: schedule.cwd,
          ...(schedule.model ? { model: schedule.model } : {}),
          ...(schedule.effort ? { effort: schedule.effort } : {}),
          ...(schedule.mode ? { mode: schedule.mode } : {}),
          ...(schedule.worktree ? { worktree: {} } : {}),
        },
        schedule.id,
      );
      try {
        await hub.send(info.id, { text: schedule.prompt, images: [] }, "auto");
      } catch (error) {
        throw new LaunchError(error instanceof Error ? error.message : String(error), info.id);
      }
      return { sessionId: info.id };
    },
  });
  // Often enough that a run starts within the minute it is due.
  const ticking = setInterval(() => scheduler.tick(), SCHEDULE_TICK_MS);
  scheduler.tick();

  /** Tells every client the servers changed, however they came to. */
  const mcpChanged = async () => {
    const servers = await harness.listMcpServers();
    push({ type: "mcp.changed", servers });
    return { servers };
  };
  const pluginsChanged = async () => {
    const catalog = await harness.listPlugins();
    push({ type: "plugins.changed", catalog });
    // A plugin may bring servers of its own.
    void mcpChanged().catch(() => {});
    return catalog;
  };
  harness.onEvent((event) => {
    if (event.type === "mcp.changed") void mcpChanged().catch(() => {});
  });

  const follow = (socket: Socket, sessionId: string) => {
    if (socket.data.sessions.has(sessionId)) return;
    socket.data.sessions.add(sessionId);
    socket.subscribe(sessionTopic(sessionId));
    viewers.set(sessionId, (viewers.get(sessionId) ?? 0) + 1);
  };
  const unfollow = (socket: Socket, sessionId: string) => {
    if (!socket.data.sessions.delete(sessionId)) return;
    socket.unsubscribe(sessionTopic(sessionId));
    const left = (viewers.get(sessionId) ?? 1) - 1;
    if (left > 0) viewers.set(sessionId, left);
    else viewers.delete(sessionId);
  };
  const setSettings = (change: (value: Settings) => void) => {
    settings.update(change);
    push({ type: "settings.changed", settings: settings.value });
  };
  const useProject = (path: string) => {
    if (settings.value.projects[0] === path) return;
    setSettings((value) => {
      value.projects = [path, ...value.projects.filter((other) => other !== path)].slice(
        0,
        MAX_PROJECTS,
      );
    });
  };

  const routes: Routes = {
    "daemon.info": () => ({
      version: DAEMON_VERSION,
      harness: harness.name,
      home,
      platform: process.platform,
      userHome: homedir(),
    }),

    "session.list": async ({ archived }) => ({ sessions: await hub.list(archived) }),
    "session.create": async (params) => {
      const info = await hub.create(params);
      useProject(info.worktree?.repo ?? params.cwd);
      return info;
    },
    "session.open": async ({ sessionId, after }, socket) => {
      const answer = await hub.open(sessionId, after);
      // From here to the reply nothing waits, so no frame can slip between them.
      follow(socket, sessionId);
      hub.markRead(sessionId);
      return answer;
    },
    "session.close": ({ sessionId }, socket) => {
      unfollow(socket, sessionId);
      return {};
    },
    "session.send": ({ sessionId, text, images, delivery }) =>
      hub.send(sessionId, { text, images: images ?? [] }, delivery ?? "auto"),
    "session.unqueue": ({ sessionId, id }) => {
      hub.unqueue(sessionId, id);
      return {};
    },
    "session.interrupt": async ({ sessionId }) => {
      await hub.interrupt(sessionId);
      return {};
    },
    "session.update": async (params) => {
      const info = await hub.update(params);
      if (params.archived) terminals.closeSession(params.sessionId);
      return info;
    },
    "session.delete": async ({ sessionId, removeWorktree }) => {
      await hub.remove(sessionId, removeWorktree ?? false);
      terminals.closeSession(sessionId);
      return {};
    },
    "session.fork": ({ sessionId, turnId }) => hub.fork(sessionId, turnId ?? null),
    "session.compact": async ({ sessionId }) => {
      await hub.compact(sessionId);
      return {};
    },
    "approval.respond": ({ approvalId, response }) => {
      hub.respondApproval(approvalId, response);
      return {};
    },

    "models.list": async () => ({ models: await harness.listModels() }),
    "skills.list": async ({ cwd }) => ({ skills: await harness.listSkills(cwd) }),
    "mcp.list": async () => ({ servers: await harness.listMcpServers() }),
    "mcp.put": async ({ server }) => {
      await harness.putMcpServer(server);
      return mcpChanged();
    },
    "mcp.remove": async ({ name }) => {
      await harness.removeMcpServer(name);
      return mcpChanged();
    },
    "mcp.enable": async ({ name, enabled }) => {
      await harness.enableMcpServer(name, enabled);
      return mcpChanged();
    },
    "mcp.login": ({ name }) => harness.loginMcpServer(name),
    "plugins.list": () => harness.listPlugins(),
    "plugins.read": ({ marketplace, name }) => harness.readPlugin(marketplace, name),
    "plugins.install": async ({ marketplace, name }) => {
      await harness.installPlugin(marketplace, name);
      return pluginsChanged();
    },
    "plugins.uninstall": async ({ id }) => {
      await harness.uninstallPlugin(id);
      return pluginsChanged();
    },
    "plugins.enable": async ({ id, enabled }) => {
      await harness.enablePlugin(id, enabled);
      return pluginsChanged();
    },
    "marketplace.add": async ({ source }) => {
      await harness.addMarketplace(source);
      return pluginsChanged();
    },
    "marketplace.remove": async ({ name }) => {
      await harness.removeMarketplace(name);
      return pluginsChanged();
    },

    "schedule.list": () => ({ schedules: scheduler.list() }),
    "schedule.put": (input) => {
      const schedule = scheduler.put(input);
      useProject(schedule.cwd);
      return schedule;
    },
    "schedule.delete": ({ id }) => {
      scheduler.remove(id);
      return {};
    },
    "schedule.run": ({ id }) => scheduler.run(id),
    "account.read": () => harness.readAccount(),
    "settings.get": () => settings.value,
    "settings.set": (patch) => {
      setSettings((value) => {
        if (patch.model !== undefined) value.model = patch.model;
        if (patch.effort !== undefined) value.effort = patch.effort;
        if (patch.mode !== undefined) value.mode = patch.mode;
        if (patch.worktree !== undefined) value.worktree = patch.worktree;
        if (patch.projects !== undefined) value.projects = patch.projects.slice(0, MAX_PROJECTS);
      });
      return settings.value;
    },
    "usage.daily": () => ({ days: usage.days() }),

    "files.list": async ({ path }) => ({ entries: await files.list(path) }),
    "files.read": ({ path }) => files.read(path),
    "files.search": async ({ root, query }) => ({ files: await files.search(root, query) }),

    "git.status": ({ cwd, base }) => git.status(cwd, base),
    "git.diff": ({ cwd, from, path, status }) => git.diff(cwd, from, path, status),
    "git.branches": ({ cwd }) => git.branches(cwd),
    "git.checkout": async ({ cwd, branch }) => {
      if (hub.busyIn(cwd)) throw new Error("A session is working in this checkout. Stop it first.");
      await git.checkout(cwd, branch);
      return {};
    },
    "git.commit": async ({ cwd, message }) => ({ commit: await git.commit(cwd, message) }),

    "terminal.list": ({ sessionId }) => ({ terminals: terminals.list(sessionId) }),
    "terminal.create": ({ sessionId, cwd, cols, rows }) =>
      terminals.create(sessionId, cwd, cols, rows),
    "terminal.attach": ({ id }, socket) => {
      const { terminal, data } = terminals.snapshot(id);
      socket.data.terminals.add(id);
      socket.subscribe(terminalTopic(id));
      return { terminal, data: Buffer.from(data).toString("base64") };
    },
    "terminal.detach": ({ id }, socket) => {
      socket.data.terminals.delete(id);
      socket.unsubscribe(terminalTopic(id));
      return {};
    },
    "terminal.write": ({ id, data }) => {
      terminals.write(id, new TextEncoder().encode(data));
      return {};
    },
    "terminal.resize": ({ id, cols, rows }) => {
      terminals.resize(id, cols, rows);
      return {};
    },
    "terminal.close": ({ id }) => {
      terminals.close(id);
      return {};
    },
  };

  const uiRoot = options.uiDir ? normalize(options.uiDir) : null;
  const serveUi = async (pathname: string): Promise<Response> => {
    if (!uiRoot) return new Response("not found", { status: 404 });
    const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
    const path = normalize(join(uiRoot, relative));
    if (path !== uiRoot && !path.startsWith(uiRoot + sep)) {
      return new Response("not found", { status: 404 });
    }
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, {
      headers: {
        "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
        "cache-control": relative === "index.html" ? "no-cache" : "public, max-age=31536000",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        // The page talks to this daemon and nothing else.
        "content-security-policy":
          "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; " +
          "img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
      },
    });
  };

  const server = Bun.serve<Client>({
    port: options.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(request, bunServer) {
      const url = new URL(request.url);
      const local = allowedRequest(
        { host: request.headers.get("host"), origin: request.headers.get("origin") },
        bunServer.port ?? 0,
        options.extraOrigins,
      );
      if (!local) return new Response("forbidden", { status: 403 });
      if (url.pathname === WS_PATH) {
        if (!sameToken(url.searchParams.get("token"), token)) {
          return new Response("unauthorized", { status: 401 });
        }
        const data: Client = { sessions: new Set(), terminals: new Set() };
        return bunServer.upgrade(request, { data })
          ? undefined
          : new Response("expected websocket", { status: 426 });
      }
      if (url.pathname === "/health") {
        return Response.json({ ok: true, version: DAEMON_VERSION, harness: harness.name });
      }
      return serveUi(url.pathname);
    },
    websocket: {
      maxPayloadLength: 48 * 1024 * 1024,
      // A client too slow to keep up is dropped, and catches up when it returns.
      backpressureLimit: 32 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(socket) {
        socket.subscribe("all");
        socket.send(JSON.stringify({ push: { type: "usage.today", day: usage.today() } }));
      },
      close(socket) {
        for (const sessionId of socket.data.sessions) unfollow(socket, sessionId);
      },
      async message(socket, raw) {
        let request: ClientMessage;
        try {
          request = JSON.parse(String(raw)) as ClientMessage;
        } catch {
          socket.close(CLOSE_UNAUTHORIZED, "not json");
          return;
        }
        const reply = (answer: ServerMessage) => socket.send(JSON.stringify(answer));
        const route = routes[request.method] as
          | ((params: unknown, socket: Socket) => unknown)
          | undefined;
        if (!route) {
          reply({
            id: request.id,
            error: { message: `unknown method: ${String(request.method)}` },
          });
          return;
        }
        try {
          reply({ id: request.id, result: await route(request.params ?? {}, socket) });
        } catch (error) {
          reply({
            id: request.id,
            error: { message: error instanceof Error ? error.message : String(error) },
          });
        }
      },
    },
  });

  const port = server.port ?? 0;
  return {
    port,
    token,
    url: `ws://127.0.0.1:${port}${WS_PATH}?token=${token}`,
    pageUrl: `http://127.0.0.1:${port}/#token=${token}`,
    async stop() {
      clearInterval(ticking);
      terminals.closeAll();
      await server.stop(true);
      await harness.dispose();
      await Promise.all([settings.flush(), meta.flush(), usageFile.flush(), schedulesFile.flush()]);
    },
  };
}

import { homedir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import {
  CLOSE_UNAUTHORIZED,
  type ClientMessage,
  type DaemonEvent,
  type Agents,
  type EventFrame,
  type MethodName,
  type ModelProvider,
  type Params,
  type Result,
  type ServerMessage,
  type PermissionMode,
  type Settings,
  type WorktreePort,
  WS_PATH,
  legacyMode,
  resolveMode,
} from "@cycle/protocol";
import { allowedRequest, newToken, sameToken } from "./auth.ts";
import { Files } from "./files.ts";
import { Git } from "./git.ts";
import { NotSupported } from "./harnesses.ts";
import { Providers, type ProvidersFile } from "./providers.ts";
import {
  type SandboxAdmin,
  SandboxEnvironments,
  SandboxError,
  type SandboxesFile,
  environmentOfSandbox,
  sandboxBook,
} from "./sandboxes.ts";
import {
  LaunchError,
  Scheduler,
  type SchedulesFile,
  runAgentProblem,
  scheduleMode,
} from "./schedules.ts";
import { type MetaFile, SessionHub } from "./sessions.ts";
import { JsonStore, diskFile, realDelay } from "./store.ts";
import { Terminals } from "./terminals.ts";
import type { SessionSource } from "./tools.ts";
import { type UsageFile, UsageLedger } from "./usage.ts";
import { Worktrees } from "./worktrees.ts";

export const DAEMON_VERSION = "0.1.0";

export interface DaemonOptions {
  harness: Agents;
  /** The owner's model providers, opened before the harness that offers their models. */
  providers: JsonStore<ProvidersFile>;
  /**
   * The owner's sandbox environments, opened before the harness that makes sandboxes of them, and
   * the sandboxes themselves. Left out, no session runs in one.
   */
  sandboxes?: { store: JsonStore<SandboxesFile>; admin: SandboxAdmin };
  /** Where the daemon keeps its data: an absolute path. */
  home: string;
  port?: number;
  /** The connection token. A new one is made when not given. */
  token?: string;
  /** A built page to serve at `/`, so a browser can be the client. */
  uiDir?: string;
  /** Origins besides the daemon's own that may connect. */
  extraOrigins?: string[];
  /** Cycle's own tools for agents, which read the sessions once there is a hub. */
  tools?: { serve(source: SessionSource): void };
  /** The worktrees Claude Code's agent enters, which the hub makes once there is one. */
  worktrees?: { serve(source: WorktreePort): void };
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
  modes: {},
  worktree: false,
  projects: [],
};

/** Settings as kept. `mode` is what every agent's new sessions started in, before each had its own. */
type StoredSettings = Settings & { mode?: string };
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
function known(hub: SessionHub, sessionId: string): boolean {
  try {
    hub.info(sessionId);
    return true;
  } catch {
    return false;
  }
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { harness, home } = options;
  const token = options.token ?? newToken();

  const [settings, meta, usageFile, schedulesFile] = await Promise.all([
    JsonStore.open<StoredSettings>(diskFile(join(home, "settings.json")), {
      ...DEFAULT_SETTINGS,
    }),
    JsonStore.open<MetaFile>(diskFile(join(home, "sessions.json")), {
      sessions: {},
    }),
    JsonStore.open<UsageFile>(diskFile(join(home, "usage.json")), { days: {} }),
    JsonStore.open<SchedulesFile>(diskFile(join(home, "schedules.json")), {
      schedules: [],
    }),
  ]);

  await harness.start();

  /**
   * What new sessions start in on each agent: the owner's choice for it, else what they chose for
   * every agent before each had modes of its own, else the agent's default.
   */
  const newModes = (): Record<string, PermissionMode> => {
    const { modes, mode } = settings.value;
    const all = harness.listModes();
    const out: Record<string, PermissionMode> = {};
    for (const agent of new Set(all.map((each) => each.harness))) {
      const own = all.filter((each) => each.harness === agent);
      const chosen = resolveMode(own, modes[agent] ?? (mode ? legacyMode(mode) : undefined));
      if (chosen) out[agent] = chosen.id;
    }
    return out;
  };
  /** Settings as the clients and the sessions read them, worked out again when they change. */
  const view = (): Settings => {
    const { mode: _, ...rest } = settings.value;
    return { ...rest, modes: newModes() };
  };
  let settingsView = view();

  const viewers = new Map<string, number>();
  const push = (event: DaemonEvent) => {
    server.publish("all", JSON.stringify({ push: event } satisfies ServerMessage));
  };
  // The models on offer follow the owner's providers and the account codex is signed in to.
  const pushModels = () => {
    harness.listModels().then(
      (models) => push({ type: "models.changed", models }),
      () => {},
    );
    harness.options().then(
      (agents) => {
        for (const { agent, options: list } of agents) {
          push({ type: "options.changed", agent, options: list });
        }
      },
      () => {},
    );
  };
  const providers = new Providers(options.providers, (list: ModelProvider[]) => {
    push({ type: "providers.changed", providers: list });
    // A provider's model has its provider's id before a slash. One that is gone is no default.
    const chosen = settings.value.model;
    if (chosen?.includes("/") && !providers.models().some((model) => model.id === chosen)) {
      setSettings((value) => {
        value.model = null;
        value.effort = null;
      });
    }
    pushModels();
  });
  const environments = options.sandboxes
    ? new SandboxEnvironments(options.sandboxes.store, (list) =>
        push({ type: "sandboxes.changed", environments: list }),
      )
    : null;
  const sandboxAdmin = options.sandboxes?.admin ?? null;
  const sandboxes = () => {
    if (!environments || !sandboxAdmin) throw new SandboxError("Sandboxes are not set up here.");
    return { environments, admin: sandboxAdmin };
  };
  // Limits move with every turn, of every session: one read at a time for each agent, and one more
  // if they moved again while it ran.
  const limits = new Map<string, "reading" | "again">();
  const readLimits = (name: string) => {
    if (limits.has(name)) {
      limits.set(name, "again");
      return;
    }
    limits.set(name, "reading");
    harness
      .account(name)
      .readAccount()
      .then(
        (account) => push({ type: "limits.changed", account }),
        () => {},
      )
      .finally(() => {
        const more = limits.get(name) === "again";
        limits.delete(name);
        if (more) readLimits(name);
      });
  };
  harness.onEvent((event) => {
    if (event.type === "limits.changed") readLimits(event.harness);
    if (event.type === "commands.changed") {
      push({ type: "commands.changed", sessionId: event.sessionId, commands: event.commands });
    }
    // shortcut: a page opened after the suggestion came does not see it; upgrade when owners
    // reopen sessions often enough to miss it.
    if (event.type === "suggestion.changed") {
      push({
        type: "suggestion.changed",
        sessionId: event.sessionId,
        suggestion: event.suggestion,
      });
    }
    if (event.type !== "account.changed") return;
    const { error } = event;
    harness
      .account(event.harness)
      .readAccount()
      .then(
        (account) => push({ type: "account.changed", account, error }),
        () => {},
      );
    pushModels();
  });
  const usage = new UsageLedger(usageFile, Date.now);
  const git = new Git((argv, execOptions) => harness.exec(argv, execOptions));
  const sandboxStore = options.sandboxes?.store;
  const hub = new SessionHub({
    harness,
    meta,
    settings: () => settingsView,
    usage,
    git,
    legacyWorktrees: join(home, "worktrees"),
    ...(sandboxStore
      ? {
          environmentOfSandbox: (name: string, cwd: string) =>
            environmentOfSandbox(
              name,
              cwd,
              sandboxBook(sandboxStore),
              sandboxStore.value.environments.map((one) => one.id),
            ),
        }
      : {}),
    schedule: realDelay,
    now: Date.now,
    log: (line) => console.error(`[cycle] ${line}`),
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
  // Before anything runs: an agent may ask for a worktree with its first turn.
  options.worktrees?.serve({
    enter: ({ sessionId, name, helper }) => hub.enterWorktree(sessionId, { name, helper }),
    leave: ({ sessionId, path, helper }) => hub.leaveWorktree(sessionId, { path, helper }),
  });
  const worktrees = new Worktrees({
    git,
    users: (path) => hub.worktreeUsers(path),
    legacyWorktrees: join(home, "worktrees"),
  });
  const terminals = new Terminals({
    harness,
    schedule: realDelay,
    shell: process.env["SHELL"] || "/bin/bash",
    env: {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "Cycle",
    },
    publish: {
      output(id, data) {
        server.publish(
          terminalTopic(id),
          JSON.stringify({
            push: {
              type: "terminal.output",
              id,
              data: Buffer.from(data).toString("base64"),
            },
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
    modes: () => harness.listModes(),
    // A run starts as the composer would: a new session, then its first prompt.
    // An approval or a question it asks waits for the owner, as in any session.
    async launch(schedule) {
      const mode = scheduleMode(schedule);
      // One id can be two agents' modes, which let through different things: a run starts only on
      // the agent its mode is of.
      const agent = await hub.agentFor(schedule.model ?? settingsView.model ?? undefined);
      const problem = runAgentProblem(schedule, agent);
      if (problem) throw new Error(problem);
      const info = await hub.create(
        {
          cwd: schedule.cwd,
          ...(schedule.model ? { model: schedule.model } : {}),
          ...(schedule.effort ? { effort: schedule.effort } : {}),
          ...(mode ? { mode } : {}),
          ...(schedule.worktree ? { worktree: {} } : {}),
        },
        schedule.id,
      );
      try {
        await hub.send(info.id, { text: schedule.prompt, images: [] }, "auto", {
          kind: "schedule",
          scheduleId: schedule.id,
        });
      } catch (error) {
        throw new LaunchError(error instanceof Error ? error.message : String(error), info.id);
      }
      return { sessionId: info.id };
    },
  });
  /**
   * Tells every client the servers changed, however they came to. Only the
   * newest listing is pushed, so answers that come back out of order leave
   * the pages with the latest.
   */
  const mcpListing = new Map<string, number>();
  const mcpChanged = async (name = harness.name) => {
    const listing = (mcpListing.get(name) ?? 0) + 1;
    mcpListing.set(name, listing);
    const servers = await harness.connector(name).listMcpServers();
    if (listing === mcpListing.get(name)) push({ type: "mcp.changed", harness: name, servers });
    return { servers };
  };
  /** A change to the configuration, told to the pages whether or not it went through whole. */
  const mcpChange = async (name: string | undefined, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      // What an agent refuses changed nothing.
      if (!(error instanceof NotSupported)) void mcpChanged(name).catch(() => {});
      throw error;
    }
    return mcpChanged(name);
  };
  const pluginsChanged = async (name = harness.name) => {
    const catalog = await harness.connector(name).listPlugins();
    push({ type: "plugins.changed", harness: name, catalog });
    // A plugin may bring servers of its own.
    void mcpChanged(name).catch(() => {});
    return catalog;
  };
  const pluginChange = async (name: string | undefined, work: () => Promise<void>) => {
    await work();
    return pluginsChanged(name);
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
    settingsView = view();
    push({ type: "settings.changed", settings: settingsView });
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
      harnesses: harness.harnesses(),
      home,
      platform: process.platform,
      userHome: homedir(),
    }),

    "session.list": async ({ archived }) => ({
      sessions: await hub.list(archived),
    }),
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
    "session.send": ({ sessionId, text, images, documents, delivery }) =>
      hub.send(
        sessionId,
        { text, images: images ?? [], ...(documents?.length ? { documents } : {}) },
        delivery ?? "auto",
      ),
    "session.unqueue": ({ sessionId, id }) => {
      hub.unqueue(sessionId, id);
      return {};
    },
    "session.interrupt": async ({ sessionId }) => {
      await hub.interrupt(sessionId);
      return {};
    },
    "session.stopTask": async ({ sessionId, taskId }) => {
      await hub.stopTask(sessionId, taskId);
      return {};
    },
    "session.update": async (params) => {
      const info = await hub.update(params);
      if (params.archived) terminals.closeSession(params.sessionId);
      return info;
    },
    "session.delete": async ({ sessionId, removeWorktree }) => {
      try {
        await hub.remove(sessionId, removeWorktree ?? false);
      } finally {
        // Closed once the session is gone, also when its worktree could not be removed; a refused
        // delete changed nothing, so its terminals stay.
        if (!hub.has(sessionId)) terminals.closeSession(sessionId);
      }
      return {};
    },
    "session.fork": ({ sessionId, turnId }) => hub.fork(sessionId, turnId ?? null),
    "session.compact": async ({ sessionId }) => {
      await hub.compact(sessionId);
      return {};
    },
    "session.review": async ({ sessionId, target }) => {
      await hub.review(sessionId, target);
      return {};
    },
    "session.rewind": async ({ sessionId, turnId, files: withFiles }) => {
      await hub.rewind(sessionId, turnId, withFiles ?? false);
      return {};
    },
    "session.rewind.preview": ({ sessionId, turnId }) => hub.previewRewind(sessionId, turnId),
    "session.context": async ({ sessionId }) => ({ context: await hub.context(sessionId) }),
    "commands.list": async (target) => ({ commands: await harness.listCommands(target) }),
    "approval.respond": ({ approvalId, response }) => {
      hub.respondApproval(approvalId, response);
      return {};
    },
    "question.answer": ({ questionId, answer }) => {
      hub.answerQuestion(questionId, answer);
      return {};
    },

    "models.list": async () => ({ models: await harness.listModels() }),
    "options.list": async () => ({ agents: await harness.options() }),
    "modes.list": () => ({ modes: harness.listModes() }),
    "skills.list": async ({ cwd, harness: name }) => ({
      skills: await harness.connector(name).listSkills(cwd),
    }),
    "skills.enable": async ({ cwd, name: skill, enabled, harness: name }) => {
      const connector = harness.connector(name);
      await connector.enableSkill(skill, enabled);
      push({ type: "skills.changed", harness: name ?? harness.name });
      return { skills: await connector.listSkills(cwd) };
    },
    "hooks.read": ({ harness: name }) => harness.connector(name).readHooks(),
    "hooks.set": async ({ settings: hooks, harness: name }) => {
      const connector = harness.connector(name);
      await connector.setHooks(hooks);
      const now = await connector.readHooks();
      push({ type: "hooks.changed", harness: name ?? harness.name, settings: now });
      // The owner's own servers come and go with their settings.
      void mcpChanged(name).catch(() => {});
      return now;
    },
    "mcp.list": async ({ harness: name }) => ({
      servers: await harness.connector(name).listMcpServers(),
    }),
    "mcp.put": ({ server, harness: name }) =>
      mcpChange(name, () => harness.connector(name).putMcpServer(server)),
    "mcp.remove": ({ name: server, harness: name }) =>
      mcpChange(name, () => harness.connector(name).removeMcpServer(server)),
    "mcp.enable": ({ name: server, enabled, harness: name }) =>
      mcpChange(name, () => harness.connector(name).enableMcpServer(server, enabled)),
    "mcp.enableTool": ({ name: server, tool, enabled, harness: name }) =>
      mcpChange(name, () => harness.connector(name).enableMcpTool(server, tool, enabled)),
    "subagents.list": async ({ cwd, harness: name }) => {
      const list = harness.connector(name).listSubagents;
      return { agents: list ? await list(cwd) : [] };
    },
    "mcp.reconnect": ({ name: server, harness: name }) =>
      mcpChange(name, async () => {
        const reconnect = harness.connector(name).reconnectMcpServer;
        if (!reconnect)
          throw new NotSupported(`${name ?? harness.name} cannot reconnect a server.`);
        await reconnect(server);
      }),
    "mcp.login": ({ name: server, harness: name }) =>
      harness.connector(name).loginMcpServer(server),
    "plugins.list": ({ harness: name }) => harness.connector(name).listPlugins(),
    "plugins.read": ({ marketplace, name: plugin, harness: name }) =>
      harness.connector(name).readPlugin(marketplace, plugin),
    "plugins.install": ({ marketplace, name: plugin, harness: name }) =>
      pluginChange(name, () => harness.connector(name).installPlugin(marketplace, plugin)),
    "plugins.uninstall": ({ id, harness: name }) =>
      pluginChange(name, () => harness.connector(name).uninstallPlugin(id)),
    "plugins.enable": ({ id, enabled, harness: name }) =>
      pluginChange(name, () => harness.connector(name).enablePlugin(id, enabled)),
    "marketplace.add": ({ source, harness: name }) =>
      pluginChange(name, () => harness.connector(name).addMarketplace(source)),
    "marketplace.remove": ({ name: marketplace, harness: name }) =>
      pluginChange(name, () => harness.connector(name).removeMarketplace(marketplace)),

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
    // Codex's own switches: the main agent's.
    "features.read": () => harness.connector().readFeatures(),
    "features.set": async (features) => {
      await harness.connector().setFeatures({ subagents: features.subagents });
      const now = await harness.connector().readFeatures();
      push({ type: "features.changed", features: now });
      return now;
    },
    "account.read": ({ harness: name }) => harness.account(name).readAccount(),
    "account.login": ({ harness: name }) => harness.account(name).login(),
    "account.login.cancel": async ({ id, harness: name }) => {
      await harness.account(name).cancelLogin(id);
      return {};
    },
    "account.logout": async ({ harness: name }) => {
      await harness.account(name).logout();
      return {};
    },

    "providers.list": () => ({ providers: providers.list() }),
    "providers.kinds": () => ({ kinds: providers.kinds() }),
    "providers.catalog": ({ kind }) => ({ models: providers.catalog(kind) }),
    "providers.save": (draft) => providers.save(draft),
    "providers.delete": ({ id }) => {
      providers.remove(id);
      return {};
    },
    "sandboxes.list": () => ({
      available: sandboxAdmin?.available() ?? false,
      environments: environments?.list() ?? [],
    }),
    "sandboxes.save": (draft) => sandboxes().environments.save(draft),
    "sandboxes.delete": async ({ id }) => {
      const { environments: kept, admin } = sandboxes();
      kept.remove(id);
      // What was made of it goes with it, but for a sandbox a session is running in.
      await admin.forget(id).catch((error: unknown) => {
        console.error(
          `[cycle] sandboxes: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return {};
    },
    "sandboxes.secrets": async () => ({
      secrets: await sandboxes().admin.secrets(),
    }),
    "sandboxes.secret.set": async ({ service, value }) => {
      await sandboxes().admin.setSecret(service, value);
      return {};
    },
    "settings.get": () => settingsView,
    "settings.set": (patch) => {
      const offered = harness.listModes();
      for (const [agent, mode] of Object.entries(patch.modes ?? {})) {
        if (!offered.some((each) => each.harness === agent && each.id === mode)) {
          throw new Error(`${agent} has no mode named ${mode}.`);
        }
      }
      setSettings((value) => {
        if (patch.model !== undefined) value.model = patch.model;
        if (patch.effort !== undefined) value.effort = patch.effort;
        if (patch.modes !== undefined) value.modes = { ...value.modes, ...patch.modes };
        if (patch.worktree !== undefined) value.worktree = patch.worktree;
        if (patch.projects !== undefined) value.projects = patch.projects.slice(0, MAX_PROJECTS);
      });
      return settingsView;
    },
    "usage.daily": () => ({ days: usage.days() }),

    "files.list": async ({ path }) => ({ entries: await files.list(path) }),
    "files.read": ({ path }) => files.read(path),
    "files.search": async ({ root, query }) => ({
      files: await files.search(root, query),
    }),

    "git.status": ({ cwd, base }) => git.status(cwd, base),
    "git.diff": ({ cwd, from, path, status }) => git.diff(cwd, from, path, status),
    "git.branches": ({ cwd }) => git.branches(cwd),
    "git.checkout": async ({ cwd, branch }) => {
      if (hub.busyIn(cwd)) throw new Error("A session is working in this checkout. Stop it first.");
      await git.checkout(cwd, branch);
      return {};
    },
    "git.commit": async ({ cwd, message }) => ({
      commit: await git.commit(cwd, message),
    }),

    "worktree.list": ({ workspace }) => worktrees.list(workspace),
    "worktree.remove": async ({ workspace, path }) => {
      await worktrees.remove(workspace, path);
      return {};
    },

    "terminal.list": ({ sessionId }) => ({
      terminals: terminals.list(sessionId),
    }),
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
        {
          host: request.headers.get("host"),
          origin: request.headers.get("origin"),
        },
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
        return Response.json({
          ok: true,
          version: DAEMON_VERSION,
          harness: harness.name,
        });
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
          reply({
            id: request.id,
            result: await route(request.params ?? {}, socket),
          });
        } catch (error) {
          reply({
            id: request.id,
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      },
    },
  });

  const port = server.port ?? 0;
  // Only once there is a server to tell the pages through. Often enough that
  // a run starts within the minute it is due, and at once for what was missed.
  const tick = () => {
    try {
      scheduler.tick();
    } catch (error) {
      console.error(`[cycle] schedules: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const ticking = setInterval(tick, SCHEDULE_TICK_MS);
  tick();
  options.tools?.serve({
    list: () => hub.list(false),
    async turns(sessionId) {
      // A session the hub has not listed yet is still one of codex's.
      if (!known(hub, sessionId)) await hub.list(false);
      if (!known(hub, sessionId)) return null;
      const opened = await hub.open(sessionId, undefined);
      return "state" in opened ? { info: opened.state.info, turns: opened.state.turns } : null;
    },
  });
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
      await Promise.all([
        settings.flush(),
        meta.flush(),
        usageFile.flush(),
        schedulesFile.flush(),
        options.providers.flush(),
        options.sandboxes?.store.flush(),
      ]);
    },
  };
}

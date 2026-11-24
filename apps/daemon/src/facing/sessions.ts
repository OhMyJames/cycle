// Sessions (docs/protocol.md §6, §8): making one, the list, its settings, closing and deleting it, and what a person
// changes of it (archived, read, its title, background work it no longer wants to see or wants stopped).
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  type AgentApp,
  methods,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk/experimental/v2";
import {
  CycleErrorCode,
  checkEnvironment,
  META,
  sessionArchive,
  sessionDismissBackground,
  sessionMarkRead,
  sessionSetTitle,
  sessionStopSubagent,
  sessionUnarchive,
} from "@cycle/protocol";
import { mapBounded } from "../bounded.ts";
import { environmentRowMeta } from "../environment.ts";
import {
  INVALID_PARAMS,
  logUnavailable,
  RESOURCE_NOT_FOUND,
  RpcError,
  sessionBusy,
} from "../errors.ts";
import type { SessionEntry } from "../index-file.ts";
import { HISTORY_NOT_SAVED, Session } from "../session.ts";
import { checkedConfig, currentValues, orderedConfigEntries } from "../session-config.ts";
import { sessionPage } from "../session-page.ts";
import { isUserMessage } from "../turns.ts";
import { type Core, cycleOn } from "./core.ts";

/** How many sessions a list loads at once. */
const LIST_LOADS = 4;

/**
 * A session's row in the list, or undefined for one the person has not yet written to: a new session is a blank
 * conversation in the client until its first message, and only then is it in the list (docs/protocol.md §6).
 */
const row = async (core: Core, sessionId: string, entry: SessionEntry, onlyPrompted: boolean) => {
  const session = await core.session(sessionId);
  // One whose history has failed is listed whatever it holds: the list is where it is deleted from.
  if (onlyPrompted && session.historyError === undefined && !(await prompted(core, session)))
    return undefined;
  const background = session.backgroundCount();
  return {
    sessionId,
    cwd: entry.cwd,
    updatedAt: session.updatedAt(),
    _meta: {
      [META.archived]: entry.archived === true,
      [META.agent]: entry.agent,
      [META.state]: session.status(),
      [META.lastSeq]: session.log.lastSeq(),
      [META.unread]: session.unread(),
      ...(session.unknownBackground.size
        ? { [META.backgroundUnknown]: [...session.unknownBackground.keys()] }
        : {}),
      ...(background > 0 ? { [META.background]: background } : {}),
      ...(session.historyError !== undefined ? { [META.historyFailed]: true } : {}),
      ...(entry.config !== undefined ? { [META.config]: entry.config } : {}),
      ...environmentRowMeta(entry),
      ...(entry.usage !== undefined ? { [META.usage]: entry.usage } : {}),
      ...(entry.title !== undefined ? { title: entry.title } : {}),
    },
  };
};

/**
 * Whether the person has said anything in the session. Known from the index, or for an entry written before the index
 * kept it, from the log as the session loaded (the daemon's `#backfill`). A log that could not be read then is read again here,
 * and if it still cannot be it throws, and the session is listed as unreadable.
 */
const prompted = async (core: Core, session: Session): Promise<boolean> => {
  if (session.entry.prompted !== undefined) return session.entry.prompted;
  // As stored: an image is not read back from its blob to find out whether there is a message.
  const records = await session.log.read(undefined, { stored: true });
  const prompted = records.some(isUserMessage);
  // A message written while the log was being read has set it already.
  if (session.entry.prompted === undefined) core.remember(session, { prompted }, false);
  return session.entry.prompted ?? prompted;
};

/**
 * A session whose history cannot be read, as the list shows it: what the index knows, with no
 * `cycle/lastSeq` (that comes from the log) and no unread mark, and the marker.
 */
const unreadableRow = (sessionId: string, entry: SessionEntry) => {
  return {
    sessionId,
    cwd: entry.cwd,
    updatedAt: entry.createdAt,
    _meta: {
      [META.archived]: entry.archived === true,
      [META.agent]: entry.agent,
      [META.state]: "stopped",
      [META.historyFailed]: true,
      ...(entry.config !== undefined ? { [META.config]: entry.config } : {}),
      ...environmentRowMeta(entry),
      ...(entry.usage !== undefined ? { [META.usage]: entry.usage } : {}),
      ...(entry.title !== undefined ? { title: entry.title } : {}),
    },
  };
};

export const registerSessions = (app: AgentApp, core: Core): void => {
  const cycle = cycleOn(app, core.log);
  app.onRequest(methods.agent.session.new, async ({ params }) => {
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const agentId =
      typeof meta[META.agent] === "string"
        ? (meta[META.agent] as string)
        : [...core.agents.keys()][0];
    if (agentId === undefined)
      throw new RpcError(CycleErrorCode.AgentUnavailable, "No agent is configured");
    const definition = core.definition(agentId);
    const overrides = checkedConfig(
      definition,
      meta[META.config] === undefined ? {} : meta[META.config],
    );
    // The session's environment (docs/protocol.md §6 "环境"): checked here, before anything is made.
    let environment: SessionEntry["environment"];
    if (meta[META.environment] !== undefined) {
      const checked = checkEnvironment(meta[META.environment]);
      if (!checked.ok) {
        const { problem } = checked;
        throw new RpcError(
          INVALID_PARAMS,
          problem.reason === "reserved_variable"
            ? `The environment may not set ${problem.name}: it is the daemon's`
            : problem.reason === "invalid_variable"
              ? `The environment's variable ${JSON.stringify(problem.name)} is not one a shell can take, or is there twice`
              : problem.reason === "too_large"
                ? `The environment is larger than ${problem.limit} bytes`
                : `The environment is not one this daemon can read: ${problem.detail}`,
          problem,
        );
      }
      environment = checked.environment;
    }
    // The directories are paths on THIS machine (the daemon's), not the client's. Say so up front.
    const directories = [params.cwd, ...(params.additionalDirectories ?? [])];
    for (const [index, directory] of directories.entries()) {
      if (!isAbsolute(directory)) {
        throw new RpcError(
          INVALID_PARAMS,
          `The ${index === 0 ? "working directory" : "directory"} ${directory} is not an absolute path`,
        );
      }
      if (
        !(await stat(directory).then(
          (s) => s.isDirectory(),
          () => false,
        ))
      )
        throw new RpcError(
          INVALID_PARAMS,
          `The ${index === 0 ? "working directory" : "directory"} ${directory} does not exist on the machine the daemon runs on`,
        );
    }
    const id = randomUUID();
    const entry: SessionEntry = {
      agent: agentId,
      agentSessionId: id,
      cwd: params.cwd,
      createdAt: new Date().toISOString(),
      // Not in the list until the person's first message is on record (docs/protocol.md §6).
      prompted: false,
      turnOpen: false,
      // Kept to send again each time the agent starts. Not in the log: that goes to every client.
      ...(params.additionalDirectories?.length
        ? { additionalDirectories: params.additionalDirectories }
        : {}),
      ...(params.mcpServers?.length ? { mcpServers: params.mcpServers } : {}),
      ...(params.systemPrompt != null ? { systemPrompt: params.systemPrompt } : {}),
      // Its variables can be secrets: the index only, like the servers.
      ...(environment !== undefined ? { environment } : {}),
    };
    const log = await core.store.open(id);
    const session = new Session(id, entry, log);
    core.watch(session);
    try {
      await log.append({
        kind: "meta",
        data: { event: "created", agent: agentId, cwd: params.cwd },
      });
      // What the agent is given of the request: not the client's `_meta`, which is the daemon's to read.
      const { _meta: _clientMeta, ...made } = params;
      const { link, created: answer } = await core.startAgent(session, made);
      if (answer === undefined) throw new Error("The agent did not answer session/new");
      session.entry = { ...session.entry, agentSessionId: answer.sessionId };
      // Cycle's defaults for the agent, then what the user set as its defaults, then what they asked of this one.
      const chosen = { ...core.defaults.get(agentId), ...overrides };
      const config = { ...definition.newSession, ...chosen };
      // What the agent says its settings are now: each change answers with the whole set.
      let options: SessionConfigOption[] = answer.configOptions ?? [];
      for (const [configId, value] of orderedConfigEntries(config)) {
        try {
          const changed = await link.agent.request(methods.agent.session.setConfigOption, {
            sessionId: session.entry.agentSessionId,
            configId,
            type: "id",
            value,
          });
          if (changed.configOptions.length > 0) options = changed.configOptions;
        } catch (error) {
          // Cycle's own default, which nobody chose, may not fit what was chosen (an effort the chosen model does not
          // take): the agent's own default stands, and the session is made.
          if (chosen[configId] === undefined) {
            delete config[configId];
            continue;
          }
          throw new RpcError(CycleErrorCode.InvalidConfig, "The agent refused the configuration", {
            configId,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // On record with what the agent started in, not only what was set: a resume sends it again,
      // so a session keeps its mode even if the agent's default for new ones changes. What the
      // agent reported meanwhile (a mode it fell back to) is newer than its first answer.
      const recorded = {
        ...currentValues(options),
        ...(session.entry.config ?? {}),
        ...config,
      };
      if (Object.keys(recorded).length > 0) {
        session.entry = { ...session.entry, config: recorded };
      }
      // Publish the session only after every requested setting has been accepted.
      core.sessions.set(id, session);
      session.lastActive = core.now();
      await core.index.put(id, session.entry);
      core.changed();
      core.letGoOfOldestAhead(session);
      // Made stale while inside session/new (a sign-in/out or runtime change it was not yet listed for): it holds a
      // process made with the old state, and nothing has been asked of it yet, so it goes now.
      core.restartIfStale(session);
      return { sessionId: id, configOptions: options };
    } catch (error) {
      session.closed = true;
      session.link?.kill();
      core.sessions.delete(id);
      await log.close();
      await core.index.delete(id).catch(() => undefined);
      await core.store.remove(id).catch(() => undefined);
      throw error;
    }
  });

  app.onRequest(methods.agent.session.list, async ({ params }) => {
    // Only a client that asks leaves out the sessions nothing has been said in: an older one opens a session it has
    // just made by finding it in the list (docs/protocol.md §6).
    const said =
      (params?._meta as Record<string, unknown> | null | undefined)?.[META.onlyPrompted] === true;
    const page = sessionPage(core.index, params ?? {});
    // A session not loaded yet is read from disk to be listed: a few at a time, not one after another (CYCL-261), and
    // not all at once (each read holds its whole log in memory).
    const rows = await mapBounded(page.entries, LIST_LOADS, async ([sessionId, entry]) => {
      try {
        return await row(core, sessionId, entry, said);
      } catch (error) {
        // Deleted while the list was being read.
        if (error instanceof RpcError && error.code === RESOURCE_NOT_FOUND) return undefined;
        // One session whose history cannot be read is that session's problem, not the list's: it
        // is listed, marked, and says so when it is opened. Anything else is the list's.
        if (!(error instanceof RpcError) || error.code !== CycleErrorCode.LogUnavailable)
          throw error;
        return unreadableRow(sessionId, entry);
      }
    });
    // A session deleted while others were being read is left out, though its own row was read before it went.
    const present = (row: (typeof rows)[number]): row is NonNullable<typeof row> =>
      row !== undefined &&
      core.index.get(row.sessionId) !== undefined &&
      core.sessions.get(row.sessionId)?.closed !== true;
    return {
      sessions: rows.filter(present),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  });

  app.onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
    const session = await core.session(params.sessionId);
    const link = await core.ensureAgent(session);
    const answer = await link.agent.request(methods.agent.session.setConfigOption, {
      ...params,
      sessionId: session.entry.agentSessionId,
    });
    const value = "value" in params ? params.value : undefined;
    if (typeof value === "string") {
      const config = { ...(session.entry.config ?? {}), [params.configId]: value };
      session.entry = { ...session.entry, config };
      await core.index.update(session.id, { config });
      core.changed();
    }
    // An agent started only to take this setting, after its state changed: let go now that it has taken it.
    core.restartIfStale(session);
    return answer;
  });

  app.onRequest(methods.agent.session.close, async ({ params }) => {
    const session = core.sessions.get(params.sessionId);
    if (session !== undefined) core.returnQueue(session, "closed");
    session?.link?.kill();
    return {};
  });

  app.onRequest(methods.agent.session.delete, async ({ params }) => {
    let session: Session;
    try {
      session = await core.session(params.sessionId);
    } catch (error) {
      // A session whose history cannot be read can still be deleted: it is the way out of it.
      if (!(error instanceof RpcError) || error.code !== CycleErrorCode.LogUnavailable) throw error;
      try {
        await core.index.delete(params.sessionId);
        await core.store.remove(params.sessionId);
      } finally {
        core.changed();
      }
      return {};
    }
    if (session.status() === "running" || session.status() === "requires_action")
      throw sessionBusy(session.id);
    session.closed = true;
    session.link?.kill();
    for (const attachment of session.attachments) attachment.detach();
    // Gone from the list now; their processes end on their own time, not the answer's.
    void core.terminals.closeSession(session.id);
    try {
      // The index first, and the session out of the table at once: from then on nobody can load
      // it again or get hold of it (a list that was being read, a client that was reconnecting),
      // so none comes back from the dead while its log is being removed.
      await core.index.delete(session.id);
      core.sessions.delete(session.id);
      await session.log.close();
      await core.store.remove(session.id);
    } finally {
      core.changed();
    }
    return {};
  });

  const change =
    (apply: (session: Session) => Promise<Partial<SessionEntry>>) =>
    async (params: { sessionId: string }) => {
      const session = await core.session(params.sessionId);
      const patch = await apply(session);
      session.entry = { ...session.entry, ...patch };
      await core.index.update(session.id, patch);
      core.changed();
      return {};
    };
  cycle(sessionDismissBackground, async ({ sessionId, taskIds }) => {
    const session = await core.session(sessionId);
    let dismissed = 0;
    for (const id of new Set(taskIds)) {
      const task = session.unknownBackground.get(id);
      if (!task || task.dismissing) continue;
      task.dismissing = true;
      if (
        !(await core.write(session, {
          kind: "update",
          data: {
            sessionUpdate: "subagent_update",
            sessionId: id,
            _meta: { [META.subagent]: { toolCallId: task.toolCallId, status: "dismissed" } },
          },
        }))
      ) {
        task.dismissing = false;
        throw logUnavailable(sessionId, session.historyError ?? HISTORY_NOT_SAVED);
      }
      if (session.unknownBackground.get(id) === task) session.unknownBackground.delete(id);
      dismissed++;
    }
    if (dismissed) core.changed();
    return { dismissed };
  });
  cycle(sessionStopSubagent, async ({ sessionId, childId }) => {
    const session = await core.session(sessionId);
    // Only a sub-agent the agent said can be stopped, that is running, of an agent that is there (docs/protocol.md §9).
    const link = session.link;
    // Never the session's own id: a cancel in it is the turn's, and a stop must not end the turn.
    if (link === undefined || childId === session.entry.agentSessionId || !session.canStop(childId))
      return { stopping: false };
    // ACP v2: a cancel in the child's own session stops that child, not the turn. Its end comes as its subagent_update.
    await link.agent
      .notify(methods.agent.session.cancel, { sessionId: childId })
      .catch(() => undefined);
    core.log.info("subagent_stop_asked", { session: session.id });
    return { stopping: true };
  });
  cycle(sessionArchive, (params) =>
    change(async (session) => {
      if (session.status() === "running" || session.status() === "requires_action")
        throw sessionBusy(session.id);
      return { archived: true };
    })(params).then((done) => {
      // An archived session's terminals go with it (docs/protocol.md §8 "终端"): off the list now, their
      // processes ended in the background.
      void core.terminals.closeSession(params.sessionId);
      return done;
    }),
  );
  cycle(sessionUnarchive, (params) => change(async () => ({ archived: false }))(params));
  cycle(sessionMarkRead, async (params) => {
    const session = await core.session(params.sessionId);
    const lastSeq = session.log.lastSeq();
    if (params.seq > lastSeq) {
      throw new RpcError(INVALID_PARAMS, "seq is past the session's last record", {
        sessionId: session.id,
        seq: params.seq,
        lastSeq,
      });
    }
    const before = session.entry.readSeq ?? 0;
    if (params.seq <= before) return {};
    const unread = session.unread();
    // On disk first: if that fails, what the list says and what a restart reads stay the same.
    // Decided in the index's queue, so a lower mark that arrives meanwhile cannot undo this one.
    await core.index.update(session.id, (entry) => ({
      readSeq: Math.max(entry.readSeq ?? 0, params.seq),
    }));
    const readSeq = core.index.get(session.id)?.readSeq ?? params.seq;
    session.entry = { ...session.entry, readSeq };
    if (session.unread() !== unread) core.changed();
    return {};
  });
  cycle(sessionSetTitle, (params) =>
    change(async () => ({ title: params.title, titleFromAgent: false }))(params),
  );
};

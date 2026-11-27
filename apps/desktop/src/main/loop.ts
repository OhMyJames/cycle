// What the page shows of Loop (docs/protocol.md §17): the Loop server on this computer answers everything over its unix
// socket (`loop/…` methods). This file is that socket's client and nothing more: it holds no itsaplan key, makes no
// itsaplan request, parses no comment and knows no label name. The Loop server's code is not imported: only the
// protocol's types are.

import { mkdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import type { EventProps } from "@cycle/analytics/events";
import {
  LOOP_API_PROJECTS_LIST,
  LOOP_BOARD_GET,
  LOOP_EVENTS_LIST,
  LOOP_NOTICES_LIST,
  LOOP_RUNS_LIST,
  LOOP_TICKET_GET,
  LOOP_TICKETS_ACT,
  LoopBoardSchema,
  LoopEventsListResultSchema,
  LoopNoticesListResultSchema,
  LoopProjectsListResultSchema,
  LoopRunsListResultSchema,
  LoopTicketDetailSchema,
  LoopTicketsActResultSchema,
} from "@cycle/protocol";
import type {
  LoopActFailure,
  LoopAction,
  LoopActResult,
  LoopBoardAnswer,
  LoopChatFailure,
  LoopChatResult,
  LoopManyItem,
  LoopManyResult,
  LoopNoticesAnswer,
  LoopProjectsAnswer,
  LoopRunsAnswer,
  LoopTicketAnswer,
} from "@cycle/ui/api";

export type LoopOptions = {
  /** The Loop server's unix socket. */
  socket: string;
  /** The person's name in itsaplan (Settings), read at each write; empty when they gave none. */
  actor?: () => string;
};

const CALL_TIMEOUT_MS = 20_000;
const MANY_MAX = 50;
const REASON_MAX = 2000;
/** What `actor` is when the person gave no name: the server needs one, and this says where the click came from. */
const DEFAULT_ACTOR = "desktop";

export type Called =
  | { kind: "ok"; result: unknown }
  /** The server answered with an error (`code`, `data.reason`). */
  | { kind: "error"; code: number; reason: string | undefined }
  /** Nothing answered: no socket, a closed connection, a timeout, or a line that is not JSON. */
  | { kind: "no_server" };

/** One request line, one reply line. Never throws. */
export const callLoop = (
  socketPath: string,
  method: string,
  params?: unknown,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<Called> =>
  new Promise((resolve) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (answer: Called) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ kind: "no_server" }), timeoutMs);
    socket.on("error", () => finish({ kind: "no_server" }));
    socket.on("close", () => finish({ kind: "no_server" }));
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) })}\n`,
      ),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end)) as {
          result?: unknown;
          error?: { code?: unknown; data?: { reason?: unknown } };
        };
        if (reply.error !== undefined)
          finish({
            kind: "error",
            code: typeof reply.error.code === "number" ? reply.error.code : 0,
            reason:
              typeof reply.error.data?.reason === "string" ? reply.error.data.reason : undefined,
          });
        else finish({ kind: "ok", result: reply.result });
      } catch {
        finish({ kind: "no_server" });
      }
    });
  });

export const readLoopProjects = async (socketPath: string): Promise<LoopProjectsAnswer> => {
  const called = await callLoop(socketPath, LOOP_API_PROJECTS_LIST, undefined, 3000);
  if (called.kind !== "ok") return { kind: "disconnected" };
  const parsed = LoopProjectsListResultSchema.safeParse(called.result);
  return parsed.success ? { kind: "ok", projects: parsed.data.projects } : { kind: "disconnected" };
};

/**
 * Where Loop is running, by Project: the tickets that have an `active` run record. This is the whole rule (docs/protocol.md
 * §17): a server that did not answer, or an answer that is not the protocol's, says nothing is running, because a
 * Loop that died leaves its `run.json` behind as `active` but takes `loop.sock` with it. Never from a board column.
 */
export const runningOf = (answer: Called): LoopRunsAnswer => {
  if (answer.kind !== "ok") return { kind: "disconnected" };
  const parsed = LoopRunsListResultSchema.safeParse(answer.result);
  if (!parsed.success) return { kind: "disconnected" };
  return {
    kind: "ok",
    running: Object.fromEntries(
      parsed.data.projects.map((p) => [
        p.projectKey,
        p.runs.filter((r) => r.state === "active").map((r) => r.key),
      ]),
    ),
  };
};

const sameRuns = (a: LoopRunsAnswer | undefined, b: LoopRunsAnswer): boolean =>
  a !== undefined && JSON.stringify(a) === JSON.stringify(b);

export type FeedDeps = {
  call: (method: string, params?: unknown) => Promise<Called>;
  /** Told when the run state differs from the one told last. */
  changed: (runs: LoopRunsAnswer) => void;
  /** Follow only once the page has asked for the run state. */
  lazy?: boolean;
};

export const readLoopRuns = async (socketPath: string): Promise<LoopRunsAnswer> =>
  runningOf(await callLoop(socketPath, LOOP_RUNS_LIST, undefined, 3000));

/** The most pages one poll of one Project takes in a row: a server that always says `hasMore` cannot keep it here. */
const FEED_PAGES = 20;
/** The run state is read again at least this often (ticks), for Projects that appear. */
const RUNS_REREAD_TICKS = 15;
/** Reads of the run state in a row that get no answer before the server counts as away. */
const MISSES_TO_AWAY = 3;

/**
 * Keeps up with Loop's event stream (docs/protocol.md §17): per Project it asks `events/list` after the last `seq` it
 * has, applies an event once (a `seq` it has is dropped), and reads the run state again when something new came. A call
 * that fails leaves the last `seq` as it was, so the next one carries it: that is the whole of reconnecting.
 */
export const loopFeed = (deps: FeedDeps) => {
  const last = new Map<string, number>();
  /** Projects whose log was read to its end once: what was in it then is history, not news. */
  const seeded = new Set<string>();
  let told: LoopRunsAnswer | undefined;
  let busy = false;
  let ticks = 0;
  let wanted = !deps.lazy;
  /** Events (or a first read) just made the runs be read: once more on the next tick, in case the record was written after. */
  let recheck = false;
  /** Per Project: ticks in a row its events could not be read, and the tick before which they are not asked (a back-off). */
  const backoff = new Map<string, { failures: number; nextAt: number }>();
  /** The highest `seq` seen per Project: an event at or below it is never news again, even when the log is read again from 0. */
  const high = new Map<string, number>();
  /** Reads of runs/list in a row that got no answer: one miss does not flip the page. */
  let misses = 0;
  /** Each read of runs/list is numbered when it starts; an answer older than one already applied is dropped. */
  let issued = 0;
  let applied = 0;
  let seededNow = false;

  /** Reads the runs and applies them, unless a read that began later has already been applied. Answers what stands. */
  const readRuns = async (): Promise<LoopRunsAnswer> => {
    const stamp = ++issued;
    let runs = runningOf(await deps.call(LOOP_RUNS_LIST));
    if (stamp < applied) return told ?? runs;
    applied = stamp;
    // A miss or two keeps what was last known; the third in a row says the server is away.
    misses = runs.kind === "ok" ? 0 : misses + 1;
    if (runs.kind !== "ok" && told?.kind === "ok" && misses < MISSES_TO_AWAY) runs = told;
    const same = sameRuns(told, runs);
    told = runs;
    // A page that cannot be told is not a reason to stop following.
    if (!same)
      try {
        deps.changed(runs);
      } catch {}
    return runs;
  };

  /**
   * One Project's events since the last `seq`: `fresh` when there were new ones, `away` when the server did not answer
   * (the run state may have changed, look at it), `broken` when it answered with an error or nonsense (looking at the
   * runs would say nothing new: not a reason to read them).
   */
  const pull = async (projectKey: string): Promise<"fresh" | "quiet" | "away" | "broken"> => {
    let fresh = false;
    let reset = false;
    for (let page = 0; page < FEED_PAGES; page++) {
      const after = last.get(projectKey) ?? 0;
      const answer = await deps.call(LOOP_EVENTS_LIST, {
        projectKey,
        afterSeq: after,
        limit: 1000,
      });
      if (answer.kind === "no_server") return "away";
      if (answer.kind === "error") {
        // The `seq` is not in the file (or is past its end): start again from 0; what was applied stays applied.
        if (!reset && (answer.reason === "seq_gone" || answer.reason === "seq_ahead")) {
          reset = true;
          fresh = true;
          last.set(projectKey, 0);
          // A log that starts again has its own numbers: the old high-water mark does not apply to it.
          high.set(projectKey, 0);
          continue;
        }
        return "broken";
      }
      const parsed = LoopEventsListResultSchema.safeParse(answer.result);
      if (!parsed.success) return "broken";
      const history = !seeded.has(projectKey);
      if (history) seededNow = true;
      let top = after;
      for (const event of parsed.data.events) {
        if (event.seq <= top) continue;
        top = event.seq;
        if (!history && event.seq > (high.get(projectKey) ?? 0)) fresh = true;
      }
      high.set(projectKey, Math.max(high.get(projectKey) ?? 0, top));
      last.set(projectKey, Math.max(top, parsed.data.lastSeq));
      if (!parsed.data.hasMore) {
        seeded.add(projectKey);
        return fresh ? "fresh" : "quiet";
      }
    }
    return fresh ? "fresh" : "quiet";
  };

  /** Pulls one Project unless it is backing off; a broken feed makes only that Project wait longer. */
  const pullOne = async (projectKey: string) => {
    const wait = backoff.get(projectKey);
    if (wait !== undefined && ticks < wait.nextAt) return "quiet" as const;
    const got = await pull(projectKey);
    if (got === "broken") {
      const failures = (wait?.failures ?? 0) + 1;
      backoff.set(projectKey, { failures, nextAt: ticks + Math.min(2 ** (failures - 1) - 1, 30) });
    } else backoff.delete(projectKey);
    return got;
  };

  const tick = async (): Promise<void> => {
    if (busy || !wanted) return;
    ticks++;
    busy = true;
    try {
      const wasOk = told?.kind === "ok";
      // Read now: nothing is known yet, the last answer asked for another look, or it is time (a Project may be new).
      let read = !wasOk || recheck || ticks % RUNS_REREAD_TICKS === 0;
      let fresh = false;
      seededNow = false;
      if (told?.kind === "ok")
        for (const projectKey of Object.keys(told.running)) {
          const got = await pullOne(projectKey);
          if (got === "fresh") fresh = true;
          else if (got === "away") {
            // The server is not there: the others are not asked one by one, the runs say so.
            read = true;
            break;
          }
        }
      if (fresh) read = true;
      if (read) {
        let runs = await readRuns();
        if (runs.kind === "ok" && !wasOk) {
          // A first read, or the first after the server was away: every log is read to its end from the last `seq` held.
          let more = false;
          for (const projectKey of Object.keys(runs.running)) {
            const got = await pullOne(projectKey);
            if (got === "fresh") more = true;
            else if (got === "away") break;
          }
          if (more) runs = await readRuns();
        }
        recheck = fresh || !wasOk;
      }
      // A Project seen for the first time had its log taken as history: its runs are looked at once more.
      if (seededNow) recheck = true;
    } finally {
      busy = false;
    }
  };

  return {
    tick,
    /** The page asked: read now, remember it as told, and answer. */
    async read(): Promise<LoopRunsAnswer> {
      wanted = true;
      // Told too (when it differs from what was told last), so a page that dropped its read for a newer push still gets it.
      const runs = await readRuns();
      return runs;
    },
    /** The last `seq` applied for a Project (for tests and for looking). */
    lastSeq: (projectKey: string) => last.get(projectKey) ?? 0,
  };
};

const PROJECT_KEY = /^[A-Za-z0-9_-]{1,32}$/;
const validKey = (key: unknown): key is string => typeof key === "string" && PROJECT_KEY.test(key);

/** The Project's board, as the server answers it. Only the kind of the outcome is reported. */
export const answerBoard = async (
  loop: LoopOptions | undefined,
  projectKey: unknown,
  track: (event: "loop_board_read", props: { result: LoopBoardAnswer["kind"] }) => void,
): Promise<LoopBoardAnswer> => {
  // Nothing was attempted: not reported.
  if (!loop) return { kind: "no_server" };
  if (!validKey(projectKey)) return { kind: "unreachable" };
  const called = await callLoop(loop.socket, LOOP_BOARD_GET, { project: projectKey });
  const parsed = called.kind === "ok" ? LoopBoardSchema.safeParse(called.result) : undefined;
  const answer: LoopBoardAnswer =
    called.kind === "no_server"
      ? { kind: "no_server" }
      : parsed?.success
        ? {
            kind: "ok",
            stale: parsed.data.stale,
            columns: parsed.data.columns.map((c) => ({
              id: c.id,
              name: c.name,
              stateType: c.stateType,
              more: false,
              tickets: c.cards.map((card) => ({
                identifier: card.key,
                title: card.title,
                priority: card.priority,
                column: c.name,
                type: card.type,
                parent: card.parent
                  ? { identifier: card.parent.key, title: card.parent.title }
                  : null,
                ...(card.pendingReason !== null ? { pending: { reason: card.pendingReason } } : {}),
                ...(card.phase !== null ? { phase: card.phase } : {}),
              })),
            })),
          }
        : { kind: "unreachable" };
  track("loop_board_read", { result: answer.kind });
  return answer;
};

/** The Project's Notices, as the server answers them. Only how many of the three kinds that are told are reported. */
export const answerNotices = async (
  loop: LoopOptions | undefined,
  projectKey: unknown,
  track: (event: "loop_notices_read", props: EventProps<"loop_notices_read">) => void,
): Promise<LoopNoticesAnswer> => {
  if (!loop) return { kind: "no_server" };
  if (!validKey(projectKey)) return { kind: "unreachable" };
  const called = await callLoop(loop.socket, LOOP_NOTICES_LIST, { project: projectKey });
  if (called.kind === "no_server") return { kind: "no_server" };
  const parsed =
    called.kind === "ok" ? LoopNoticesListResultSchema.safeParse(called.result) : undefined;
  if (!parsed?.success) return { kind: "unreachable" };
  const notices = parsed.data.notices.map((n) => ({
    id: n.id,
    kind: n.kind,
    identifier: n.key,
    text: n.text,
    session: n.session,
  }));
  const count = (kind: string) => notices.filter((n) => n.kind === kind).length;
  track("loop_notices_read", {
    permission: count("permission"),
    blocked: count("blocked"),
    review: count("review"),
  });
  return { kind: "ok", notices };
};

const failureOf = (reason: string | undefined): LoopActFailure =>
  reason === "forbidden" || reason === "conflict" || reason === "offline" ? reason : "refused";

/** The person's name for `actor`; the server needs one, so with none given it says where the click came from. */
const actorOf = (loop: LoopOptions): string => loop.actor?.().trim() || DEFAULT_ACTOR;

/**
 * A batch over the tickets waiting for approval, done by the server: it reads each ticket again and writes only what is
 * still waiting. Nothing goes without `confirmed`. Not tracked here: the page reports one event for the whole batch.
 */
export const actOnMany = async (
  loop: LoopOptions | undefined,
  projectKey: unknown,
  action: unknown,
  identifiers: unknown,
  confirmed: unknown,
  reason: unknown,
): Promise<LoopManyResult> => {
  if (action !== "approve_many" && action !== "return_many")
    return { kind: "failed", reason: "refused" };
  if (
    !validKey(projectKey) ||
    !Array.isArray(identifiers) ||
    identifiers.length === 0 ||
    identifiers.length > MANY_MAX ||
    !identifiers.every((i) => typeof i === "string" && i !== "")
  )
    return { kind: "failed", reason: "refused" };
  if (confirmed !== true) return { kind: "failed", reason: "unconfirmed" };
  if (!loop) return { kind: "failed", reason: "no_server" };
  const why = typeof reason === "string" ? reason.trim().slice(0, REASON_MAX) : "";
  const keys = [...new Set(identifiers as string[])];
  const called = await callLoop(loop.socket, LOOP_TICKETS_ACT, {
    project: projectKey,
    verb: action === "approve_many" ? "approve" : "return",
    keys,
    ...(action === "return_many" && why !== "" ? { reason: why } : {}),
    confirmed: true,
    actor: actorOf(loop),
    actorKind: "desktop",
  });
  if (called.kind === "no_server") return { kind: "failed", reason: "no_server" };
  if (called.kind === "error") return { kind: "failed", reason: failureOf(called.reason) };
  const parsed = LoopTicketsActResultSchema.safeParse(called.result);
  if (!parsed.success) return { kind: "failed", reason: "refused" };
  const results: LoopManyItem[] = parsed.data.results.map((r) =>
    r.status === "ok"
      ? { identifier: r.key, outcome: "ok" }
      : r.status === "skipped"
        ? { identifier: r.key, outcome: "skipped" }
        : { identifier: r.key, outcome: "failed", reason: failureOf(r.reason) },
  );
  return { kind: "done", results };
};

const IDENTIFIER = /^([A-Za-z0-9_-]{1,32})-(\d{1,9})$/;

/** The identifier and the Project it is asked under must agree, so a ticket of another Project is never asked for. */
const identifierOf = (projectKey: unknown, identifier: unknown): string | undefined =>
  validKey(projectKey) &&
  typeof identifier === "string" &&
  IDENTIFIER.exec(identifier)?.[1] === projectKey
    ? identifier
    : undefined;

export type Track = <N extends "loop_ticket_opened" | "loop_ticket_acted" | "loop_ticket_chat">(
  event: N,
  props: EventProps<N>,
) => void;

const readTicket = async (
  loop: LoopOptions,
  projectKey: string,
  key: string,
): Promise<LoopTicketAnswer> => {
  const called = await callLoop(loop.socket, LOOP_TICKET_GET, { project: projectKey, key });
  if (called.kind === "no_server") return { kind: "no_server" };
  const parsed = called.kind === "ok" ? LoopTicketDetailSchema.safeParse(called.result) : undefined;
  if (!parsed?.success) return { kind: "unreachable" };
  const d = parsed.data;
  return {
    kind: "ok",
    ticket: {
      identifier: d.identifier,
      title: d.title,
      priority: d.priority,
      column: d.column,
      actions: d.actions,
      chat: d.chat,
      body: d.body,
      acceptance: d.acceptance,
      links: d.links,
      ...(d.attention ? { attention: d.attention } : {}),
    },
  };
};

/** One ticket for its page, as the Loop server answers it: the text, the criteria, the links, the buttons, the chat. */
export const answerTicket = async (
  loop: LoopOptions | undefined,
  projectKey: unknown,
  identifier: unknown,
  track: Track,
): Promise<LoopTicketAnswer> => {
  if (!loop) return { kind: "no_server" };
  const key = identifierOf(projectKey, identifier);
  if (key === undefined) return { kind: "unreachable" };
  const answer = await readTicket(loop, projectKey as string, key);
  if (answer.kind === "ok") track("loop_ticket_opened", {});
  return answer;
};

/**
 * A state button, done by the Loop server, which reads the ticket again and writes only when the button still is
 * allowed (else `not_allowed`). Approving without `confirmed` is refused here, and nothing is sent.
 */
export const actOnTicket = async (
  loop: LoopOptions | undefined,
  projectKey: unknown,
  identifier: unknown,
  action: unknown,
  confirmed: unknown,
  track: Track,
): Promise<LoopActResult> => {
  if (action !== "approve" && action !== "to_backlog" && action !== "to_todo")
    return { kind: "failed", reason: "refused" };
  const done = (result: LoopActResult): LoopActResult => {
    track("loop_ticket_acted", {
      action: action as LoopAction,
      result: result.kind === "ok" ? "ok" : result.reason,
    });
    return result;
  };
  const key = identifierOf(projectKey, identifier);
  if (key === undefined) return { kind: "failed", reason: "refused" };
  if (action === "approve" && confirmed !== true)
    return done({ kind: "failed", reason: "unconfirmed" });
  if (!loop) return done({ kind: "failed", reason: "no_server" });
  const called = await callLoop(loop.socket, LOOP_TICKETS_ACT, {
    project: projectKey,
    verb: action,
    keys: [key],
    confirmed: confirmed === true,
    actor: actorOf(loop),
    actorKind: "desktop",
  });
  if (called.kind === "no_server") return done({ kind: "failed", reason: "no_server" });
  if (called.kind === "error") return done({ kind: "failed", reason: failureOf(called.reason) });
  const parsed = LoopTicketsActResultSchema.safeParse(called.result);
  const one = parsed.success ? parsed.data.results[0] : undefined;
  if (one === undefined) return done({ kind: "failed", reason: "refused" });
  if (one.status === "ok") return done({ kind: "ok" });
  return done({
    kind: "failed",
    reason: one.status === "failed" ? failureOf(one.reason) : "not_allowed",
  });
};

/** What the chat needs of the app: the local daemon's calls, so this file does not know the manager. */
export const CHAT_AGENT = "codex";
export type ChatDeps = {
  locationId: string;
  /** Where the session runs. */
  cwd: string;
  agentDefaults: (agent: string) => Promise<Record<string, string>>;
  createSession: (params: {
    cwd: string;
    agent: string;
    config: Record<string, string>;
  }) => Promise<string | { problem: unknown }>;
  prompt: (sessionId: string, text: string) => Promise<void>;
};

/** The first message: the ticket's number, so the agent reads it through itsaplan (the connector) and works on it. */
const firstMessage = (identifier: string): string =>
  `Let's work on ticket ${identifier} together. Read it in itsaplan first. Help me refine the requirement: fix the text, add acceptance criteria, and ask what is unclear. Do not move it to another column; I will approve it myself.`;

/**
 * The person asked to talk about a ticket with an agent. The Loop server says whether it may (`chat: "new"`: Backlog
 * and Todo); otherwise `not_allowed` and nothing is made. The agent's default model is needed: without it nothing is
 * made, and the page says to set it in Settings (`needs_model`) instead of a session failing.
 */
export const startTicketChat = async (
  loop: LoopOptions | undefined,
  deps: ChatDeps,
  projectKey: unknown,
  identifier: unknown,
  track: Track,
): Promise<LoopChatResult> => {
  const done = (reason: LoopChatFailure | "started", result?: LoopChatResult): LoopChatResult => {
    track("loop_ticket_chat", { result: reason });
    return result ?? { kind: "failed", reason: reason as LoopChatFailure };
  };
  const key = identifierOf(projectKey, identifier);
  if (key === undefined) return { kind: "failed", reason: "refused" };
  if (!loop) return done("no_server");
  const read = await readTicket(loop, projectKey as string, key);
  if (read.kind === "no_server") return done("no_server");
  if (read.kind !== "ok") return done("refused");
  if (read.ticket.chat !== "new") return done("not_allowed");
  let model: string | undefined;
  try {
    model = (await deps.agentDefaults(CHAT_AGENT)).model?.trim();
  } catch {
    return done("failed");
  }
  if (model === undefined || model === "") return done("needs_model");
  // Never the home folder: without a folder of its own, nothing is made.
  if (deps.cwd === "") return done("no_folder");
  try {
    await mkdir(deps.cwd, { recursive: true });
  } catch {
    return done("no_folder");
  }
  let made: string | { problem: unknown };
  try {
    made = await deps.createSession({ cwd: deps.cwd, agent: CHAT_AGENT, config: { model } });
  } catch (error) {
    return done((error as { code?: unknown })?.code === -32000 ? "auth_required" : "failed");
  }
  if (typeof made !== "string") return done("refused");
  try {
    await deps.prompt(made, firstMessage(key));
  } catch {
    // The session exists: its id goes with the failure, so the person can open it and say the first thing themselves.
    track("loop_ticket_chat", { result: "failed" });
    return { kind: "failed", reason: "failed", sessionId: made, locationId: deps.locationId };
  }
  return done("started", { kind: "started", locationId: deps.locationId, sessionId: made });
};

/**
 * The itsaplan key file an older version kept (CYC-483): Loop holds the key now. It is removed at start, and `tell` is
 * called only when there was one to remove, so the person is told once.
 */
export const retireKeyFile = async (path: string, tell: () => void): Promise<boolean> => {
  try {
    await rm(path);
  } catch {
    return false;
  }
  tell();
  return true;
};

/** The page asked for the run state: read it, and report only whether Loop answered. */
export const answerRuns = async (
  feed: { read: () => Promise<LoopRunsAnswer> } | undefined,
  track: (event: "loop_runs_read", props: { result: LoopRunsAnswer["kind"] }) => void,
): Promise<LoopRunsAnswer> => {
  const runs: LoopRunsAnswer = feed ? await feed.read() : { kind: "disconnected" };
  track("loop_runs_read", { result: runs.kind });
  return runs;
};

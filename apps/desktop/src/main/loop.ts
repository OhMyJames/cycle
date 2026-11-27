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
  LOOP_NOTICES_LIST,
  LOOP_TICKET_GET,
  LOOP_TICKETS_ACT,
  LoopBoardSchema,
  LoopNoticesListResultSchema,
  LoopProjectsListResultSchema,
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

type Called =
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

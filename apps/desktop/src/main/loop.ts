// What the page shows of Loop (docs/protocol.md §17). Two reads, both from the main process:
//   - the Projects: the Loop server on this computer answers `projects/list` on its unix socket;
//   - one Project's board: read from itsaplan with the person's own key, a file of theirs (mode 0600). The key is
//     read here and goes to the tracker's header, never to the page, a log line or an environment variable
//     (.agents/notes/2026-11-25-desktop-holds-a-personal-itsaplan-key-for-now.md).
// The Loop server's code is not imported: only the protocol's types are.

import { statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
import type { EventProps } from "@cycle/analytics/events";
import { LOOP_PROJECTS_LIST, LoopProjectsListResultSchema } from "@cycle/protocol";
import type {
  LoopActFailure,
  LoopAction,
  LoopActResult,
  LoopBoardAnswer,
  LoopBoardColumn,
  LoopChat,
  LoopChatFailure,
  LoopChatResult,
  LoopManyAction,
  LoopManyItem,
  LoopManyResult,
  LoopNotice,
  LoopNoticesAnswer,
  LoopProjectsAnswer,
  LoopTicket,
  LoopTicketAnswer,
  LoopTicketDetail,
} from "@cycle/ui/api";

const PROJECTS_TIMEOUT_MS = 3000;

export const readLoopProjects = (socketPath: string): Promise<LoopProjectsAnswer> =>
  new Promise((resolve) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (answer: LoopProjectsAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ kind: "disconnected" }), PROJECTS_TIMEOUT_MS);
    socket.on("error", () => finish({ kind: "disconnected" }));
    socket.on("close", () => finish({ kind: "disconnected" }));
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: LOOP_PROJECTS_LIST })}\n`),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end)) as { result?: unknown };
        const parsed = LoopProjectsListResultSchema.safeParse(reply.result);
        finish(
          parsed.success
            ? { kind: "ok", projects: parsed.data.projects }
            : { kind: "disconnected" },
        );
      } catch {
        finish({ kind: "disconnected" });
      }
    });
  });

/** The key in the file, or undefined when there is none or others can read it (the same rule as the Loop server's). */
export const readKeyFile = async (path: string): Promise<string | undefined> => {
  try {
    if ((statSync(path).mode & 0o077) !== 0) return undefined;
    const key = (await readFile(path, "utf8")).trim();
    return key === "" ? undefined : key;
  } catch {
    return undefined;
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** A reply is plain JSON or one server-sent event. */
const jsonOf = (text: string): string =>
  text.startsWith("event:") || text.startsWith("data:")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("")
    : text;

export type Tracker = { url: string; key: string; fetch?: typeof fetch };

/** A refusal by the tracker, with the HTTP-like status it gave when it gave one. */
class TrackerError extends Error {
  constructor(readonly status: number | undefined) {
    super("tracker error");
  }
}

/** One `tools/call`; the tool's own answer is JSON in the first text part. Throws on anything but a good answer. */
const callTool = async (
  t: Tracker,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> => {
  const response = await (t.fetch ?? fetch)(t.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${t.key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new TrackerError(response.status);
  const body = asRecord(JSON.parse(jsonOf(await response.text())));
  if (body.error !== undefined) throw new TrackerError(undefined);
  const result = asRecord(body.result);
  const text = (result.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
  // A tool's own error may be plain text: it is a refusal, never a failure to parse (which would read as offline).
  if (result.isError === true) {
    let status: unknown;
    try {
      status = asRecord(JSON.parse(text)).status;
    } catch {}
    throw new TrackerError(typeof status === "number" ? status : undefined);
  }
  // An empty answer is no answer: the reads fail on it, as they did before.
  const answer: unknown = JSON.parse(text);
  const status = asRecord(answer).status;
  if (asRecord(answer).ok === false)
    throw new TrackerError(typeof status === "number" ? status : undefined);
  return answer;
};

/** The answer itself, or what is in its `data` when it is wrapped as `{ok, data}`. */
const unwrap = (value: unknown): Record<string, unknown> => {
  const r = asRecord(value);
  return "data" in r && r.ok !== undefined ? asRecord(r.data) : r;
};

/** The issues of a list answer: a bare array, or one in `data` or `issues`. */
const rowsOf = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  const r = asRecord(value);
  if (Array.isArray(r.data)) return r.data;
  if (Array.isArray(r.issues)) return r.issues;
  throw new Error("unrecognized list");
};

type Column = { id: number; name: string; stateType: string; position?: number };

/** What a started column is for. Loop's own convention (tools/auto-loop/src/project.ts): the 1st is In Progress, the 2nd In Review, the 3rd Blocked, in board order. */
export type Role = "progress" | "review" | "blocked";

export const roleOf = (columns: Column[], column: Column): Role | undefined => {
  const started = columns.filter((c) => c.stateType === "started");
  // By `position` only when every one has it: a mix of positions and array order could swap two roles.
  const ordered = started.every((c) => typeof c.position === "number")
    ? [...started].sort((a, b) => Number(a.position) - Number(b.position))
    : started;
  const nth = ordered.findIndex((c) => c.id === column.id);
  return nth === 0 ? "progress" : nth === 1 ? "review" : nth === 2 ? "blocked" : undefined;
};

/**
 * The buttons a ticket gets: Done has none, and in Doing a ticket with `auto` is Loop's, so it has none either. The
 * exception is Blocked: Loop has stopped there and waits for a person, who puts it back to Todo (or Backlog).
 */
export const actionsOf = (stateType: string, auto: boolean, role?: Role): LoopAction[] => {
  if (stateType === "backlog") return ["approve"];
  if (stateType === "unstarted") return ["to_backlog"];
  if (stateType === "started") return auto && role !== "blocked" ? [] : ["to_backlog", "to_todo"];
  return [];
};

/**
 * What an agent may do with a ticket, by the kind of its column (CYC-389). Backlog and Todo: a new conversation.
 * A Todo ticket with `auto` is queued for Loop, which picks it up on its own: no conversation (send it back to Backlog
 * to refine it). In Progress (the role `progress` of the started columns): only to look, because for now that column
 * is the sign that Loop is running it; a ticket Loop left there when it died is taken for running too (CYC-390
 * corrects it with the run data). Review, Blocked (CYC-388 joins the original session) and the rest: nothing.
 */
export const chatOf = (stateType: string, role?: Role, auto = false): LoopChat =>
  stateType === "backlog"
    ? "new"
    : stateType === "unstarted"
      ? auto
        ? "none"
        : "new"
      : stateType === "started" && role === "progress"
        ? "watch"
        : "none";

const AUTO = "auto";
/** The labels of Loop's planning node (CYC-322): a shaped ticket waits for a person; a returned one is left alone. */
const PENDING = "待批准";
const SKIP = "Loop 跳过";
/** The fixed first line of the comment that says why a ticket was shaped (tools/auto-loop `NOTES_HEADING`). */
const NOTES_HEADING = "Loop 规划";

/** The id of a label of a Project, by its name (labels are per Project). */
const labelOf = (project: Record<string, unknown>, name: string): number | undefined => {
  const labels = Array.isArray(project.labels) ? project.labels : [];
  const found = labels.map(asRecord).find((l) => l.name === name);
  return typeof found?.id === "number" ? found.id : undefined;
};
const autoLabelOf = (project: Record<string, unknown>): number | undefined =>
  labelOf(project, AUTO);

const labelIdsOf = (row: Record<string, unknown>): number[] =>
  (Array.isArray(row.labelIds) ? row.labelIds : []).filter(
    (n): n is number => typeof n === "number",
  );

const columnsOf = (project: Record<string, unknown>): Column[] =>
  (Array.isArray(project.columns) ? project.columns : []).map(
    (c) => asRecord(c) as unknown as Column,
  );

const DONE_SHOWN = 20;
/** The most a list answers (the tracker's own limit): a column is shown whole, so its count is true. */
const LIST_LIMIT = 500;

const REASON_MAX = 200;

/** Loop's reason in its newest `Loop 规划` comment: what follows the heading, up to the first blank line. */
export const reasonOf = (comments: { body: string }[]): string | undefined => {
  for (const { body } of comments) {
    if (!body.startsWith(NOTES_HEADING)) continue;
    const first =
      body
        .slice(NOTES_HEADING.length)
        .trim()
        .split(/\n\s*\n/, 1)[0] ?? "";
    const text = first.replace(/\s+/g, " ").trim();
    return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
  }
  return undefined;
};

/** What a person needs to decide on a ticket waiting for approval. A read that fails gives no reason, not an error. */
const pendingOf = async (
  t: Tracker,
  projectKey: string,
  row: Record<string, unknown>,
): Promise<NonNullable<LoopTicket["pending"]>> => {
  let criteria = typeof row.description === "string" ? acceptanceOf(row.description).length : 0;
  try {
    if (typeof row.description !== "string") {
      const parsed = parseIdentifier(projectKey, row.identifier);
      if (!parsed) throw new Error("identifier");
      const issue = unwrap(await callTool(t, "get_issue_by_number", parsed));
      criteria = acceptanceOf(
        typeof issue.description === "string" ? issue.description : "",
      ).length;
    }
    const reason = reasonOf(await cachedComments(t, row)) ?? "";
    return { reason, criteria };
  } catch {
    return { reason: "", criteria };
  }
};

/** Tickets by the kind of their column (never its name); read-only. */
export const readBoard = async (t: Tracker, projectKey: string): Promise<LoopBoardAnswer> => {
  try {
    // The tracker answers with the thing itself (`{project, columns, ...}`, a bare array of issues); some paths wrap it
    // as `{ok, data}`. Both are read; an answer with no columns is a failure, not an empty board.
    const project = unwrap(await callTool(t, "get_project", { projectKey }));
    const columns = columnsOf(project);
    const autoId = autoLabelOf(project);
    const pendingId = labelOf(project, PENDING);
    if (columns.length === 0) throw new Error("no columns");
    const ticketsOf = async (
      column: Column,
      limit: number,
    ): Promise<(LoopTicket & { at: string })[]> => {
      const rows = rowsOf(
        await callTool(t, "list_issues", { projectKey, columnId: column.id, limit }),
      );
      const role = roleOf(columns, column);
      const tickets = rows.map((row): LoopTicket & { at: string } => {
        const r = asRecord(row);
        const auto = autoId !== undefined && labelIdsOf(r).includes(autoId);
        return {
          at: String(r.updatedAt ?? ""),
          identifier: String(r.identifier ?? ""),
          title: String(r.title ?? ""),
          priority: typeof r.priority === "string" ? r.priority : null,
          column: column.name,
          actions: actionsOf(column.stateType, auto, role),
          chat: chatOf(column.stateType, role, auto),
        };
      });
      if (column.stateType !== "backlog" || pendingId === undefined) return tickets;
      // Only the tickets waiting for approval are read one by one, a few at a time: a failed read leaves that card
      // without its reason and the rest of the board as it was.
      const waiting = rows
        .map((row, i) => ({ r: asRecord(row), ticket: tickets[i] }))
        .filter(({ r }) => labelIdsOf(r).includes(pendingId));
      let next = 0;
      const lane = async () => {
        while (next < waiting.length) {
          const entry = waiting[next++];
          if (entry?.ticket === undefined) continue;
          entry.ticket.pending = await pendingOf(t, projectKey, entry.r);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, waiting.length) }, lane));
      return tickets;
    };
    // The tracker's own board order: by `position` when every column has one, else as listed.
    const ordered = columns.every((c) => typeof c.position === "number")
      ? [...columns].sort((a, b) => Number(a.position) - Number(b.position))
      : columns;
    const shown = ordered.filter((c) => c.stateType !== "canceled");
    const board = await Promise.all(
      shown.map(async (column): Promise<LoopBoardColumn> => {
        const completed = column.stateType === "completed";
        // A completed column is the newest few; one more is asked for to know whether there are others.
        const rows = await ticketsOf(column, completed ? DONE_SHOWN + 1 : LIST_LIMIT);
        if (completed) rows.sort((a, b) => b.at.localeCompare(a.at));
        const kept = completed ? rows.slice(0, DONE_SHOWN) : rows;
        return {
          id: column.id,
          name: column.name,
          stateType: column.stateType,
          tickets: kept.map(({ at: _at, ...ticket }) => ticket),
          more: rows.length > kept.length,
        };
      }),
    );
    return { kind: "ok", columns: board };
  } catch {
    return { kind: "unreachable" };
  }
};

export type LoopOptions = {
  socket: string;
  keyFile: string;
  trackerUrl: string;
  /** Where a ticket conversation runs (made on first use). Without it no conversation is started. */
  chatCwd?: string;
};

/** The page asked for a board: the key is read, the board is read, and only the kind of the outcome is reported. */
export const answerBoard = async (
  loop: LoopOptions | undefined,
  projectKey: unknown,
  track: (event: "loop_board_read", props: { result: LoopBoardAnswer["kind"] }) => void,
  fetchImpl?: typeof fetch,
): Promise<LoopBoardAnswer> => {
  // Nothing was attempted: not reported, and not blamed on the key.
  if (!loop) return { kind: "no_key" };
  if (typeof projectKey !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(projectKey))
    return { kind: "unreachable" };
  let board: LoopBoardAnswer = { kind: "no_key" };
  const key = await readKeyFile(loop.keyFile);
  if (key !== undefined)
    board = await readBoard(
      { url: loop.trackerUrl, key, ...(fetchImpl ? { fetch: fetchImpl } : {}) },
      projectKey,
    );
  track("loop_board_read", { result: board.kind });
  return board;
};

const IDENTIFIER = /^([A-Za-z0-9_-]{1,32})-(\d{1,9})$/;

/** The identifier and the Project it is asked under must agree, so a ticket of another Project is never written. */
const parseIdentifier = (projectKey: unknown, identifier: unknown) => {
  if (typeof projectKey !== "string" || typeof identifier !== "string") return undefined;
  const m = IDENTIFIER.exec(identifier);
  if (!m || m[1] !== projectKey) return undefined;
  return { projectKey, sequenceNumber: Number(m[2]) };
};

const failureOf = (error: unknown): LoopActFailure => {
  if (error instanceof TrackerError) {
    if (error.status === 401 || error.status === 403) return "forbidden";
    if (error.status === 409) return "conflict";
    return "refused";
  }
  // fetch rejects (no network, timeout) with something that is not the tracker's answer.
  return "offline";
};

/** The `## 验收标准` (or `## Acceptance criteria`) section as its items. */
export const acceptanceOf = (body: string): string[] => {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^##\s+(验收标准|acceptance criteria)\s*$/i.test(l.trim()));
  if (start === -1) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    const item = /^\s*(?:\d+[.)]|[-*])\s+(.*\S)/.exec(line);
    if (item?.[1] !== undefined) items.push(item[1]);
    else if (items.length > 0 && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
};

const PR_URL = /https:\/\/[^\s)<>\]"'`]+\/(?:pull|merge_requests)\/\d+/g;

/** Pull or merge request addresses: those in the ticket's development links, and in its text. https only. */
export const linksOf = (issue: Record<string, unknown>, body: string): string[] => {
  const found = new Set<string>(body.match(PR_URL) ?? []);
  const walk = (v: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof v === "string") for (const u of v.match(PR_URL) ?? []) found.add(u);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (typeof v === "object" && v !== null)
      for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(issue.development, 0);
  return [...found];
};

type Read = {
  issue: Record<string, unknown>;
  column: Column;
  columns: Column[];
  auto: boolean;
  autoId: number | undefined;
  pendingId: number | undefined;
  skipId: number | undefined;
};

const readIssue = async (t: Tracker, projectKey: string, sequenceNumber: number): Promise<Read> => {
  const project = unwrap(await callTool(t, "get_project", { projectKey }));
  const columns = columnsOf(project);
  const issue = unwrap(await callTool(t, "get_issue_by_number", { projectKey, sequenceNumber }));
  const column = columns.find((c) => c.id === issue.columnId);
  if (column === undefined || typeof issue.id !== "number") throw new TrackerError(undefined);
  const autoId = autoLabelOf(project);
  return {
    issue,
    column,
    columns,
    autoId,
    pendingId: labelOf(project, PENDING),
    skipId: labelOf(project, SKIP),
    auto: autoId !== undefined && labelIdsOf(issue).includes(autoId),
  };
};

export type Track = <N extends "loop_ticket_opened" | "loop_ticket_acted" | "loop_ticket_chat">(
  event: N,
  props: EventProps<N>,
) => void;

const withKey = async (
  loop: LoopOptions | undefined,
  fetchImpl: typeof fetch | undefined,
): Promise<Tracker | undefined> => {
  if (!loop) return undefined;
  const key = await readKeyFile(loop.keyFile);
  return key === undefined
    ? undefined
    : { url: loop.trackerUrl, key, ...(fetchImpl ? { fetch: fetchImpl } : {}) };
};

/** One ticket for its page: the text, the acceptance criteria, the PR/MR links, and the buttons it gets. */
export const answerTicket = async (
  loop: LoopOptions | undefined,
  projectKey: unknown,
  identifier: unknown,
  track: Track,
  fetchImpl?: typeof fetch,
): Promise<LoopTicketAnswer> => {
  const parsed = parseIdentifier(projectKey, identifier);
  if (!loop) return { kind: "no_key" };
  if (!parsed) return { kind: "unreachable" };
  const tracker = await withKey(loop, fetchImpl);
  if (!tracker) return { kind: "no_key" };
  try {
    const { issue, column, columns, auto } = await readIssue(
      tracker,
      parsed.projectKey,
      parsed.sequenceNumber,
    );
    const role = roleOf(columns, column);
    const attention =
      role === "blocked" || role === "review"
        ? // The page never needed the comments to show a ticket: without them it shows it without the reason.
          await attentionOf(tracker, issue, role).catch(() => undefined)
        : undefined;
    const body = typeof issue.description === "string" ? issue.description : "";
    track("loop_ticket_opened", {});
    return {
      kind: "ok",
      ticket: {
        identifier: String(issue.identifier ?? identifier),
        title: String(issue.title ?? ""),
        priority: typeof issue.priority === "string" ? issue.priority : null,
        column: column.name,
        actions: actionsOf(column.stateType, auto, roleOf(columns, column)),
        chat: chatOf(column.stateType, role, auto),
        body,
        ...(attention ? { attention } : {}),
        acceptance: acceptanceOf(body),
        links: linksOf(issue, body),
      },
    };
  } catch {
    return { kind: "unreachable" };
  }
};

/**
 * A state button. The ticket is read again just before the write: the button is only honoured when the ticket still
 * is where the page thought it was (else `not_allowed`), and `labelIds` replaces all labels, so it is built from the
 * fresh ones. Approving without `confirmed` writes nothing.
 */
export const actOnTicket = async (
  loop: LoopOptions | undefined,
  projectKey: unknown,
  identifier: unknown,
  action: unknown,
  confirmed: unknown,
  track: Track,
  fetchImpl?: typeof fetch,
): Promise<LoopActResult> => {
  const done = (result: LoopActResult, kind?: LoopAction): LoopActResult => {
    if (kind !== undefined)
      track("loop_ticket_acted", {
        action: kind,
        result: result.kind === "ok" ? "ok" : result.reason,
      });
    return result;
  };
  if (action !== "approve" && action !== "to_backlog" && action !== "to_todo")
    return { kind: "failed", reason: "refused" };
  const parsed = parseIdentifier(projectKey, identifier);
  if (!parsed) return { kind: "failed", reason: "refused" };
  if (action === "approve" && confirmed !== true)
    return done({ kind: "failed", reason: "unconfirmed" }, action);
  const tracker = await withKey(loop, fetchImpl);
  if (!tracker) return done({ kind: "failed", reason: "no_key" }, action);
  try {
    const { issue, column, columns, auto, autoId, pendingId } = await readIssue(
      tracker,
      parsed.projectKey,
      parsed.sequenceNumber,
    );
    if (!actionsOf(column.stateType, auto, roleOf(columns, column)).includes(action))
      return done({ kind: "failed", reason: "not_allowed" }, action);
    // The first column of the kind, in the board's own order: Paused is also unstarted but is not where Todo is.
    const first = (type: string) =>
      columns
        .filter((c) => c.stateType === type)
        .sort((a, b) => Number(asRecord(a).position ?? 0) - Number(asRecord(b).position ?? 0))[0];
    const target = first(action === "to_backlog" ? "backlog" : "unstarted");
    if (target === undefined) return done({ kind: "failed", reason: "refused" }, action);
    const labels = labelIdsOf(issue);
    const args: Record<string, unknown> = { issueId: issue.id, columnId: target.id };
    if (action === "approve") {
      if (autoId === undefined) return done({ kind: "failed", reason: "refused" }, action);
      // Approved by hand, it is not waiting any more: `待批准` goes too.
      const withAuto = labels.includes(autoId) ? labels : [...labels, autoId];
      args.labelIds =
        pendingId === undefined ? withAuto : withAuto.filter((id) => id !== pendingId);
    } else if (action === "to_backlog" && autoId !== undefined && labels.includes(autoId)) {
      // Back in Backlog it is not approved any more, so Loop must not take it up from there.
      args.labelIds = labels.filter((id) => id !== autoId);
    }
    await callTool(tracker, "update_issue", args);
    return done({ kind: "ok" }, action);
  } catch (error) {
    return done({ kind: "failed", reason: failureOf(error) }, action);
  }
};

const MANY_MAX = 100;
const REASON_COMMENT_MAX = 2000;

/**
 * A batch over the tickets waiting for approval (CYC-451). Nothing is written without `confirmed`. Each ticket is read
 * again just before its write and is only touched while it still is in Backlog with `待批准` (else `skipped`); one that
 * fails does not stop the others. `labelIds` replaces all labels, so it is built from the fresh ones.
 */
export const actOnMany = async (
  loop: LoopOptions | undefined,
  projectKey: unknown,
  action: unknown,
  identifiers: unknown,
  confirmed: unknown,
  reason: unknown,
  track: (
    event: "loop_tickets_acted",
    props: { action: LoopManyAction; ok: number; skipped: number; failed: number },
  ) => void,
  fetchImpl?: typeof fetch,
): Promise<LoopManyResult> => {
  if (action !== "approve_many" && action !== "return_many")
    return { kind: "failed", reason: "refused" };
  if (
    typeof projectKey !== "string" ||
    !Array.isArray(identifiers) ||
    identifiers.length === 0 ||
    identifiers.length > MANY_MAX
  )
    return { kind: "failed", reason: "refused" };
  if (confirmed !== true) return { kind: "failed", reason: "unconfirmed" };
  const tracker = await withKey(loop, fetchImpl);
  if (!tracker) return { kind: "failed", reason: "no_key" };
  const why = typeof reason === "string" ? reason.trim().slice(0, REASON_COMMENT_MAX) : "";
  const results: LoopManyItem[] = [];
  let project: Record<string, unknown>;
  try {
    project = unwrap(await callTool(tracker, "get_project", { projectKey }));
  } catch (error) {
    return { kind: "failed", reason: failureOf(error) };
  }
  const columns = columnsOf(project);
  const autoId = labelOf(project, AUTO);
  const pendingId = labelOf(project, PENDING);
  const skipId = labelOf(project, SKIP);
  const todo = columns
    .filter((c) => c.stateType === "unstarted")
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))[0];
  const one = async (id: unknown): Promise<LoopManyItem> => {
    const identifier = String(id);
    const parsed = parseIdentifier(projectKey, id);
    if (!parsed) return { identifier, outcome: "failed", reason: "refused" };
    try {
      const issue = unwrap(
        await callTool(tracker, "get_issue_by_number", {
          projectKey,
          sequenceNumber: parsed.sequenceNumber,
        }),
      );
      const column = columns.find((c) => c.id === issue.columnId);
      if (column === undefined || typeof issue.id !== "number")
        return { identifier, outcome: "failed", reason: "refused" };
      const labels = labelIdsOf(issue);
      if (column.stateType !== "backlog" || pendingId === undefined || !labels.includes(pendingId))
        return { identifier, outcome: "skipped" };
      const kept = labels.filter((l) => l !== pendingId);
      if (action === "approve_many") {
        if (autoId === undefined || todo === undefined)
          return { identifier, outcome: "failed", reason: "refused" };
        await callTool(tracker, "update_issue", {
          issueId: issue.id,
          columnId: todo.id,
          labelIds: kept.includes(autoId) ? kept : [...kept, autoId],
        });
      } else {
        if (skipId === undefined) return { identifier, outcome: "failed", reason: "refused" };
        await callTool(tracker, "update_issue", {
          issueId: issue.id,
          labelIds: kept.includes(skipId) ? kept : [...kept, skipId],
        });
        // The labels are the decision; the comment is a courtesy, and its failure does not undo them.
        if (why !== "")
          await callTool(tracker, "add_comment", { issueId: issue.id, body: why }).catch(() => {});
      }
      return { identifier, outcome: "ok" };
    } catch (error) {
      return { identifier, outcome: "failed", reason: failureOf(error) };
    }
  };
  const wanted = [...new Set(identifiers.map(String))];
  for (const id of wanted) results.push(await one(id));
  const count = (outcome: LoopManyItem["outcome"]) =>
    results.filter((r) => r.outcome === outcome).length;
  track("loop_tickets_acted", {
    action,
    ok: count("ok"),
    skipped: count("skipped"),
    failed: count("failed"),
  });
  return { kind: "done", results };
};

/** The agent a ticket conversation starts with: its own default model decides the model (Settings). */
export const CHAT_AGENT = "codex";

/** What the chat needs of the app: the local daemon's calls, so this file does not know the manager. */
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
 * The person asked to talk about a ticket with an agent. The ticket is read again: only Backlog and Todo get a new
 * conversation (`not_allowed` otherwise, and nothing is made). The agent's default model is needed: without it nothing
 * is made, and the page says to set it in Settings (`needs_model`) instead of a session failing.
 */
export const startTicketChat = async (
  loop: LoopOptions | undefined,
  deps: ChatDeps,
  projectKey: unknown,
  identifier: unknown,
  track: Track,
  fetchImpl?: typeof fetch,
): Promise<LoopChatResult> => {
  const done = (reason: LoopChatFailure | "started", result?: LoopChatResult): LoopChatResult => {
    track("loop_ticket_chat", { result: reason });
    return result ?? { kind: "failed", reason: reason as LoopChatFailure };
  };
  const parsed = parseIdentifier(projectKey, identifier);
  if (!parsed) return { kind: "failed", reason: "refused" };
  const tracker = await withKey(loop, fetchImpl);
  if (!tracker) return done("no_key");
  let ticket: Read;
  try {
    ticket = await readIssue(tracker, parsed.projectKey, parsed.sequenceNumber);
  } catch (error) {
    return done(failureOf(error) === "offline" ? "offline" : "refused");
  }
  const role = roleOf(ticket.columns, ticket.column);
  if (chatOf(ticket.column.stateType, role, ticket.auto) !== "new") return done("not_allowed");
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
    made = await deps.createSession({
      cwd: deps.cwd,
      agent: CHAT_AGENT,
      config: { model },
    });
  } catch (error) {
    return done((error as { code?: unknown })?.code === -32000 ? "auth_required" : "failed");
  }
  if (typeof made !== "string") return done("refused");
  try {
    await deps.prompt(made, firstMessage(String(identifier)));
  } catch {
    // The session exists: its id goes with the failure, so the person can open it and say the first thing themselves.
    track("loop_ticket_chat", { result: "failed" });
    return { kind: "failed", reason: "failed", sessionId: made, locationId: deps.locationId };
  }
  return done("started", { kind: "started", locationId: deps.locationId, sessionId: made });
};

// ---- Notices: what needs a person (docs/protocol.md §17) ----

/** What Loop's `#block` writes: `自动化在「<阶段>」卡住了：<原因>`, then the Dev session's name in `「[<工单号>] Dev」`. */
const BLOCKED_COMMENT =
  /^自动化在「[^」]*」卡住了：([\s\S]*?)(?:\n\n现场已保留：Dev 会话「([^」]+)」|$)/;
/** How Loop's comments say a person must decide: the review escalated, hit its round limit, failed, or auto-merge could not be turned on. */
const ESCALATED = ["升级给人", "需要人工处理"];

/**
 * Loop writes a fixed header line after the PR line; the words are looked for there only. The line of a merged review
 * carries the review's own sentence (`merge：<summary>`), which is free text and says nothing of a person.
 */
const escalated = (afterPrLine: string): boolean => {
  const header = afterPrLine.split("\n", 1)[0] ?? "";
  return !/结论为合并（merge：/.test(header) && ESCALATED.some((w) => header.includes(w));
};
const REVIEW_COMMENT = /^已开 PR：(\S+)(?:\n([\s\S]*))?$/;
/** The longest reason or conclusion kept: they are comments, and may be long. */
const TEXT_MAX = 1500;

type Attention = NonNullable<LoopTicketDetail["attention"]>;

const cut = (text: string): string =>
  text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text;

/**
 * The comments of a ticket, newest first by time (then id): the order the tracker answers in is not relied on.
 * `list_issue_activity` is not a listed tool: it goes through `execute_read`.
 */
type Comment = { body: string; at: number | undefined };

const commentsOf = async (t: Tracker, issueId: unknown): Promise<Comment[]> => {
  const answer = await callTool(t, "execute_read", {
    name: "list_issue_activity",
    arguments: { issueId, filter: "comments", order: "desc", limit: 25 },
  });
  const items = unwrap(answer).items;
  // Not a list of comments: a failure to read, never "no comments" (that would clear or invent a Notice).
  if (!Array.isArray(items)) throw new Error("unrecognized comments");
  return items
    .map(asRecord)
    .filter((i) => typeof i.body === "string")
    .sort(
      (x, y) =>
        String(y.createdAt ?? "").localeCompare(String(x.createdAt ?? "")) ||
        Number(y.id ?? 0) - Number(x.id ?? 0),
    )
    .map((i) => {
      const at = Date.parse(String(i.createdAt ?? ""));
      return {
        body: (i.body as string)
          .replace(/^\uFEFF/, "")
          .replace(/\r\n?/g, "\n")
          .trim(),
        at: Number.isNaN(at) ? undefined : at,
      };
    });
};

/** What was read of a ticket's comments, until the ticket changes: the poll reads every Blocked and In Review ticket. */
const commentCache = new Map<string, { at: number; comments: Comment[] }>();
const CACHE_MAX = 200;
/** A cached read is used for this long at most: a comment added without the ticket's update time moving is still read. */
const CACHE_TTL_MS = 2 * 60_000;
const CONCURRENCY = 4;
/** How long before the ticket's move into Blocked Loop's own comment may have been written. */
const BLOCK_COMMENT_SLACK_MS = 2 * 60_000;

const cachedComments = async (t: Tracker, issue: Record<string, unknown>): Promise<Comment[]> => {
  const key = `${t.url}#${String(issue.id)}#${String(issue.columnId)}#${String(issue.updatedAt ?? "")}`;
  // Without an update time there is nothing to tell a changed ticket by: read it.
  const cacheable = typeof issue.updatedAt === "string";
  const hit = cacheable ? commentCache.get(key) : undefined;
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.comments;
  const comments = await commentsOf(t, issue.id);
  if (cacheable) {
    if (commentCache.size >= CACHE_MAX) commentCache.clear();
    commentCache.set(key, { at: Date.now(), comments });
  }
  return comments;
};

/** Why a Blocked or In Review ticket needs a person, from Loop's newest matching comment. Undefined: not for a person. */
export const attentionOf = async (
  t: Tracker,
  issue: Record<string, unknown>,
  role: "blocked" | "review",
): Promise<Attention | undefined> => {
  if (role === "blocked") {
    let comments: Comment[] = [];
    try {
      comments = await cachedComments(t, issue);
    } catch {
      // A comment that cannot be read does not hide a Blocked ticket: it waits for a person, reason or not.
    }
    // Loop comments, then moves the ticket: a comment from well before the ticket came to Blocked is an old reason
    // (a person moved it here by hand), and is not shown as this one's.
    const since = Date.parse(String(issue.statusSince ?? ""));
    for (const { body, at } of comments) {
      const m = BLOCKED_COMMENT.exec(body);
      if (m && at !== undefined && !Number.isNaN(since) && at < since - BLOCK_COMMENT_SLACK_MS)
        break;
      if (m)
        return {
          kind: "blocked",
          text: cut((m[1] ?? "").trim()),
          ...(m[2] ? { session: m[2] } : {}),
        };
    }
    return { kind: "blocked", text: "" };
  }
  // Whether a review needs a person is only known from the comments: a read that fails throws, so that no In Review
  // ticket is taken for an escalation on a guess (the caller reports the read as failed and keeps what it knew).
  const comments = await cachedComments(t, issue);
  // Only the newest `已开 PR：` comment counts: an older escalation is stale once a later round has passed.
  for (const { body } of comments) {
    const m = REVIEW_COMMENT.exec(body);
    if (!m) continue;
    return escalated(m[2] ?? "")
      ? { kind: "review", text: cut((m[2] ?? "").trim()), prUrl: m[1] ?? "" }
      : undefined;
  }
  // In Review for another reason (a PR merged outside the loop): nothing for a person to decide.
  return undefined;
};

const TITLE_OF_DEV = /^\[([A-Za-z0-9_-]+-\d+)\] Dev$/;

/** The ticket a Dev session belongs to, from its title `[CYC-1] Dev`. */
export const ticketOfSession = (
  title: string | undefined,
  projectKey: string,
): string | undefined => {
  const id = TITLE_OF_DEV.exec((title ?? "").trim())?.[1];
  return id?.startsWith(`${projectKey}-`) ? id : undefined;
};

export type SessionLike = {
  locationId: string;
  sessionId: string;
  title?: string;
  state: string;
  archived: boolean;
};

const URGENCY = { permission: 0, blocked: 1, review: 2 } as const;

/**
 * The Notices of a Project, most urgent first: a session waiting on an answer (it is stuck right now), then Blocked,
 * then escalated reviews. A Notice is derived from state, never stored: it is gone when its cause is.
 */
export const noticesOf = (
  tickets: Extract<LoopNotice, { kind: "blocked" | "review" }>[],
  sessions: readonly SessionLike[],
  projectKey: string,
): LoopNotice[] => {
  const waiting: LoopNotice[] = [];
  const seen = new Set<string>();
  for (const s of sessions) {
    if (s.state !== "requires_action" || s.archived) continue;
    const identifier = ticketOfSession(s.title, projectKey);
    if (identifier === undefined || seen.has(identifier)) continue;
    seen.add(identifier);
    waiting.push({
      kind: "permission",
      identifier,
      locationId: s.locationId,
      sessionId: s.sessionId,
    });
  }
  const rank = (n: LoopNotice) => URGENCY[n.kind];
  return [...waiting, ...tickets].sort((a, b) => rank(a) - rank(b));
};

/** The Blocked and escalated tickets of a Project (not the sessions: those are the daemon's). */
export const readTicketNotices = async (
  t: Tracker,
  projectKey: string,
): Promise<Extract<LoopNotice, { kind: "blocked" | "review" }>[]> => {
  const project = unwrap(await callTool(t, "get_project", { projectKey }));
  const columns = columnsOf(project);
  if (columns.length === 0) throw new Error("no columns");
  const out: Extract<LoopNotice, { kind: "blocked" | "review" }>[] = [];
  for (const column of columns) {
    const role = roleOf(columns, column);
    if (role !== "blocked" && role !== "review") continue;
    const rows = rowsOf(
      await callTool(t, "list_issues", { projectKey, columnId: column.id, limit: LIST_LIMIT }),
    );
    const read: { r: Record<string, unknown>; attention: Attention | undefined }[] = [];
    let next = 0;
    // A few at a time: a column can be long, and a rate-limited tracker fails the whole read.
    const lane = async () => {
      while (next < rows.length) {
        const r = asRecord(rows[next++]);
        read.push({ r, attention: await attentionOf(t, r, role) });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, lane));
    // The lanes finish in any order; the page's order is the tracker's.
    read.sort((x, y) => rows.indexOf(x.r) - rows.indexOf(y.r));
    for (const { r, attention } of read) {
      if (attention === undefined) continue;
      const base = { identifier: String(r.identifier ?? ""), title: String(r.title ?? "") };
      out.push(
        role === "blocked"
          ? { kind: "blocked", ...base, reason: attention.text }
          : { kind: "review", ...base, conclusion: attention.text },
      );
    }
  }
  return out;
};

/** The page asked for the Notices: the key is read, the tickets are read, the sessions come from main's own lists. */
export const answerNotices = async (
  loop: LoopOptions | undefined,
  projectKey: unknown,
  sessions: () => Promise<readonly SessionLike[]> | readonly SessionLike[],
  track: (
    event: "loop_notices_read",
    props: { permission: number; blocked: number; review: number },
  ) => void,
  fetchImpl?: typeof fetch,
): Promise<LoopNoticesAnswer> => {
  if (typeof projectKey !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(projectKey))
    return { kind: "unreachable" };
  const tracker = await withKey(loop, fetchImpl);
  if (!tracker) return { kind: "no_key" };
  try {
    const tickets = await readTicketNotices(tracker, projectKey);
    const notices = noticesOf(tickets, await sessions(), projectKey);
    const count = (kind: LoopNotice["kind"]) => notices.filter((n) => n.kind === kind).length;
    track("loop_notices_read", {
      permission: count("permission"),
      blocked: count("blocked"),
      review: count("review"),
    });
    return { kind: "ok", notices };
  } catch {
    return { kind: "unreachable" };
  }
};

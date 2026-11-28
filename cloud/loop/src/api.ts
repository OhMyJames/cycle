// The `loop/` methods (CYC-482, docs/protocol.md §17): board, runs, Notices, approve or return, status. This is the
// only place besides the pipeline that talks to itsaplan, and it answers in the shapes `@cycle/protocol` defines. A
// failure reaches the client as a fixed word (`data.reason`), never the tracker's text, a path or a token.

import {
  LOOP_API_RUNS_LIST,
  LOOP_BOARD_GET,
  LOOP_GRAPH_ACT,
  LOOP_INTENTS_RETRY,
  LOOP_NOTICES_LIST,
  LOOP_RUN_CANCEL,
  LOOP_RUN_GET,
  LOOP_STATUS,
  LOOP_TICKET_GET,
  LOOP_TICKETS_ACT,
  LOOP_TIMELINE_LIST,
  LoopApiRunsListParamsSchema,
  type LoopBoard,
  type LoopCard,
  type LoopColumn,
  type LoopGraph,
  LoopGraphActParamsSchema,
  type LoopGraphActResult,
  type LoopGraphSummary,
  LoopIntentsRetryParamsSchema,
  type LoopNotice,
  type LoopNoticeKind,
  LoopNoticesListParamsSchema,
  LoopProjectParamsSchema,
  LoopRunCancelParamsSchema,
  type LoopRunCancelResult,
  type LoopRunDetail,
  LoopRunGetParamsSchema,
  type LoopRunSummary,
  type LoopSessionKind,
  type LoopSessionRef,
  type LoopStatusResult,
  type LoopTicketAction,
  type LoopTicketAttention,
  type LoopTicketChat,
  type LoopTicketDetail,
  LoopTicketGetParamsSchema,
  type LoopTicketResult,
  LoopTicketsActParamsSchema,
  type LoopTimelineEntry,
  LoopTimelineListParamsSchema,
  type LoopTimelineListResult,
  type LoopTimelineStep,
  type LoopTimelineStepStatus,
} from "@cycle/protocol";
import { parseVerify } from "./criteria.ts";
import { SqliteStore } from "./db/store.ts";
import type { TaskGraph } from "./graph.ts";
import { toIssue } from "./plan-mcp.ts";
import { type LoopStore, type PlanRound, prUrlOf, type RunRecord } from "./store.ts";
import type { Issue, IssueComment } from "./types.ts";

/** What the API uses of itsaplan. `PlanTracker` has all of it; tests give a fake. */
export interface ApiTracker {
  getProject(): Promise<unknown>;
  listRows(columnId: number, limit: number): Promise<unknown[]>;
  get(number: number): Promise<Issue>;
  listComments(issue: Pick<Issue, "id" | "key">): Promise<IssueComment[]>;
  moveToColumn(issue: Pick<Issue, "id">, columnId: number): Promise<void>;
  setLabelIds(issue: Pick<Issue, "id">, labelIds: number[]): Promise<void>;
  comment(issue: Issue, text: string): Promise<void>;
}

/** One Project as the API sees it. Label names come from the config; ids are looked up in `get_project` each time. */
export type ProjectApi = {
  projectKey: string;
  tracker: ApiTracker;
  store: LoopStore;
  labels: { auto: string; pending: string; skip: string };
  workers: number;
  /** Cancels an active turn for `key` (CYC-484). */
  cancelRun?: (key: string) => Promise<boolean>;
};

export type LoopApi = {
  version: string;
  /** When this process started. */
  startedAt: Date;
  now: () => Date;
  /** Behaviour only: a method name and counts. */
  log: (line: string) => void;
  projects: ProjectApi[];
};

export class ApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}
const invalid = (reason: string) => new ApiError(-32602, "Invalid params", reason);

export const BOARD_TTL_MS = 15_000;
/** Done and Canceled grow without end; the board shows the latest ones only. */
const CLOSED_COLUMN_LIMIT = 30;
const OPEN_COLUMN_LIMIT = 100;
/** A reason is a summary, not the comment. */
const REASON_CHARS = 140;
const REASON_LOOKUPS = 20;
/** A run the loop says it is working on but has not reported for this long is `stuck`. */
export const STALE_HEARTBEAT_MS = 15 * 60_000;
/** A permission request nobody answered for a day is no longer news. */
const PERMISSION_TTL_MS = 24 * 60 * 60_000;

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

type Column = { id: number; name: string; stateType: LoopColumn["stateType"]; position: number };
const STATE_ORDER = ["backlog", "unstarted", "started", "completed", "canceled"] as const;

type Setup = {
  columns: Column[];
  labels: Map<number, string>;
  labelIds: Map<string, number>;
  types: Map<number, string>;
};

const setupOf = (reply: unknown): Setup => {
  const body = rec(reply);
  const data = rec(body.data ?? body);
  const columns = list(data.columns)
    .map((c) => ({
      id: Number(c.id),
      name: String(c.name ?? ""),
      stateType: String(c.stateType) as Column["stateType"],
      position: Number(c.position ?? 0),
    }))
    .filter((c) => Number.isInteger(c.id) && STATE_ORDER.includes(c.stateType))
    .sort(
      (a, b) =>
        STATE_ORDER.indexOf(a.stateType) - STATE_ORDER.indexOf(b.stateType) ||
        a.position - b.position,
    );
  const labels = new Map<number, string>();
  const labelIds = new Map<string, number>();
  for (const l of list(data.labels)) {
    labels.set(Number(l.id), String(l.name));
    labelIds.set(String(l.name).toLowerCase(), Number(l.id));
  }
  const types = new Map(list(data.issueTypes).map((t) => [Number(t.id), String(t.name)]));
  if (columns.length === 0) throw new Error("no columns");
  return { columns, labels, labelIds, types };
};

/** The short key in `CYC-12`: `get_project` takes `<team>.CYC`, an issue's key does not carry the team. */
const prefixOf = (projectKey: string): string => projectKey.split(".").pop() ?? projectKey;

const finished = (run: RunRecord): boolean => run.phase === "done";
const runState = (run: RunRecord): LoopRunSummary["state"] =>
  run.phase === "done" ? "done" : run.phase === "blocked" ? "blocked" : "active";

const summaryOf = (run: RunRecord): LoopRunSummary => ({
  key: run.key,
  title: run.title,
  kind: run.kind === "design" ? "research" : run.kind,
  phase: run.phase,
  state: runState(run),
  round: run.round,
  startedAt: run.startedAt,
  updatedAt: run.updatedAt,
});

/** A graph in short: counts by status and the node the loop is at. */
export const graphSummaryOf = (full: TaskGraph, roles?: readonly string[]): LoopGraphSummary => {
  // Counts follow what the client can see: nodes of roles it does not know are left out.
  const graph = graphOf(full, roles);
  // Progress counts Dev nodes only: a QA node that rejects is itself `passed`, and QA rounds would inflate it.
  const devNodes = graph.nodes.filter((n) => n.role !== "qa");
  const count = (status: string) => devNodes.filter((n) => n.status === status).length;
  const current = graph.nodes.find((n) => n.id === graph.currentNodeId);
  return {
    source: graph.source,
    total: devNodes.length,
    passed: count("passed"),
    failed: count("failed"),
    blocked: count("blocked"),
    running: count("running"),
    currentNodeId: graph.currentNodeId,
    currentNodeTitle: current?.title ?? null,
  };
};

/** Roles an older client does not know; it only gets nodes of these roles when it says it does. */
const NEW_ROLES: ReadonlySet<string> = new Set(["research", "design"]);

/** Summaries only carry counts and the current node's title, so they count every role. */
const SUMMARY_ROLES: readonly string[] = ["research", "design"];

/** The full graph as the API sends it: nodes in `position` order. */
const graphOf = (graph: TaskGraph, roles?: readonly string[]): LoopGraph => {
  const known = (role: string) => !NEW_ROLES.has(role) || (roles?.includes(role) ?? false);
  const dropped = new Set(graph.nodes.filter((n) => !known(n.role)).map((n) => n.id));
  const nodes = graph.nodes
    .filter((n) => !dropped.has(n.id))
    .map((n) =>
      n.dependsOn.some((d) => dropped.has(d))
        ? { ...n, dependsOn: n.dependsOn.filter((d) => !dropped.has(d)) }
        : n,
    )
    .sort((a, b) => a.position - b.position);
  return {
    ...graph,
    currentNodeId:
      graph.currentNodeId !== null && dropped.has(graph.currentNodeId) ? null : graph.currentNodeId,
    nodes,
  };
};

/** The sessions a run holds, with the role each plays. */
export const sessionsOf = (run: RunRecord): LoopSessionRef[] => {
  const out: LoopSessionRef[] = [];
  const add = (kind: LoopSessionKind, id: string | null) => {
    if (id !== null) out.push({ kind, id });
  };
  if (run.kind === "dev") {
    add("dev", run.devSessionId);
    add("qa", run.qaSessionId);
    add("review", run.dev.reviewSessionId);
  } else {
    add("research", run.devSessionId);
    add("research_qa", run.qaSessionId);
  }
  return out;
};

/** Which session a run in this phase is waiting on: the one whose turn it is. */
const sessionOfPhase = (run: RunRecord, phase: string | null): LoopSessionRef | null => {
  const all = sessionsOf(run);
  const of = (kind: LoopSessionKind) => all.find((s) => s.kind === kind) ?? null;
  const kind: LoopSessionKind | null =
    phase === "qa"
      ? "qa"
      : phase === "review"
        ? "review"
        : phase === "research_qa"
          ? "research_qa"
          : phase === "research" || phase === "publishing"
            ? "research"
            : phase === null
              ? null
              : "dev";
  return (kind === null ? null : of(kind)) ?? all[0] ?? null;
};

/** The session of a run that has this id, for a Notice written when a session waits for a person. */
export const sessionOfId = (run: RunRecord, sessionId: string): LoopSessionRef | undefined =>
  sessionsOf(run).find((s) => s.id === sessionId);

const sqlite = (store: LoopStore): SqliteStore | null =>
  store instanceof SqliteStore ? store : null;

/** Words for what went wrong with the tracker. */
const failWord = (error: unknown): "offline" | "forbidden" | "conflict" | "refused" => {
  const text = error instanceof Error ? error.message : "";
  if (/\b40[13]\b/.test(text)) return "forbidden";
  if (/\b409\b/.test(text)) return "conflict";
  if (/timed out|timeout|fetch|network|ECONN|ENOTFOUND|\b5\d\d\b|unreachable/i.test(text))
    return "offline";
  return "refused";
};

/** What a started column is for, by Loop's convention (project.ts): the 1st is In Progress, the 2nd In Review, the 3rd Blocked. */
type Role = "progress" | "review" | "blocked";
const roleOf = (setup: Setup, column: Column): Role | undefined => {
  const nth = setup.columns
    .filter((c) => c.stateType === "started")
    .findIndex((c) => c.id === column.id);
  return nth === 0 ? "progress" : nth === 1 ? "review" : nth === 2 ? "blocked" : undefined;
};

/**
 * The buttons a ticket gets: Done has none, and in Doing a ticket with `auto` is Loop's, so it has none either. The
 * exception is Blocked: Loop has stopped there and waits for a person.
 */
export const actionsOf = (
  stateType: string,
  auto: boolean,
  role?: Role,
  pending = false,
): LoopTicketAction[] => {
  if (stateType === "backlog") return pending ? ["approve", "return"] : ["approve"];
  if (stateType === "unstarted") return ["to_backlog"];
  if (stateType === "started") return auto && role !== "blocked" ? [] : ["to_backlog", "to_todo"];
  return [];
};

/**
 * What an agent may do with a ticket: Backlog and Todo, a new conversation; a Todo ticket with `auto` is queued for
 * Loop, so none. In Progress: only to look. The rest: nothing.
 */
export const chatOf = (stateType: string, role?: Role, auto = false): LoopTicketChat =>
  stateType === "backlog"
    ? "new"
    : stateType === "unstarted"
      ? auto
        ? "none"
        : "new"
      : stateType === "started" && role === "progress"
        ? "watch"
        : "none";

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
export const linksOf = (development: unknown, body: string): string[] => {
  const found = new Set<string>(body.match(PR_URL) ?? []);
  const walk = (v: unknown, depth: number) => {
    if (depth > 4) return;
    if (typeof v === "string") for (const u of v.match(PR_URL) ?? []) found.add(u);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (typeof v === "object" && v !== null)
      for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(development, 0);
  return [...found];
};

type LoopVerb = "approve" | "return" | "to_backlog" | "to_todo";

type Cached = { board: LoopBoard; at: number };

/** The board cache and the write lock live as long as the server. */
export class LoopApiHandler {
  readonly #api: LoopApi;
  readonly #boards = new Map<string, Cached>();
  readonly #reading = new Map<string, Promise<LoopBoard>>();
  readonly #writing = new Map<string, Promise<unknown>>();

  constructor(api: LoopApi) {
    this.#api = api;
  }

  #project(key: string): ProjectApi {
    const found = this.#api.projects.find((p) => p.projectKey === key);
    if (found === undefined) throw invalid("unknown_project");
    return found;
  }

  /** True for a method this handler answers. */
  static handles(method: string): boolean {
    return [
      LOOP_BOARD_GET,
      LOOP_API_RUNS_LIST,
      LOOP_RUN_GET,
      LOOP_NOTICES_LIST,
      LOOP_TICKET_GET,
      LOOP_TICKETS_ACT,
      LOOP_INTENTS_RETRY,
      LOOP_GRAPH_ACT,
      LOOP_RUN_CANCEL,
      LOOP_TIMELINE_LIST,
      LOOP_STATUS,
    ].includes(method);
  }

  async call(method: string, params: unknown): Promise<unknown> {
    const result = await this.#dispatch(method, params);
    this.#api.log(`loop api ${method} ${counts(method, result)}`);
    return result;
  }

  async #dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case LOOP_BOARD_GET: {
        const p = LoopProjectParamsSchema.safeParse(params);
        if (!p.success) throw invalid("invalid_params");
        return this.board(this.#project(p.data.project));
      }
      case LOOP_API_RUNS_LIST: {
        const p = LoopApiRunsListParamsSchema.safeParse(params);
        if (!p.success) throw invalid("invalid_params");
        const project = this.#project(p.data.project);
        const state = p.data.filter?.state;
        const runs = (await project.store.all())
          .map(summaryOf)
          .filter((r) => state === undefined || r.state === state)
          .sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true }));
        return { project: project.projectKey, runs };
      }
      case LOOP_RUN_GET: {
        const p = LoopRunGetParamsSchema.safeParse(params);
        if (!p.success) throw invalid("invalid_params");
        return this.#run(this.#project(p.data.project), p.data.key, p.data.roles);
      }
      case LOOP_NOTICES_LIST: {
        const p = LoopNoticesListParamsSchema.safeParse(params ?? {});
        if (!p.success) throw invalid("invalid_params");
        const projects =
          p.data.project === undefined ? this.#api.projects : [this.#project(p.data.project)];
        const notices = (await Promise.all(projects.map((x) => this.#notices(x)))).flat();
        notices.sort((a, b) => b.at.localeCompare(a.at));
        return { notices };
      }
      case LOOP_TICKET_GET: {
        const p = LoopTicketGetParamsSchema.safeParse(params);
        if (!p.success) throw invalid("invalid_params");
        return this.#ticket(this.#project(p.data.project), p.data.key, p.data.roles);
      }
      case LOOP_TICKETS_ACT:
        return this.#act(params);
      case LOOP_INTENTS_RETRY:
        return this.#retry(params);
      case LOOP_GRAPH_ACT:
        return this.#graphAct(params);
      case LOOP_RUN_CANCEL:
        return this.#cancelRun(params);
      case LOOP_TIMELINE_LIST: {
        const p = LoopTimelineListParamsSchema.safeParse(params);
        if (!p.success) throw invalid("invalid_params");
        return this.#timeline(this.#project(p.data.project), p.data.limit, p.data.before);
      }
      case LOOP_STATUS:
        return this.#status();
      default:
        throw new ApiError(-32601, "Method not found");
    }
  }

  // ---- board ----

  board(project: ProjectApi): Promise<LoopBoard> {
    const cached = this.#boards.get(project.projectKey);
    if (cached !== undefined && this.#api.now().getTime() - cached.at < BOARD_TTL_MS)
      return Promise.resolve(cached.board);
    // One read at a time per Project: callers that arrive during it share it.
    const reading = this.#reading.get(project.projectKey);
    if (reading !== undefined) return reading;
    const read = this.#readBoard(project)
      .then((board) => {
        this.#boards.set(project.projectKey, { board, at: this.#api.now().getTime() });
        return board;
      })
      .catch(() => {
        if (cached !== undefined) return { ...cached.board, stale: true };
        throw new ApiError(-32603, "Internal error", "tracker_unreachable");
      })
      .finally(() => this.#reading.delete(project.projectKey));
    this.#reading.set(project.projectKey, read);
    return read;
  }

  async #readBoard(project: ProjectApi): Promise<LoopBoard> {
    const setup = setupOf(await project.tracker.getProject());
    const prefix = prefixOf(project.projectKey);
    const runs = new Map((await project.store.unfinished()).map((r) => [r.key, r]));
    const pendingId = setup.labelIds.get(project.labels.pending.toLowerCase());
    let lookups = REASON_LOOKUPS;
    const columns: LoopColumn[] = [];
    for (const column of setup.columns) {
      const closed = column.stateType === "completed" || column.stateType === "canceled";
      const rows = await project.tracker.listRows(
        column.id,
        closed ? CLOSED_COLUMN_LIMIT : OPEN_COLUMN_LIMIT,
      );
      const cards: LoopCard[] = [];
      for (const row of rows) {
        let issue: Issue;
        try {
          issue = toIssue(row, prefix);
        } catch {
          continue;
        }
        const run = runs.get(issue.key);
        const pending = pendingId !== undefined && issue.labelIds.includes(pendingId);
        let pendingReason: string | null = null;
        if (pending && lookups > 0) {
          lookups--;
          pendingReason = await reasonOf(project.tracker, issue);
        }
        const graph = run === undefined ? undefined : await project.store.loadGraph(run.key);
        cards.push({
          key: issue.key,
          title: issue.title,
          type: issue.typeId === null ? null : (setup.types.get(issue.typeId) ?? null),
          priority: issue.priority,
          labels: issue.labelIds.flatMap((id) => setup.labels.get(id) ?? []),
          pendingReason,
          parent: issue.parent ? { key: issue.parent.key, title: issue.parent.title } : null,
          phase:
            run !== undefined && !finished(run) && column.stateType === "started"
              ? { name: run.phase, since: run.updatedAt }
              : null,
          ...(graph === undefined ? {} : { graph: graphSummaryOf(graph, SUMMARY_ROLES) }),
        });
      }
      columns.push({ id: column.id, name: column.name, stateType: column.stateType, cards });
    }
    return {
      project: project.projectKey,
      columns,
      stale: false,
      readAt: this.#api.now().toISOString(),
    };
  }

  // ---- ticket/get ----

  async #ticket(
    project: ProjectApi,
    key: string,
    roles?: readonly string[],
  ): Promise<LoopTicketDetail> {
    const match = /^(.+)-(\d+)$/.exec(key);
    const prefix = prefixOf(project.projectKey);
    if (match === null || match[1]?.toLowerCase() !== prefix.toLowerCase())
      throw invalid("not_found");
    let setup: Setup;
    let issue: Issue;
    try {
      setup = setupOf(await project.tracker.getProject());
      issue = await project.tracker.get(Number(match[2]));
    } catch (error) {
      if (/not found|\b404\b/i.test(error instanceof Error ? error.message : ""))
        throw invalid("not_found");
      throw new ApiError(-32603, "Internal error", "tracker_unreachable");
    }
    const column = setup.columns.find((c) => c.id === issue.columnId);
    if (column === undefined) throw new ApiError(-32603, "Internal error", "tracker_unreachable");
    const autoId = setup.labelIds.get(project.labels.auto.toLowerCase());
    const auto = autoId !== undefined && issue.labelIds.includes(autoId);
    const pendingId = setup.labelIds.get(project.labels.pending.toLowerCase());
    const pending = pendingId !== undefined && issue.labelIds.includes(pendingId);
    const role = roleOf(setup, column);
    const attention =
      role === "blocked" || role === "review"
        ? await this.#attention(project, issue.key, role).catch(() => undefined)
        : undefined;
    const graph = await project.store.loadGraph(issue.key).catch(() => undefined);
    return {
      identifier: issue.key,
      title: issue.title,
      priority: issue.priority,
      column: column.name,
      actions: actionsOf(column.stateType, auto, role, pending),
      chat: chatOf(column.stateType, role, auto),
      body: issue.description,
      ...(attention === undefined ? {} : { attention }),
      acceptance: acceptanceOf(issue.description),
      links: linksOf(issue.development, issue.description),
      ...(graph === undefined ? {} : { graph: graphOf(graph, roles) }),
    };
  }

  /** Why a Blocked or In Review ticket needs a person, from the Loop's own run and Notice records only. */
  async #attention(
    project: ProjectApi,
    key: string,
    role: "blocked" | "review",
  ): Promise<LoopTicketAttention | undefined> {
    const run = await project.store.load(key);
    if (role === "blocked") {
      if (run === undefined || run.phase !== "blocked") return undefined;
      return {
        kind: "blocked",
        text: run.blockedReason ?? "",
        session: sessionOfPhase(run, run.resumeFrom),
      };
    }
    const notice = (await this.#notices(project))
      .filter((n) => n.key === key && n.kind === "review")
      .sort((a, b) => b.at.localeCompare(a.at))[0];
    if (notice !== undefined) {
      return {
        kind: "review",
        text: notice.text,
        prUrl: run !== undefined && run.kind === "dev" ? run.dev.prUrl : null,
      };
    }
    if (
      run !== undefined &&
      run.kind === "dev" &&
      run.phase === "done" &&
      run.cleanedAt === null &&
      run.dev.reviewCommented !== undefined &&
      !run.dev.reviewCommented.endsWith(":merge")
    ) {
      return {
        kind: "review",
        text: "",
        prUrl: run.dev.prUrl,
      };
    }
    return undefined;
  }

  // ---- runs ----

  async #run(project: ProjectApi, key: string, roles?: readonly string[]): Promise<LoopRunDetail> {
    const run = await project.store.load(key);
    if (run === undefined) throw invalid("unknown_run");
    const db = sqlite(project.store);
    const events = db
      ? db.recentEvents(key, 50)
      : (await project.store.events())
          .filter((e) => e.run === key)
          .slice(-50)
          .map((e) => ({ ts: e.ts, kind: e.kind }));
    const beat = db?.heartbeats().find((h) => h.runKey === key);
    const graph = await project.store.loadGraph(key);
    return {
      ...summaryOf(run),
      blockedReason: run.blockedReason,
      sessions: sessionsOf(run),
      prUrl: run.kind === "dev" ? run.dev.prUrl : null,
      events,
      heartbeat: beat === undefined ? null : { at: beat.at, detail: beat.detail },
      ...(graph === undefined ? {} : { graph: graphOf(graph, roles) }),
    };
  }

  // ---- notices ----

  async #notices(project: ProjectApi): Promise<LoopNotice[]> {
    const id = project.projectKey;
    const out: LoopNotice[] = [];
    const runs = new Map((await project.store.all()).map((r) => [r.key, r]));
    const now = this.#api.now().getTime();
    for (const run of runs.values()) {
      if (run.phase !== "blocked") continue;
      out.push({
        id: `${id}:blocked:${run.key}`,
        project: id,
        kind: "blocked",
        key: run.key,
        session: sessionOfPhase(run, run.resumeFrom),
        text: run.blockedReason ?? "blocked",
        at: run.updatedAt,
      });
    }
    const db = sqlite(project.store);
    if (db === null) return out;
    // A stored Notice lasts until its run is finished or has moved on since (its record changed after the Notice),
    // except `review` Notices: those are written when a run finishes by escalating to In Review, so they last while
    // the run is finished, not yet cleaned up, and not updated since (e.g. put back to Todo).
    // A permission request nobody answered for a day is dropped as well.
    const latestPermission = new Map<string, number>();
    const latestReview = new Map<string, number>();
    const stored = db.notices();
    for (const n of stored) {
      if (n.kind === "permission") latestPermission.set(n.runKey, n.id);
      if (n.kind === "review") latestReview.set(n.runKey, n.id);
    }
    for (const n of stored) {
      const run = runs.get(n.runKey);
      if (n.kind === "review") {
        if (latestReview.get(n.runKey) !== n.id) continue;
        if (
          run !== undefined &&
          (!finished(run) || run.cleanedAt !== null || run.updatedAt > n.createdAt)
        ) {
          continue;
        }
      } else if (run !== undefined && (finished(run) || run.updatedAt > n.createdAt)) {
        continue;
      }
      if (n.kind === "permission") {
        if (latestPermission.get(n.runKey) !== n.id) continue;
        if (now - Date.parse(n.createdAt) > PERMISSION_TTL_MS) continue;
      }
      const kind = kindOf(n.kind);
      // A stuck intent is told below, from `intents`; a row written by an older version would be a second one.
      if (kind === null || kind === "blocked" || kind === "intent_stuck") continue;
      const session = sessionKindOf(n.sessionKind);
      out.push({
        id: `${id}:notice:${n.id}`,
        project: id,
        kind,
        // A supervisor Notice is about the Project: its `run_key` is the project key, not a work item.
        key: kind === "supervisor" ? null : n.runKey,
        session:
          session !== null && n.sessionId !== null ? { kind: session, id: n.sessionId } : null,
        text: n.text,
        at: n.createdAt,
      });
    }
    for (const intent of db.stuckIntents()) {
      out.push({
        id: `${id}:intent_stuck:${intent.id}`,
        project: id,
        kind: "intent_stuck",
        key: intent.runKey,
        session: null,
        text: `写给 tracker 的${intent.kind}已停止重试（${intent.lastError ?? "error"}）`,
        at: intent.updatedAt,
      });
    }
    for (const beat of db.heartbeats()) {
      const run = runs.get(beat.runKey);
      if (run === undefined || run.phase === "done" || run.phase === "blocked") continue;
      if (now - Date.parse(beat.at) < STALE_HEARTBEAT_MS) continue;
      out.push({
        id: `${id}:stuck:${run.key}`,
        project: id,
        kind: "stuck",
        key: run.key,
        session: sessionOfPhase(run, run.phase),
        text: `no sign of life since ${beat.at}`,
        at: beat.at,
      });
    }
    return out;
  }

  // ---- intents/retry ----

  #retry(raw: unknown): { retried: number } {
    const p = LoopIntentsRetryParamsSchema.safeParse(raw);
    if (!p.success) {
      const given = rec(raw);
      const missing =
        typeof given.actor !== "string" ||
        given.actor === "" ||
        (given.actorKind !== "desktop" && given.actorKind !== "operator");
      throw invalid(missing ? "actor_required" : "invalid_params");
    }
    const { id, key, actor, actorKind } = p.data;
    const project = this.#project(p.data.project);
    const db = sqlite(project.store);
    if (db === null) throw invalid("invalid_params");
    const retried = db.transaction((tx) => {
      const stuck = tx.stuckIntents();
      if (id !== undefined && !tx.intentExists(id)) throw invalid("not_found");
      const mine = stuck.filter((i) =>
        id !== undefined
          ? i.id === id
          : i.runKey === key ||
            `${prefixOf(project.projectKey)}-${rec(i.payload).issueNumber}`.toLowerCase() ===
              key?.toLowerCase(),
      );
      const done = tx.requeueIntents(mine.map((i) => i.id));
      for (const intent of mine.filter((i) => done.includes(i.id)))
        tx.action(intent.runKey, "intent_retry", { intentId: intent.id, actor, actorKind });
      return done.length;
    });
    return { retried };
  }

  // ---- graph/act ----

  /** `retry_node`, `skip_node`, `edit_node`: checked and written in one transaction, with its audit row. */
  #graphAct(raw: unknown): LoopGraphActResult {
    const p = LoopGraphActParamsSchema.safeParse(raw);
    if (!p.success) {
      const given = rec(raw);
      const missing =
        typeof given.actor !== "string" ||
        given.actor === "" ||
        (given.actorKind !== "desktop" && given.actorKind !== "operator");
      throw invalid(missing ? "actor_required" : "invalid_params");
    }
    const { key, nodeId, action, actor, actorKind } = p.data;
    const project = this.#project(p.data.project);
    const db = sqlite(project.store);
    if (db === null) throw invalid("invalid_params");
    if (p.data.verify?.some((c) => parseVerify(c) === undefined)) throw invalid("invalid_verify");
    const result = db.transaction((tx) => {
      const run = tx.load(key);
      if (run === undefined) throw invalid("unknown_run");
      const graph = tx.loadGraph(key);
      if (graph === undefined) throw invalid("no_graph");
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (node === undefined) throw invalid("node_not_found");
      const allowed =
        action === "edit_node" ? ["pending", "blocked", "failed"] : ["blocked", "failed"];
      if (!allowed.includes(node.status)) throw invalid("node_not_allowed");
      const fields: string[] = [];
      let next = node;
      if (action === "retry_node")
        next = { ...node, status: "pending", rounds: 0, lastError: null, sessionId: null };
      else if (action === "skip_node") next = { ...node, status: "skipped" };
      else {
        next = { ...node };
        if (p.data.title !== undefined) {
          next.title = p.data.title;
          fields.push("title");
        }
        if (p.data.goal !== undefined) {
          next.goal = p.data.goal;
          fields.push("goal");
        }
        if (p.data.verify !== undefined) {
          next.verify = p.data.verify;
          fields.push("verify");
        }
      }
      const saved = tx.saveGraph({
        ...graph,
        revision: graph.revision + 1,
        nodes: graph.nodes.map((n) => (n.id === nodeId ? next : n)),
      });
      let phase: string = run.phase;
      if (run.phase === "blocked") {
        // Only dev runs have a graph_plan phase; research and design runs resume at the node's phase.
        const resumed =
          run.kind === "dev" ? "graph_plan" : node.role === "qa" ? "research_qa" : "research";
        phase = resumed;
        tx.save({ ...run, phase: resumed, blockedReason: null, resumeFrom: null });
      }
      tx.action(key, `graph_${action}`, {
        nodeId,
        actor,
        actorKind,
        ...(fields.length > 0 ? { fields } : {}),
      });
      return { key, nodeId, action, phase, graph: graphOf(saved, p.data.roles) };
    });
    this.#boards.delete(project.projectKey);
    return result;
  }

  // ---- tickets/act ----

  async #act(raw: unknown): Promise<{ results: LoopTicketResult[] }> {
    const p = LoopTicketsActParamsSchema.safeParse(raw);
    if (!p.success) {
      const given = rec(raw);
      const missing =
        typeof given.actor !== "string" ||
        given.actor === "" ||
        (given.actorKind !== "desktop" && given.actorKind !== "operator");
      throw invalid(missing ? "actor_required" : "invalid_params");
    }
    const { verb, keys, reason, confirmed, actor, actorKind } = p.data;
    const project = this.#project(p.data.project);
    if (verb === "approve" && !confirmed) throw invalid("unconfirmed");
    // One write call at a time per Project: two clients approving the same card must not both write.
    const before = this.#writing.get(project.projectKey) ?? Promise.resolve();
    const run = before.then(() => this.#actAll(project, verb, keys, reason, actor, actorKind));
    this.#writing.set(
      project.projectKey,
      run.catch(() => {}),
    );
    this.#boards.delete(project.projectKey);
    return { results: await run };
  }

  async #actAll(
    project: ProjectApi,
    verb: LoopVerb,
    keys: string[],
    reason: string | undefined,
    actor: string,
    actorKind: string,
  ): Promise<LoopTicketResult[]> {
    const db = sqlite(project.store);
    const record = (key: string, result: LoopTicketResult) =>
      db?.action(key, `ticket_${verb}`, {
        actor,
        actorKind,
        status: result.status,
        ...("reason" in result ? { reason: result.reason } : {}),
      });
    // Label and column ids are read from the tracker for every call: a renamed label or moved column still works.
    let setup: Setup | null = null;
    let setupFailure: "offline" | "forbidden" | "conflict" | "refused" = "offline";
    try {
      setup = setupOf(await project.tracker.getProject());
    } catch (error) {
      setupFailure = failWord(error);
    }
    const results: LoopTicketResult[] = [];
    const prefix = prefixOf(project.projectKey);
    for (const key of [...new Set(keys)]) {
      let result: LoopTicketResult;
      try {
        result =
          setup === null
            ? { key, status: "failed", reason: setupFailure }
            : await this.#actOne(project, setup, prefix, verb, key, reason, actor, actorKind);
      } catch (error) {
        result = { key, status: "failed", reason: failWord(error) };
      }
      record(key, result);
      results.push(result);
    }
    return results;
  }

  async #actOne(
    project: ProjectApi,
    setup: Setup,
    prefix: string,
    verb: LoopVerb,
    key: string,
    reason: string | undefined,
    actor: string,
    actorKind: string,
  ): Promise<LoopTicketResult> {
    const match = /^(.+)-(\d+)$/.exec(key);
    if (match === null || match[1]?.toLowerCase() !== prefix.toLowerCase())
      return { key, status: "skipped", reason: "not_found" };
    if (verb === "to_backlog" || verb === "to_todo")
      return this.#moveOne(project, setup, verb, key, Number(match[2]), reason, actor, actorKind);
    const backlog = setup.columns.find((c) => c.stateType === "backlog");
    const todo = setup.columns.find((c) => c.stateType === "unstarted");
    const label = (name: string) => setup.labelIds.get(name.toLowerCase());
    const pending = label(project.labels.pending);
    const auto = label(project.labels.auto);
    const skip = label(project.labels.skip);
    if (
      backlog === undefined ||
      todo === undefined ||
      pending === undefined ||
      (verb === "approve" ? auto === undefined : skip === undefined)
    )
      return { key, status: "failed", reason: "label_missing" };
    // Read again just before writing: a person may have moved it since the board was read.
    let issue: Issue;
    try {
      issue = await project.tracker.get(Number(match[2]));
    } catch (error) {
      if (/not found|\b404\b/i.test(error instanceof Error ? error.message : ""))
        return { key, status: "skipped", reason: "not_found" };
      throw error;
    }
    if (issue.columnId !== backlog.id) return { key, status: "skipped", reason: "not_in_backlog" };
    if (!issue.labelIds.includes(pending)) return { key, status: "skipped", reason: "not_pending" };
    const without = issue.labelIds.filter((id) => id !== pending);
    const wanted = verb === "approve" ? (auto as number) : (skip as number);
    const next = without.includes(wanted) ? without : [...without, wanted];
    // Labels first, while the card is still in Backlog: a failed move leaves a card the loop does not take.
    await project.tracker.setLabelIds(issue, next);
    if (verb === "approve") {
      try {
        await project.tracker.moveToColumn(issue, todo.id);
      } catch (error) {
        await project.tracker.setLabelIds(issue, issue.labelIds).catch(() => {});
        throw error;
      }
    }
    const who = actor.replace(/\s+/g, " ").trim();
    const via = actorKind === "desktop" ? "在桌面端" : "经运营 agent";
    const word = verb === "approve" ? "批准" : "退回";
    const text =
      verb === "approve"
        ? `${reason !== undefined && reason !== "" ? `${reason}\n\n` : ""}由 ${who} ${via}${word}`
        : reason !== undefined && reason !== ""
          ? `${reason}\n\n由 ${who} ${via}${word}`
          : null;
    // The write has happened; a comment that fails does not undo it.
    if (text !== null) await project.tracker.comment(issue, text).catch(() => {});
    return { key, status: "ok" };
  }

  /** `to_backlog` / `to_todo`: read again, write only when the ticket still has that button. */
  async #moveOne(
    project: ProjectApi,
    setup: Setup,
    verb: "to_backlog" | "to_todo",
    key: string,
    number: number,
    reason: string | undefined,
    actor: string,
    actorKind: string,
  ): Promise<LoopTicketResult> {
    let issue: Issue;
    try {
      issue = await project.tracker.get(number);
    } catch (error) {
      if (/not found|\b404\b/i.test(error instanceof Error ? error.message : ""))
        return { key, status: "skipped", reason: "not_found" };
      throw error;
    }
    const column = setup.columns.find((c) => c.id === issue.columnId);
    const autoId = setup.labelIds.get(project.labels.auto.toLowerCase());
    const auto = autoId !== undefined && issue.labelIds.includes(autoId);
    if (
      column === undefined ||
      !actionsOf(column.stateType, auto, roleOf(setup, column)).includes(verb)
    )
      return { key, status: "skipped", reason: "not_allowed" };
    // The first column of the kind in board order (`setup.columns` is sorted so): Paused is unstarted but not Todo.
    const target = setup.columns.find(
      (c) => c.stateType === (verb === "to_backlog" ? "backlog" : "unstarted"),
    );
    if (target === undefined) return { key, status: "failed", reason: "refused" };
    const dropAuto = verb === "to_backlog" && autoId !== undefined && auto;
    // Labels first: back in Backlog it must not be approved any more, even if the move then fails.
    if (dropAuto)
      await project.tracker.setLabelIds(
        issue,
        issue.labelIds.filter((id) => id !== autoId),
      );
    try {
      await project.tracker.moveToColumn(issue, target.id);
    } catch (error) {
      if (dropAuto) await project.tracker.setLabelIds(issue, issue.labelIds).catch(() => {});
      throw error;
    }
    if (reason !== undefined && reason !== "") {
      const who = actor.replace(/\s+/g, " ").trim();
      const via = actorKind === "desktop" ? "在桌面端" : "经运营 agent";
      const word = verb === "to_backlog" ? "退回 Backlog" : "放回 Todo";
      await project.tracker.comment(issue, `${reason}\n\n由 ${who} ${via}${word}`).catch(() => {});
    }
    return { key, status: "ok" };
  }

  async #cancelRun(params: unknown): Promise<LoopRunCancelResult> {
    const p = LoopRunCancelParamsSchema.safeParse(params);
    if (!p.success) throw invalid("invalid_params");
    const project = this.#project(p.data.project);
    const cancelled = (await project.cancelRun?.(p.data.key)) ?? false;
    const db = sqlite(project.store);
    db?.action(p.data.key, "run_cancel", {
      actor: p.data.actor,
      actorKind: p.data.actorKind,
      cancelled,
    });
    return { cancelled };
  }

  // ---- timeline (CYC-534) ----

  async #timeline(
    project: ProjectApi,
    limit: number,
    before: string | undefined,
  ): Promise<LoopTimelineListResult> {
    const [runs, plans] = await Promise.all([project.store.all(), project.store.plans()]);
    const known = new Set<string>();
    const addKnown = (id: string | null | undefined) => {
      if (id !== null && id !== undefined && id !== "") known.add(id);
    };
    const db = sqlite(project.store);
    if (db !== null) {
      for (const notice of db.notices()) addKnown(notice.sessionId);
    }

    const entries: LoopTimelineEntry[] = [];
    for (const run of runs) {
      for (const replaced of run.replacedSessions) addKnown(replaced);
      const graph = await project.store.loadGraph(run.key);
      const steps: LoopTimelineStep[] = [];
      const seenSessions = new Set<string>();
      if (graph !== undefined) {
        const ordered = [...graph.nodes].sort((a, b) => a.position - b.position);
        for (const node of ordered) {
          addKnown(node.sessionId);
          if (node.sessionId !== null) seenSessions.add(node.sessionId);
          steps.push({
            id: `node:${node.id}`,
            label: node.title,
            role: node.role === "design" ? "research" : node.role, // the timeline has no design role
            status: node.status,
            sessionId: node.sessionId,
            startedAt: node.startedAt,
            finishedAt: node.finishedAt,
            summary: node.summary,
            error: node.lastError,
            dependsOn: node.dependsOn.map((dep) => `node:${dep}`),
          });
        }
      }
      const activeSession = sessionOfPhase(
        run,
        run.phase === "blocked" ? (run.resumeFrom ?? run.phase) : run.phase,
      );
      for (const ref of sessionsOf(run)) {
        addKnown(ref.id);
        if (seenSessions.has(ref.id)) continue;
        seenSessions.add(ref.id);
        const status: LoopTimelineStepStatus =
          run.phase === "done"
            ? "passed"
            : run.phase === "blocked"
              ? activeSession?.id === ref.id
                ? "blocked"
                : "passed"
              : activeSession?.id === ref.id
                ? "running"
                : "passed";
        steps.push({
          id: `session:${ref.kind}:${ref.id}`,
          label: ref.kind,
          role: ref.kind,
          status,
          sessionId: ref.id,
          startedAt: null,
          finishedAt: null,
          summary: null,
          error: null,
          dependsOn: [],
        });
      }
      entries.push({
        entryKind: "run",
        id: `run:${run.key}`,
        key: run.key,
        title: run.title,
        kind: run.kind === "design" ? "research" : run.kind,
        phase: run.phase,
        state: runState(run),
        round: run.round,
        startedAt: run.startedAt,
        updatedAt: run.updatedAt,
        prUrl: prUrlOf(run),
        blockedReason: run.blockedReason,
        graph: graph === undefined ? null : graphSummaryOf(graph, SUMMARY_ROLES),
        steps,
      });
    }

    for (const plan of plans) {
      addKnown(plan.triageSessionId);
      for (const item of plan.queue) {
        addKnown(item.shapeSessionId);
        addKnown(item.qaSessionId);
      }
      entries.push(planTimelineEntry(plan));
    }

    entries.sort((a, b) =>
      b.updatedAt > a.updatedAt
        ? 1
        : b.updatedAt < a.updatedAt
          ? -1
          : b.id > a.id
            ? 1
            : b.id < a.id
              ? -1
              : 0,
    );

    let filtered = entries;
    if (before !== undefined) {
      const sep = before.indexOf("|");
      const cursorTs = sep === -1 ? before : before.slice(0, sep);
      const cursorId = sep === -1 ? "" : before.slice(sep + 1);
      filtered = entries.filter(
        (e) =>
          e.updatedAt < cursorTs ||
          (e.updatedAt === cursorTs && cursorId !== "" && e.id < cursorId),
      );
    }

    const page = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    const last = page[page.length - 1];
    return {
      project: project.projectKey,
      entries: page,
      hasMore,
      nextBefore: hasMore && last !== undefined ? `${last.updatedAt}|${last.id}` : null,
      knownSessionIds: [...known],
    };
  }

  // ---- status ----

  async #status(): Promise<LoopStatusResult> {
    const projects = await Promise.all(
      this.#api.projects.map(async (p) => ({
        project: p.projectKey,
        workers: p.workers,
        working: (await p.store.unfinished())
          .filter((r) => r.phase !== "blocked" && r.phase !== "done")
          .map((r) => ({
            key: r.key,
            kind: r.kind === "design" ? "research" : r.kind,
            phase: r.phase,
          })),
      })),
    );
    return {
      version: this.#api.version,
      restartedAt: this.#api.startedAt.toISOString(),
      projects,
    };
  }
}

/** A short summary of why a card waits for approval: the first line of the latest comment. */
const reasonOf = async (tracker: ApiTracker, issue: Issue): Promise<string | null> => {
  try {
    const comments = await tracker.listComments(issue);
    const last = comments[comments.length - 1];
    const line = last?.body
      .split("\n")
      .map((l) => l.replace(/^[#>\s*-]+/, "").trim())
      .find((l) => l !== "");
    return line === undefined ? null : line.slice(0, REASON_CHARS);
  } catch {
    return null;
  }
};

const NOTICE_KINDS: LoopNoticeKind[] = [
  "permission",
  "blocked",
  "review",
  "stuck",
  "intent_stuck",
  "supervisor",
  "operator",
];
const kindOf = (kind: string): LoopNoticeKind | null =>
  (NOTICE_KINDS as string[]).includes(kind) ? (kind as LoopNoticeKind) : null;
const SESSION_KINDS = [
  "dev",
  "qa",
  "review",
  "research",
  "research_qa",
  "triage",
  "shape",
  "shape_qa",
];
const sessionKindOf = (kind: string | null): LoopSessionKind | null =>
  kind !== null && SESSION_KINDS.includes(kind) ? (kind as LoopSessionKind) : null;

const planTimelineEntry = (plan: PlanRound): Extract<LoopTimelineEntry, { entryKind: "plan" }> => ({
  entryKind: "plan",
  id: `plan:${plan.id}`,
  planId: plan.id,
  phase: plan.phase,
  state: plan.phase === "finished" || plan.phase === "abandoned" ? "done" : "active",
  startedAt: plan.startedAt,
  updatedAt: plan.updatedAt,
  endedAt: plan.endedAt,
  candidateCount: plan.candidates.length,
  stoppedReason: plan.stoppedReason,
  triageSessionId: plan.triageSessionId,
  items: plan.queue.map((item) => ({
    key: item.key,
    state: item.state,
    round: item.round,
    resultKind: item.output?.kind ?? null,
    splitCount: item.created.length,
    stoppedReason: item.stoppedReason,
    shapeSessionId: item.shapeSessionId,
    qaSessionId: item.qaSessionId,
  })),
});

/** The counts a call reports, and nothing of what is in it. */
const counts = (method: string, result: unknown): string => {
  const r = rec(result);
  if (method === LOOP_TICKETS_ACT) {
    const results = list(r.results);
    const n = (s: string) => results.filter((x) => x.status === s).length;
    return `ok=${n("ok")} skipped=${n("skipped")} failed=${n("failed")}`;
  }
  if (method === LOOP_INTENTS_RETRY) return `retried=${r.retried}`;
  if (method === LOOP_NOTICES_LIST) return `notices=${list(r.notices).length}`;
  if (method === LOOP_TICKET_GET || method === LOOP_GRAPH_ACT) return "ok";
  if (method === LOOP_API_RUNS_LIST) return `runs=${list(r.runs).length}`;
  if (method === LOOP_TIMELINE_LIST)
    return `entries=${list(r.entries).length} hasMore=${r.hasMore === true}`;
  if (method === LOOP_BOARD_GET)
    return `cards=${list(r.columns).reduce((n, c) => n + list(c.cards).length, 0)} stale=${r.stale === true}`;
  return "ok";
};

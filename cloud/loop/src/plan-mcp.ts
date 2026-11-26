// `Tracker` over the Itsaplan MCP endpoint (JSON-RPC `tools/call`). The key comes from the config file and goes nowhere
// else: not into a session, not into a command's environment, not into a log line.
//
// `get_issue_by_number` on infra.CYC returns `typeId` and `subtasks` (`{ id, sequenceNumber, identifier, title,
// columnId, typeId, archived }[]`). `toIssue` reads these defensively and returns `null` when missing so selection
// fails closed rather than treating an unknown issue as an eligible leaf.

import type { LoopFields } from "./project.ts";
import type {
  BacklogRow,
  Config,
  DocumentEntry,
  Issue,
  IssueComment,
  IssueDocument,
  LoopPhase,
  NewIssue,
  PlanningConfig,
  PlanningTracker,
  Priority,
  Stage,
  Tracker,
} from "./types.ts";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const parseOptionalInt = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isInteger(n) ? n : null;
  }
  return null;
};

/** The parent's number and title, when the reply carries them; nothing otherwise (CYC-322). */
const parentOf = (raw: unknown, projectKey: string): Pick<Issue, "parent"> => {
  const p = asRecord(raw);
  const number = parseOptionalInt(p.sequenceNumber);
  if (number === null) return {};
  return { parent: { number, key: `${projectKey}-${number}`, title: String(p.title ?? "") } };
};

/** The links with the other issue's key and title, when the reply carries them; nothing otherwise (CYC-322). */
const linksOf = (raw: unknown, projectKey: string): Pick<Issue, "links"> => {
  if (!Array.isArray(raw)) return {};
  const links = raw.map(asRecord).flatMap((l) => {
    const other = asRecord(l.issue);
    const number = parseOptionalInt(other.sequenceNumber);
    if (number === null || typeof l.kind !== "string") return [];
    return [
      {
        kind: l.kind,
        direction: String(l.direction ?? ""),
        key: `${projectKey}-${number}`,
        title: String(other.title ?? ""),
      },
    ];
  });
  return { links };
};

export const toIssue = (raw: unknown, projectKey: string): Issue => {
  const r = asRecord(raw);
  const number = Number(r.sequenceNumber ?? r.number);
  const id = Number(r.id);
  if (!Number.isInteger(number) || !Number.isInteger(id))
    throw new Error("unexpected issue shape from the tracker");
  const labelIds = Array.isArray(r.labelIds)
    ? r.labelIds.map(Number)
    : Array.isArray(r.labels)
      ? r.labels.map((l) => Number(asRecord(l).id ?? l))
      : [];
  const priority = typeof r.priority === "string" ? (r.priority as Priority) : null;
  const typeId = parseOptionalInt(r.typeId ?? asRecord(r.type).id);
  const parsedSubtaskCount = parseOptionalInt(r.subtaskCount);
  // Any non-archived child (including Done or Canceled) still marks the parent as a split container, not a leaf.
  // When the payload omits both `subtasks` and `subtaskCount`, return `null` so `pickNext` fails closed.
  const subtaskCount = Array.isArray(r.subtasks)
    ? r.subtasks.filter((s) => asRecord(s).archived !== true).length
    : parsedSubtaskCount !== null && parsedSubtaskCount >= 0
      ? parsedSubtaskCount
      : null;
  // Blockers are `blocks` links pointing inward (the other issue blocks this one); `relates` and outward links do not
  // matter. No `links` field at all means unknown, so `null` and `pickNext` fails closed.
  const blockerColumnIds = Array.isArray(r.links)
    ? r.links
        .map(asRecord)
        .filter((l) => l.kind === "blocks" && l.direction === "inward")
        .map((l) => parseOptionalInt(l.columnId ?? asRecord(l.issue).columnId) ?? -1)
    : null;
  return {
    id,
    number,
    key: `${projectKey}-${number}`,
    title: String(r.title ?? ""),
    description: String(r.description ?? ""),
    priority,
    createdAt: String(r.createdAt ?? ""),
    columnId: Number(r.columnId ?? asRecord(r.column).id),
    labelIds,
    typeId,
    subtaskCount,
    blockerColumnIds,
    parentId: parseOptionalInt(r.parentId ?? asRecord(r.parent).id),
    ...parentOf(r.parent, projectKey),
    ...linksOf(r.links, projectKey),
  };
};

/** A reply is `{ ok, status, data }`; older shapes carry the payload at the top. */
const payload = (raw: unknown): unknown => {
  const body = asRecord(raw);
  return body.data !== undefined ? body.data : raw;
};

/** The id (and number) of what a create returned. Thrown when missing: the caller saves them to resume without duplicating. */
const createdId = (raw: unknown, tool: string): number => {
  const id = parseOptionalInt(asRecord(payload(raw)).id);
  if (id === null) throw new Error(`tracker ${tool}: no id in the reply`);
  return id;
};

const FIELD_WRITE_TIMEOUT_MS = 10_000;
/** `list_issues` returns at most 500 and has no cursor. */
const BACKLOG_LIMIT = 500;
/** Comments per `list_issue_activity` page (its maximum), and pages read before giving up. */
const ACTIVITY_PAGE = 100;
const ACTIVITY_PAGES = 20;

/** A comment from `list_issue_activity`, with its replies (which may also come nested under `replies`). */
const toComments = (raw: unknown): IssueComment[] => {
  const r = asRecord(raw);
  const id = parseOptionalInt(r.id);
  const replies = Array.isArray(r.replies) ? r.replies.flatMap(toComments) : [];
  if (id === null || (r.kind !== undefined && r.kind !== "comment")) return replies;
  return [
    {
      id,
      replyToId: parseOptionalInt(r.replyToId),
      authorId: String(r.actorUserId ?? r.authorId ?? ""),
      authorName: String(r.actorName ?? r.authorName ?? ""),
      body: String(r.body ?? ""),
      createdAt: String(r.createdAt ?? ""),
    },
    ...replies,
  ];
};

export class PlanTracker implements Tracker {
  readonly #url: string;
  readonly #key: string;
  readonly #project: string;
  #columns: Config["columns"] | undefined;
  #backlog: number | undefined;
  #loopFields: LoopFields | null = null;

  /** `columns` may be left out until `setColumns` is called with what `get_project` resolved. */
  constructor(options: {
    url: string;
    key: string;
    projectKey: string;
    columns?: Config["columns"];
  }) {
    this.#url = options.url;
    this.#key = options.key;
    this.#project = options.projectKey;
    this.#columns = options.columns;
  }

  setColumns(columns: Config["columns"]): void {
    this.#columns = columns;
  }

  /** The Backlog column, resolved only when the planning node is on (CYC-322). */
  setBacklogColumn(columnId: number): void {
    this.#backlog = columnId;
  }

  /** The ids of the phase fields; `null` (the default) means the project has none and nothing is written. */
  setLoopFields(fields: LoopFields | null): void {
    this.#loopFields = fields;
  }

  /** The project's custom fields (`list_custom_fields`). */
  async getCustomFields(): Promise<unknown> {
    return this.#tool("execute_read", "list_custom_fields", { projectKey: this.#project });
  }

  /**
   * A tool by its own name. A key whose catalog lists only the most used tools reaches the rest through
   * `execute_read` or `execute_write` instead, so an unknown name is tried once more that way.
   */
  async #tool(
    via: "execute_read" | "execute_write",
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    try {
      return await this.#call(name, args, timeoutMs);
    } catch (error) {
      if (!(error instanceof Error && /unknown tool/i.test(error.message))) throw error;
      return this.#call(via, { name, arguments: args }, timeoutMs);
    }
  }

  /** Both fields in one go, each request bounded in time so a hung tracker cannot hold the queue for long. */
  async setLoopPhase(issue: Issue, phase: LoopPhase | null, at: Date): Promise<void> {
    const f = this.#loopFields;
    if (f === null) return;
    const set = async (fieldId: number, rest: Record<string, unknown>) => {
      await this.#tool(
        "execute_write",
        "set_issue_field_value",
        { issueId: issue.id, fieldId, ...rest },
        FIELD_WRITE_TIMEOUT_MS,
      );
    };
    if (phase === null) {
      await set(f.phaseFieldId, { optionIds: [] });
      await set(f.startedFieldId, { value: null });
      return;
    }
    // The research options are optional in the project: without one, that phase is not mirrored at all.
    const optionId = f.optionIds[phase];
    if (optionId === undefined) return;
    await set(f.phaseFieldId, { optionIds: [optionId] });
    await set(f.startedFieldId, { value: at.toISOString() });
  }

  #column(stage: Stage): number {
    const id = this.#columns?.[stage];
    if (id === undefined) throw new Error("the project's columns are not resolved yet");
    return id;
  }

  /** The project's setup: columns, issue types, labels (`get_project`). */
  async getProject(): Promise<unknown> {
    return this.#call("get_project", { projectKey: this.#project });
  }

  async #call(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const response = await fetch(this.#url, {
      ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.#key}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    if (!response.ok) throw new Error(`tracker ${name}: HTTP ${response.status}`);
    const body = asRecord(JSON.parse(await this.#json(response)));
    if (body.error !== undefined) throw new Error(`tracker ${name}: ${JSON.stringify(body.error)}`);
    const result = asRecord(body.result);
    const text = (result.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
    if (result.isError === true) throw new Error(`tracker ${name}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** A reply is plain JSON or one server-sent event. */
  async #json(response: Response): Promise<string> {
    const text = await response.text();
    if (!text.startsWith("event:") && !text.startsWith("data:")) return text;
    return text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
  }

  async listTodo(): Promise<Issue[]> {
    return this.#listColumn(this.#column("todo"), 100);
  }

  async listInProgress(): Promise<Issue[]> {
    return this.#listColumn(this.#column("inProgress"), 100);
  }

  /** `list_issues` has no paging: a Backlog that fills the page is refused rather than read in part. */
  async listBacklog(): Promise<Issue[]> {
    if (this.#backlog === undefined)
      throw new Error("the project's Backlog column is not resolved");
    const issues = await this.#listColumn(this.#backlog, BACKLOG_LIMIT);
    if (issues.length >= BACKLOG_LIMIT)
      throw new Error(`the Backlog has ${BACKLOG_LIMIT} or more issues; list_issues cannot page`);
    return issues;
  }

  /**
   * The Backlog in one `list_issues` call, rows as listed (no `get` per issue, so no bodies): what the planning node
   * compares to see whether the Backlog changed (CYC-322).
   */
  async listBacklogRows(): Promise<BacklogRow[]> {
    if (this.#backlog === undefined)
      throw new Error("the project's Backlog column is not resolved");
    const rows = await this.#rows(this.#backlog, BACKLOG_LIMIT);
    if (rows.length >= BACKLOG_LIMIT)
      throw new Error(`the Backlog has ${BACKLOG_LIMIT} or more issues; list_issues cannot page`);
    return rows.map(asRecord).flatMap((r) => {
      const number = parseOptionalInt(r.sequenceNumber ?? r.number);
      const id = parseOptionalInt(r.id);
      if (number === null || id === null) return [];
      return [
        {
          id,
          key: `${this.#project}-${number}`,
          number,
          title: String(r.title ?? ""),
          typeId: parseOptionalInt(r.typeId),
          labelIds: Array.isArray(r.labelIds) ? r.labelIds.map(Number) : [],
          columnId: Number(r.columnId),
          updatedAt: String(r.updatedAt ?? ""),
        },
      ];
    });
  }

  async #listColumn(columnId: number, limit: number): Promise<Issue[]> {
    const rows = await this.#rows(columnId, limit);
    // The list may not carry the description: read each in full.
    return Promise.all(
      rows.map((row) => this.get(Number(asRecord(row).sequenceNumber ?? asRecord(row).number))),
    );
  }

  async #rows(columnId: number, limit: number): Promise<unknown[]> {
    const listed = asRecord(
      await this.#call("list_issues", { projectKey: this.#project, columnId, limit }),
    );
    const rows = Array.isArray(listed.data)
      ? listed.data
      : Array.isArray(asRecord(listed.data).issues)
        ? (asRecord(listed.data).issues as unknown[])
        : Array.isArray(listed.issues)
          ? listed.issues
          : Array.isArray(listed)
            ? listed
            : undefined;
    if (rows === undefined)
      throw new Error(`unrecognized list_issues reply: ${JSON.stringify(listed).slice(0, 300)}`);
    return rows;
  }

  async get(number: number): Promise<Issue> {
    const raw = await this.#call("get_issue_by_number", {
      projectKey: this.#project,
      sequenceNumber: number,
    });
    const body = asRecord(raw);
    return toIssue(
      asRecord(body.data).id !== undefined ? body.data : (body.issue ?? raw),
      this.#project,
    );
  }

  async move(issue: Issue, stage: Stage): Promise<void> {
    await this.#call("update_issue", { issueId: issue.id, columnId: this.#column(stage) });
  }

  async comment(issue: Issue, text: string): Promise<void> {
    await this.#call("add_comment", { issueId: issue.id, body: text });
  }

  async listDocuments(): Promise<DocumentEntry[]> {
    const raw = payload(
      await this.#tool("execute_read", "list_documents", { projectKey: this.#project }),
    );
    if (!Array.isArray(raw))
      throw new Error(`unrecognized list_documents reply: ${JSON.stringify(raw).slice(0, 300)}`);
    return raw.map(asRecord).flatMap((d) => {
      const id = parseOptionalInt(d.id);
      return id === null
        ? []
        : [{ id, title: String(d.title ?? ""), parentId: parseOptionalInt(d.parentId) }];
    });
  }

  /**
   * list_issue_documents gives each linked document's `documentId`, `title` and `archived` only; its version and lock
   * are on the document itself, so each one not archived is read with get_document. A reply of another shape is an
   * error, never "no documents" or "unlocked", which would send every 完整流程 work item to Blocked for nothing.
   */
  async listIssueDocuments(issue: Pick<Issue, "id">): Promise<IssueDocument[]> {
    const raw = payload(
      await this.#tool("execute_read", "list_issue_documents", {
        projectKey: this.#project,
        issueId: issue.id,
      }),
    );
    const unrecognized = (what: string, reply: unknown) =>
      new Error(`unrecognized ${what} reply: ${JSON.stringify(reply).slice(0, 300)}`);
    if (!Array.isArray(raw)) throw unrecognized("list_issue_documents", raw);
    const docs: IssueDocument[] = [];
    for (const d of raw.map(asRecord)) {
      const id = parseOptionalInt(d.documentId);
      if (id === null || typeof d.archived !== "boolean" || typeof d.title !== "string")
        throw unrecognized("list_issue_documents", d);
      if (d.archived) {
        docs.push({ id, title: d.title, version: 0, locked: false, archived: true });
        continue;
      }
      const full = asRecord(
        payload(
          await this.#tool("execute_read", "get_document", {
            projectKey: this.#project,
            documentId: id,
          }),
        ),
      );
      const version = parseOptionalInt(full.version);
      if (version === null || typeof full.isLocked !== "boolean")
        throw unrecognized("get_document", { ...full, content: undefined, contentJson: undefined });
      docs.push({
        id,
        title: d.title,
        version,
        locked: full.isLocked,
        archived: full.archivedAt != null,
      });
    }
    return docs;
  }

  async getDocumentContent(docId: number): Promise<string> {
    const raw = asRecord(
      payload(
        await this.#tool("execute_read", "get_document", {
          projectKey: this.#project,
          documentId: docId,
        }),
      ),
    );
    if (typeof raw.content !== "string")
      throw new Error(`tracker get_document: no content for ${docId}`);
    return raw.content;
  }

  async createDocument(parentId: number, title: string, content: string): Promise<{ id: number }> {
    const raw = await this.#tool("execute_write", "create_document", {
      projectKey: this.#project,
      parentId,
      title,
      content,
    });
    return { id: createdId(raw, "create_document") };
  }

  async linkDocument(issue: Issue, docId: number): Promise<void> {
    await this.#tool("execute_write", "link_document_issue", {
      projectKey: this.#project,
      documentId: docId,
      issueId: issue.id,
    });
  }

  async setDescription(issue: Issue, description: string): Promise<void> {
    await this.#tool("execute_write", "update_issue", { issueId: issue.id, description });
  }

  async createIssue(input: NewIssue): Promise<{ id: number; number: number }> {
    const raw = await this.#tool("execute_write", "create_issue", {
      projectKey: this.#project,
      typeId: input.typeId,
      title: input.title,
      description: input.description,
      columnId: input.columnId,
      ...(input.parentId !== null ? { parentId: input.parentId } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    });
    const data = asRecord(payload(raw));
    const number = parseOptionalInt(data.sequenceNumber ?? data.number);
    if (number === null) throw new Error("tracker create_issue: no sequenceNumber in the reply");
    return { id: createdId(raw, "create_issue"), number };
  }

  async linkIssues(from: Issue, toId: number, kind: "relates" | "blocks"): Promise<void> {
    await this.#tool("execute_write", "link_issues", {
      issueId: from.id,
      targetIssueId: toId,
      kind,
    });
  }

  /** `list_issue_activity` filtered to comments, oldest first, every page; replies are flattened in. */
  async listComments(issue: Pick<Issue, "id" | "key">): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < ACTIVITY_PAGES; page++) {
      const data = asRecord(
        payload(
          await this.#tool("execute_read", "list_issue_activity", {
            issueId: issue.id,
            filter: "comments",
            order: "asc",
            limit: ACTIVITY_PAGE,
            ...(cursor !== undefined ? { cursor } : {}),
          }),
        ),
      );
      if (!Array.isArray(data.items))
        throw new Error(
          `unrecognized list_issue_activity reply: ${JSON.stringify(data).slice(0, 300)}`,
        );
      comments.push(...data.items.flatMap(toComments));
      if (typeof data.nextCursor !== "string" || data.nextCursor === "") {
        // Replies sit under their thread: put everything in time order.
        return comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
      }
      cursor = data.nextCursor;
    }
    throw new Error(`${issue.key} has more than ${ACTIVITY_PAGES * ACTIVITY_PAGE} comments`);
  }

  async setTitle(issue: Issue, title: string): Promise<void> {
    await this.#tool("execute_write", "update_issue", { issueId: issue.id, title });
  }

  async setType(issue: Issue, typeId: number): Promise<void> {
    await this.#tool("execute_write", "update_issue", { issueId: issue.id, typeId });
  }

  async setPriority(issue: Issue, priority: Priority | null): Promise<void> {
    await this.#tool("execute_write", "update_issue", { issueId: issue.id, priority });
  }

  async addLabel(issue: Issue, labelId: number): Promise<void> {
    await this.#relabel(issue, (ids) => (ids.includes(labelId) ? ids : [...ids, labelId]));
  }

  async removeLabel(issue: Issue, labelId: number): Promise<void> {
    await this.#relabel(issue, (ids) => ids.filter((id) => id !== labelId));
  }

  /**
   * `labelIds` replaces every label, so the labels are read again first: a person may have changed them since `issue`
   * was read. Nothing is written when nothing would change.
   */
  async #relabel(issue: Issue, change: (ids: number[]) => number[]): Promise<void> {
    const now = (await this.get(issue.number)).labelIds;
    const next = change(now);
    if (next.length === now.length && next.every((id, i) => id === now[i])) return;
    await this.#tool("execute_write", "update_issue", { issueId: issue.id, labelIds: next });
  }
}

/**
 * The tracker as the planning node may use it (CYC-322). The ids are bound here, from the resolved config: the
 * planner cannot move a work item, cannot put on `auto` or any label but its own two, and creates issues only in
 * Backlog, as a Feature or a Bug.
 */
export const planningTracker = (
  tracker: Tracker,
  config: Pick<Config, "featureTypeId" | "bugTypeId"> & { planning: PlanningConfig },
): PlanningTracker => {
  const { labels, backlogColumn, epicTypeId } = config.planning;
  return {
    get: (number) => tracker.get(number),
    listBacklog: () => tracker.listBacklog(),
    listTodo: () => tracker.listTodo(),
    listInProgress: () => tracker.listInProgress(),
    listBacklogRows: () => tracker.listBacklogRows(),
    listComments: (issue) => tracker.listComments(issue),
    comment: (issue, text) => tracker.comment(issue, text),
    setTitle: (issue, title) => tracker.setTitle(issue, title),
    setDescription: (issue, description) => tracker.setDescription(issue, description),
    makeEpic: (issue) => tracker.setType(issue, epicTypeId),
    setPriority: (issue, priority) => tracker.setPriority(issue, priority),
    createIssue: (input) =>
      tracker.createIssue({
        typeId: input.kind === "Bug" ? config.bugTypeId : config.featureTypeId,
        title: input.title,
        description: input.description,
        columnId: backlogColumn,
        parentId: input.parentId,
        priority: input.priority,
      }),
    linkBlocks: (from, toId) => tracker.linkIssues(from, toId, "blocks"),
    markPending: (issue) => tracker.addLabel(issue, labels.pending),
    unmarkPending: (issue) => tracker.removeLabel(issue, labels.pending),
    markAwaitingAnswer: (issue) => tracker.addLabel(issue, labels.awaitingAnswer),
    unmarkAwaitingAnswer: (issue) => tracker.removeLabel(issue, labels.awaitingAnswer),
  };
};

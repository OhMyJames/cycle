// `Tracker` over the Itsaplan MCP endpoint (JSON-RPC `tools/call`). The key comes from the config file and goes nowhere
// else: not into a session, not into a command's environment, not into a log line.
//
// `get_issue_by_number` on infra.CYC returns `typeId` and `subtasks` (`{ id, sequenceNumber, identifier, title,
// columnId, typeId, archived }[]`). `toIssue` reads these defensively and returns `null` when missing so selection
// fails closed rather than treating an unknown issue as an eligible leaf.

import type { Config, Issue, Priority, Stage, Tracker } from "./types.ts";

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
  };
};

export class PlanTracker implements Tracker {
  readonly #url: string;
  readonly #key: string;
  readonly #project: string;
  #columns: Config["columns"] | undefined;

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

  #column(stage: Stage): number {
    const id = this.#columns?.[stage];
    if (id === undefined) throw new Error("the project's columns are not resolved yet");
    return id;
  }

  /** The project's setup: columns, issue types, labels (`get_project`). */
  async getProject(): Promise<unknown> {
    return this.#call("get_project", { projectKey: this.#project });
  }

  async #call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(this.#url, {
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
    const listed = asRecord(
      await this.#call("list_issues", {
        projectKey: this.#project,
        columnId: this.#column("todo"),
        limit: 100,
      }),
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
    // The list may not carry the description: read each in full.
    return Promise.all(
      rows.map((row) => this.get(Number(asRecord(row).sequenceNumber ?? asRecord(row).number))),
    );
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
}

// `Tracker` over the Itsaplan MCP endpoint (JSON-RPC `tools/call`). The key comes from the environment and goes nowhere
// else: not into a session, not into a command's environment, not into a log line.
//
// Unverified against the live service: the auth header (`Authorization: Bearer`) and the shape of a returned issue.
// `toIssue` reads the fields it needs defensively and fails loudly when one is missing.

import type { Config, Issue, Priority, Stage, Tracker } from "./types.ts";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

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
  };
};

export class PlanTracker implements Tracker {
  readonly #url: string;
  readonly #key: string;
  readonly #project: string;
  readonly #columns: Config["columns"];

  constructor(options: {
    url: string;
    key: string;
    projectKey: string;
    columns: Config["columns"];
  }) {
    this.#url = options.url;
    this.#key = options.key;
    this.#project = options.projectKey;
    this.#columns = options.columns;
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
        columnId: this.#columns.todo,
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
    await this.#call("update_issue", { issueId: issue.id, columnId: this.#columns[stage] });
  }

  async comment(issue: Issue, text: string): Promise<void> {
    await this.#call("add_comment", { issueId: issue.id, body: text });
  }
}

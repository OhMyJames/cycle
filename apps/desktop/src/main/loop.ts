// What the page shows of Loop (docs/protocol.md §17). Two reads, both from the main process:
//   - the Projects: the Loop server on this computer answers `projects/list` on its unix socket;
//   - one Project's board: read from itsaplan with the person's own key, a file of theirs (mode 0600). The key is
//     read here and goes to the tracker's header, never to the page, a log line or an environment variable
//     (.agents/notes/2026-11-25-desktop-holds-a-personal-itsaplan-key-for-now.md).
// The Loop server's code is not imported: only the protocol's types are.

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { LOOP_PROJECTS_LIST, LoopProjectsListResultSchema } from "@cycle/protocol";
import type { LoopBoardAnswer, LoopProjectsAnswer, LoopTicket } from "@cycle/ui/api";

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
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = asRecord(JSON.parse(jsonOf(await response.text())));
  if (body.error !== undefined) throw new Error("tracker error");
  const result = asRecord(body.result);
  const text = (result.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
  if (result.isError === true) throw new Error("tracker error");
  return JSON.parse(text);
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

type Column = { id: number; name: string; stateType: string };

const DONE_SHOWN = 20;
/** The most a list answers (the tracker's own limit): a column is shown whole, so its count is true. */
const LIST_LIMIT = 500;

/** Tickets by the kind of their column (never its name); read-only. */
export const readBoard = async (t: Tracker, projectKey: string): Promise<LoopBoardAnswer> => {
  try {
    // The tracker answers with the thing itself (`{project, columns, ...}`, a bare array of issues); some paths wrap it
    // as `{ok, data}`. Both are read; an answer with no columns is a failure, not an empty board.
    const project = unwrap(await callTool(t, "get_project", { projectKey }));
    const columns = (Array.isArray(project.columns) ? project.columns : []).map(
      (c) => asRecord(c) as unknown as Column,
    );
    if (columns.length === 0) throw new Error("no columns");
    const ofType = (...types: string[]) => columns.filter((c) => types.includes(c.stateType));
    const tickets = async (
      cols: Column[],
      limit: number,
      newest = false,
    ): Promise<LoopTicket[]> => {
      const lists = await Promise.all(
        cols.map(async (column) => {
          const listed = await callTool(t, "list_issues", {
            projectKey,
            columnId: column.id,
            limit,
          });
          const rows = rowsOf(listed);
          return rows.map((row): LoopTicket & { at: string } => {
            const r = asRecord(row);
            return {
              at: String(r.updatedAt ?? ""),
              identifier: String(r.identifier ?? ""),
              title: String(r.title ?? ""),
              priority: typeof r.priority === "string" ? r.priority : null,
              column: column.name,
            };
          });
        }),
      );
      const all = lists.flat();
      // Several columns of one kind (two completed ones): the newest of all of them, not of whichever answered first.
      if (newest) all.sort((a, b) => b.at.localeCompare(a.at));
      return all.map(({ at: _at, ...ticket }) => ticket);
    };
    const [doing, todo, backlog, done] = await Promise.all([
      tickets(ofType("started"), LIST_LIMIT),
      tickets(ofType("unstarted"), LIST_LIMIT),
      tickets(ofType("backlog"), LIST_LIMIT),
      tickets(ofType("completed"), DONE_SHOWN, true),
    ]);
    return { kind: "ok", doing, todo, backlog, done: done.slice(0, DONE_SHOWN) };
  } catch {
    return { kind: "unreachable" };
  }
};

export type LoopOptions = { socket: string; keyFile: string; trackerUrl: string };

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

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopProjectInfo } from "@cycle/ui/api";
import {
  actionsOf,
  actOnTicket,
  answerBoard,
  answerTicket,
  readLoopProjects,
} from "../src/main/loop.ts";

const dir = mkdtempSync(join(tmpdir(), "desktop-loop-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const KEY = "itsaplan-secret-key-123";
const keyFile = join(dir, "itsaplan-key");
const writeKey = (mode: number) => {
  writeFileSync(keyFile, `${KEY}\n`);
  chmodSync(keyFile, mode);
};

const columns = [
  { id: 21, name: "Backlog", stateType: "backlog" },
  { id: 22, name: "Todo", stateType: "unstarted" },
  { id: 23, name: "In Progress", stateType: "started" },
  { id: 34, name: "In Review", stateType: "started" },
  { id: 24, name: "Done", stateType: "completed" },
  { id: 25, name: "Canceled", stateType: "canceled" },
];
const issue = (n: number, columnId: number) => ({
  identifier: `CYC-${n}`,
  title: `Ticket ${n}`,
  priority: "high",
  columnId,
  // In Progress holds Loop's ticket (auto, label 11); In Review does not.
  labelIds: columnId === 23 ? [11] : [],
});

/** A tracker that answers like itsaplan's MCP, and remembers the headers it was called with. */
const tracker = () => {
  const seen: { auth: string | null; tool: string; args: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    const { name, arguments: args } = body.params;
    seen.push({
      auth: new Headers(init.headers).get("authorization"),
      tool: name,
      args,
    });
    // The tracker's own shape: the project with its columns, and a bare array of issues.
    const data =
      name === "get_project"
        ? { project: {}, columns, labels: [{ id: 11, name: "auto" }] }
        : [issue(Number(args.columnId) * 10, Number(args.columnId))];
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify(data) }] },
      }),
    );
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
};

const loop = { socket: join(dir, "x.sock"), keyFile, trackerUrl: "https://tracker.invalid/mcp" };

describe("the board", () => {
  test("columns are picked by the kind of state, and the key goes only to the tracker's header", async () => {
    writeKey(0o600);
    const { seen, fetchImpl } = tracker();
    const events: unknown[] = [];
    const board = await answerBoard(loop, "CYC", (e, p) => events.push([e, p]), fetchImpl);
    if (board.kind !== "ok") throw new Error("expected a board");
    expect(board.doing.map((t) => t.identifier).sort()).toEqual(["CYC-230", "CYC-340"]);
    expect(board.doing.map((t) => t.column).sort()).toEqual(["In Progress", "In Review"]);
    expect(board.todo.map((t) => t.identifier)).toEqual(["CYC-220"]);
    expect(board.backlog.map((t) => t.identifier)).toEqual(["CYC-210"]);
    expect(board.done.map((t) => t.identifier)).toEqual(["CYC-240"]);
    // Canceled is not asked for at all.
    expect(seen.some((s) => s.args.columnId === 25)).toBe(false);
    expect(seen.every((s) => s.auth === `Bearer ${KEY}`)).toBe(true);
    // What the page gets has no key, and the event holds only the kind of outcome.
    expect(JSON.stringify(board)).not.toContain(KEY);
    expect(events).toEqual([["loop_board_read", { result: "ok" }]]);
  });

  test("an answer with no columns is a failure, not an empty board", async () => {
    writeKey(0o600);
    const empty = (async () =>
      new Response(
        JSON.stringify({
          result: { content: [{ type: "text", text: JSON.stringify({ project: {} }) }] },
        }),
      )) as unknown as typeof fetch;
    expect(await answerBoard(loop, "CYC", () => {}, empty)).toEqual({ kind: "unreachable" });
  });

  test("no key file, or one others can read, is no_key and the tracker is not called", async () => {
    const { seen, fetchImpl } = tracker();
    writeKey(0o644);
    expect(await answerBoard(loop, "CYC", () => {}, fetchImpl)).toEqual({ kind: "no_key" });
    rmSync(keyFile);
    expect(await answerBoard(loop, "CYC", () => {}, fetchImpl)).toEqual({ kind: "no_key" });
    expect(seen).toEqual([]);
  });

  test("a refusing tracker is unreachable, and says nothing of why", async () => {
    writeKey(0o600);
    const events: unknown[] = [];
    const refuse = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch;
    const board = await answerBoard(loop, "CYC", (e, p) => events.push([e, p]), refuse);
    expect(board).toEqual({ kind: "unreachable" });
    expect(events).toEqual([["loop_board_read", { result: "unreachable" }]]);
  });

  test("a project key that is not a key is not sent to the tracker", async () => {
    writeKey(0o600);
    const { seen, fetchImpl } = tracker();
    const events: unknown[] = [];
    expect(await answerBoard(loop, "../x?y", (e) => events.push(e), fetchImpl)).toEqual({
      kind: "unreachable",
    });
    expect(events).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("projects", () => {
  test("no server on the socket is disconnected", async () => {
    expect(await readLoopProjects(join(dir, "none.sock"))).toEqual({ kind: "disconnected" });
  });

  test("a server's projects are read and checked against the protocol", async () => {
    const socket = join(dir, "p.sock");
    const projects: LoopProjectInfo[] = [
      { name: "Cycle", projectKey: "CYC", repo: { displayName: "clawdot/cycle", forge: "github" } },
    ];
    const server = createServer((c) =>
      c.on("data", () =>
        c.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { projects } })}\n`),
      ),
    );
    await new Promise<void>((r) => server.listen(socket, r));
    try {
      expect(await readLoopProjects(socket)).toEqual({ kind: "ok", projects });
    } finally {
      server.close();
    }
  });

  test("an answer that is not the protocol's is disconnected", async () => {
    const socket = join(dir, "bad.sock");
    const server = createServer((c) =>
      c.on("data", () => c.write(`${JSON.stringify({ result: { projects: [{ name: 1 }] } })}\n`)),
    );
    await new Promise<void>((r) => server.listen(socket, r));
    try {
      expect(await readLoopProjects(socket)).toEqual({ kind: "disconnected" });
    } finally {
      server.close();
    }
  });
});

describe("state buttons", () => {
  const labels = [
    { id: 11, name: "auto" },
    { id: 5, name: "产品" },
  ];
  /** A tracker with one ticket, which remembers every write. */
  const board = (column: number, labelIds: number[], fail?: { status: number }) => {
    const writes: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      const { params } = JSON.parse(String(init.body)) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const { name, arguments: args } = params;
      let data: unknown;
      if (name === "get_project")
        data = { project: {}, columns: columns.map((c, position) => ({ ...c, position })), labels };
      else if (name === "get_issue_by_number")
        data = {
          id: 765,
          identifier: "CYC-387",
          title: "T",
          columnId: column,
          labelIds,
          description:
            "x\n\n## 验收标准\n\n1. 一\n2. 二 https://github.com/o/r/pull/9\n\n## 依赖\n\n- no",
          development: [{ url: "https://github.com/o/r/pull/12" }],
        };
      else {
        writes.push(args);
        if (fail) return new Response("no", { status: fail.status });
        data = { ok: true };
      }
      return new Response(
        JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(data) }] } }),
      );
    }) as unknown as typeof fetch;
    return { writes, fetchImpl };
  };
  const act = (
    action: string,
    confirmed: unknown,
    t: ReturnType<typeof board>,
    events: unknown[] = [],
  ) =>
    actOnTicket(
      loop,
      "CYC",
      "CYC-387",
      action,
      confirmed,
      (e, p) => events.push([e, p]),
      t.fetchImpl,
    );

  test("approving without confirmation writes nothing, not even a read", async () => {
    writeKey(0o600);
    const t = board(21, [5]);
    const events: unknown[] = [];
    expect(await act("approve", undefined, t, events)).toEqual({
      kind: "failed",
      reason: "unconfirmed",
    });
    expect(await act("approve", "yes", t)).toEqual({ kind: "failed", reason: "unconfirmed" });
    expect(t.writes).toEqual([]);
    expect(events).toEqual([["loop_ticket_acted", { action: "approve", result: "unconfirmed" }]]);
  });

  test("a confirmed approval moves Backlog to Todo and adds auto, keeping the other labels", async () => {
    writeKey(0o600);
    const t = board(21, [5]);
    expect(await act("approve", true, t)).toEqual({ kind: "ok" });
    expect(t.writes).toEqual([{ issueId: 765, columnId: 22, labelIds: [5, 11] }]);
  });

  test("back to Backlog and back to Todo move the ticket; Backlog drops auto", async () => {
    writeKey(0o600);
    const a = board(22, [5, 11]);
    expect(await act("to_backlog", undefined, a)).toEqual({ kind: "ok" });
    expect(a.writes).toEqual([{ issueId: 765, columnId: 21, labelIds: [5] }]);
    const b = board(23, [5]);
    expect(await act("to_todo", undefined, b)).toEqual({ kind: "ok" });
    expect(b.writes).toEqual([{ issueId: 765, columnId: 22 }]);
  });

  test("Done, and Doing with auto (Loop's), have no buttons and refuse the write", async () => {
    writeKey(0o600);
    expect(actionsOf("completed", false)).toEqual([]);
    expect(actionsOf("started", true)).toEqual([]);
    expect(actionsOf("started", false)).toEqual(["to_backlog", "to_todo"]);
    expect(actionsOf("backlog", false)).toEqual(["approve"]);
    expect(actionsOf("unstarted", true)).toEqual(["to_backlog"]);
    for (const [column, ids] of [
      [24, []],
      [23, [11]],
      [34, [11]],
    ] as const) {
      const t = board(column, [...ids]);
      expect(await act("to_todo", undefined, t)).toEqual({ kind: "failed", reason: "not_allowed" });
      expect(await act("to_backlog", undefined, t)).toEqual({
        kind: "failed",
        reason: "not_allowed",
      });
      expect(t.writes).toEqual([]);
    }
  });

  test("the board gives each ticket the buttons its column and label allow", async () => {
    writeKey(0o600);
    const { fetchImpl } = tracker();
    const answer = await answerBoard(loop, "CYC", () => {}, fetchImpl);
    if (answer.kind !== "ok") throw new Error("expected a board");
    // Doing: the auto one (In Progress) is Loop's and has no buttons; the other has.
    expect(answer.doing.find((t) => t.column === "In Progress")?.actions).toEqual([]);
    expect(answer.doing.find((t) => t.column === "In Review")?.actions).toEqual([
      "to_backlog",
      "to_todo",
    ]);
    expect(answer.backlog[0]?.actions).toEqual(["approve"]);
    expect(answer.todo[0]?.actions).toEqual(["to_backlog"]);
    expect(answer.done[0]?.actions).toEqual([]);
  });

  test("a plain-text tool error is a refusal, not offline", async () => {
    writeKey(0o600);
    const bad = (async () =>
      new Response(
        JSON.stringify({
          result: { isError: true, content: [{ type: "text", text: "Permission denied" }] },
        }),
      )) as unknown as typeof fetch;
    expect(await actOnTicket(loop, "CYC", "CYC-387", "to_backlog", false, () => {}, bad)).toEqual({
      kind: "failed",
      reason: "refused",
    });
  });

  test("failures are said in fixed words: permission, conflict, offline, no key", async () => {
    writeKey(0o600);
    for (const [status, reason] of [
      [403, "forbidden"],
      [401, "forbidden"],
      [409, "conflict"],
      [500, "refused"],
    ] as const) {
      expect(await act("to_backlog", undefined, board(22, [], { status }))).toEqual({
        kind: "failed",
        reason,
      });
    }
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await actOnTicket(loop, "CYC", "CYC-387", "to_backlog", false, () => {}, down)).toEqual({
      kind: "failed",
      reason: "offline",
    });
    rmSync(keyFile);
    const t = board(21, []);
    expect(await act("approve", true, t)).toEqual({ kind: "failed", reason: "no_key" });
    expect(t.writes).toEqual([]);
  });

  test("a ticket of another Project, or a bad action, is not written", async () => {
    writeKey(0o600);
    const t = board(21, []);
    const r = await actOnTicket(loop, "CYC", "DOC-1", "approve", true, () => {}, t.fetchImpl);
    expect(r).toEqual({ kind: "failed", reason: "refused" });
    const r2 = await actOnTicket(loop, "CYC", "CYC-1", "delete", true, () => {}, t.fetchImpl);
    expect(r2).toEqual({ kind: "failed", reason: "refused" });
    expect(t.writes).toEqual([]);
  });

  test("the ticket page has the text, the acceptance items and the PR links, and the event carries no content", async () => {
    writeKey(0o600);
    const t = board(21, []);
    const events: unknown[] = [];
    const answer = await answerTicket(
      loop,
      "CYC",
      "CYC-387",
      (e, p) => events.push([e, p]),
      t.fetchImpl,
    );
    if (answer.kind !== "ok") throw new Error("expected a ticket");
    expect(answer.ticket.acceptance).toEqual(["一", "二 https://github.com/o/r/pull/9"]);
    expect(answer.ticket.links.sort()).toEqual([
      "https://github.com/o/r/pull/12",
      "https://github.com/o/r/pull/9",
    ]);
    expect(answer.ticket.actions).toEqual(["approve"]);
    expect(events).toEqual([["loop_ticket_opened", {}]]);
    expect(JSON.stringify(answer)).not.toContain(KEY);
  });
});

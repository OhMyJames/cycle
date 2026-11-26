import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  startTicketChat,
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
/** The tracker's board order is `position`, not the order of the array: Canceled sits before In Review and Blocked. */
const boardColumns = [
  { id: 34, name: "In Review", stateType: "started", position: 5 },
  { id: 25, name: "Canceled", stateType: "canceled", position: 4 },
  { id: 21, name: "Backlog", stateType: "backlog", position: 0 },
  { id: 22, name: "Todo", stateType: "unstarted", position: 1 },
  { id: 35, name: "Blocked", stateType: "started", position: 6 },
  { id: 23, name: "In Progress", stateType: "started", position: 2 },
  { id: 24, name: "Done", stateType: "completed", position: 3 },
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
        ? { project: {}, columns: boardColumns, labels: [{ id: 11, name: "auto" }] }
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
    expect(board.columns.map((c) => c.name)).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "Done",
      "In Review",
      "Blocked",
    ]);
    const ids = (name: string) =>
      board.columns.find((c) => c.name === name)?.tickets.map((t) => t.identifier);
    expect(ids("In Progress")).toEqual(["CYC-230"]);
    expect(ids("In Review")).toEqual(["CYC-340"]);
    expect(ids("Blocked")).toEqual(["CYC-350"]);
    expect(ids("Todo")).toEqual(["CYC-220"]);
    expect(ids("Backlog")).toEqual(["CYC-210"]);
    expect(ids("Done")).toEqual(["CYC-240"]);
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
    const of = (name: string) => answer.columns.find((c) => c.name === name)?.tickets[0];
    // Doing: the auto one (In Progress) is Loop's and has no buttons; the other has.
    expect(of("In Progress")?.actions).toEqual([]);
    expect(of("In Review")?.actions).toEqual(["to_backlog", "to_todo"]);
    expect(of("Backlog")?.actions).toEqual(["approve"]);
    expect(of("Todo")?.actions).toEqual(["to_backlog"]);
    expect(of("Done")?.actions).toEqual([]);
  });

  test("a completed column keeps the newest 20 and says there are more; Backlog is whole", async () => {
    writeKey(0o600);
    const rows = (id: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...issue(1000 + i, id),
        updatedAt: `2026-01-${String(i + 1).padStart(2, "0")}`,
      }));
    const fetchImpl = (async (_u: unknown, init: RequestInit) => {
      const { name, arguments: args } = JSON.parse(String(init.body)).params;
      const data =
        name === "get_project"
          ? { project: {}, columns: boardColumns, labels: [] }
          : args.columnId === 24
            ? rows(24, Math.min(25, args.limit))
            : args.columnId === 21
              ? rows(21, 30)
              : [];
      return new Response(
        JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(data) }] } }),
      );
    }) as unknown as typeof fetch;
    const answer = await answerBoard(loop, "CYC", () => {}, fetchImpl);
    if (answer.kind !== "ok") throw new Error("expected a board");
    const done = answer.columns.find((c) => c.name === "Done");
    expect(done?.tickets).toHaveLength(20);
    expect(done?.more).toBe(true);
    expect(done?.tickets[0]?.identifier).toBe("CYC-1020");
    const backlog = answer.columns.find((c) => c.name === "Backlog");
    expect(backlog?.tickets).toHaveLength(30);
    expect(backlog?.more).toBe(false);
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

describe("a conversation about a ticket (CYC-389)", () => {
  /** A tracker whose ticket CYC-9 sits in the given column. */
  const trackerWith = (columnId: number) =>
    (async (_url: unknown, init: RequestInit) => {
      const { params } = JSON.parse(String(init.body)) as {
        params: { name: string };
      };
      const data =
        params.name === "get_project"
          ? { project: {}, columns: boardColumns, labels: [{ id: 11, name: "auto" }] }
          : { id: 9, identifier: "CYC-9", title: "T", columnId, labelIds: [] };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify(data) }] },
        }),
      );
    }) as unknown as typeof fetch;

  const setup = (defaults: Record<string, string>) => {
    const made: unknown[] = [];
    const prompts: string[] = [];
    const events: unknown[] = [];
    const deps = {
      locationId: "local",
      cwd: join(dir, "work"),
      agentDefaults: async () => defaults,
      createSession: async (params: unknown) => {
        made.push(params);
        return "s1";
      },
      prompt: async (_id: string, text: string) => {
        prompts.push(text);
      },
    };
    const track = ((e: string, p: unknown) => events.push([e, p])) as never;
    return { made, prompts, events, deps, track };
  };

  test("chat is new in Backlog and Todo, watch in a started column, none elsewhere", async () => {
    const { chatOf } = await import("../src/main/loop.ts");
    expect(chatOf("backlog")).toBe("new");
    expect(chatOf("unstarted")).toBe("new");
    expect(chatOf("started", "progress")).toBe("watch");
    expect(chatOf("started", "review")).toBe("none");
    expect(chatOf("started", "blocked")).toBe("none");
    expect(chatOf("started")).toBe("none");
    expect(chatOf("unstarted", undefined, true)).toBe("none");
    expect(chatOf("completed")).toBe("none");
  });

  test("the ticket's page says what it gets", async () => {
    writeKey(0o600);
    const answer = await answerTicket(loop, "CYC", "CYC-9", () => {}, trackerWith(21));
    if (answer.kind !== "ok") throw new Error("expected a ticket");
    expect(answer.ticket.chat).toBe("new");
    const doing = await answerTicket(loop, "CYC", "CYC-9", () => {}, trackerWith(23));
    if (doing.kind !== "ok") throw new Error("expected a ticket");
    expect(doing.ticket.chat).toBe("watch");
    // In Review (34) is not Loop's running column: no note, no button.
    const review = await answerTicket(loop, "CYC", "CYC-9", () => {}, trackerWith(34));
    if (review.kind !== "ok") throw new Error("expected a ticket");
    expect(review.ticket.chat).toBe("none");
  });

  test("a Backlog or Todo ticket gets a session with its number and the default model", async () => {
    writeKey(0o600);
    for (const columnId of [21, 22]) {
      const { made, prompts, events, deps, track } = setup({ model: "deepseek-flash" });
      const result = await startTicketChat(
        loop,
        deps,
        "CYC",
        "CYC-9",
        track,
        trackerWith(columnId),
      );
      expect(result).toEqual({ kind: "started", locationId: "local", sessionId: "s1" });
      expect(made).toEqual([
        { cwd: join(dir, "work"), agent: "codex", config: { model: "deepseek-flash" } },
      ]);
      expect(prompts[0]).toContain("CYC-9");
      // Only the word of the outcome: no ticket, no text.
      expect(events).toEqual([["loop_ticket_chat", { result: "started" }]]);
    }
  });

  test("In Progress is only to watch: no session is made", async () => {
    writeKey(0o600);
    const { made, deps, track } = setup({ model: "deepseek-flash" });
    const result = await startTicketChat(loop, deps, "CYC", "CYC-9", track, trackerWith(23));
    expect(result).toEqual({ kind: "failed", reason: "not_allowed" });
    expect(made).toEqual([]);
  });

  test("with no default model it says so and makes nothing", async () => {
    writeKey(0o600);
    for (const defaults of [{}, { model: "  " }]) {
      const { made, events, deps, track } = setup(defaults);
      const result = await startTicketChat(loop, deps, "CYC", "CYC-9", track, trackerWith(21));
      expect(result).toEqual({ kind: "failed", reason: "needs_model" });
      expect(made).toEqual([]);
      expect(events).toEqual([["loop_ticket_chat", { result: "needs_model" }]]);
    }
  });

  test("the session runs in the ticket-chat folder, made on first use, never the home folder", async () => {
    writeKey(0o600);
    const cwd = join(dir, "data", "ticket-chat");
    const { made, deps, track } = setup({ model: "deepseek-flash" });
    await startTicketChat(loop, { ...deps, cwd }, "CYC", "CYC-9", track, trackerWith(21));
    expect(made).toEqual([{ cwd, agent: "codex", config: { model: "deepseek-flash" } }]);
    expect(statSync(cwd).isDirectory()).toBe(true);
    // No folder configured: nothing is made.
    const none = setup({ model: "deepseek-flash" });
    const result = await startTicketChat(
      loop,
      { ...none.deps, cwd: "" },
      "CYC",
      "CYC-9",
      none.track,
      trackerWith(21),
    );
    expect(result).toEqual({ kind: "failed", reason: "no_folder" });
    expect(none.made).toEqual([]);
  });

  test("a first message that does not go leaves the session's id with the failure", async () => {
    writeKey(0o600);
    const { deps, track } = setup({ model: "deepseek-flash" });
    const failing = {
      ...deps,
      cwd: join(dir, "chat2"),
      prompt: async () => {
        throw new Error("down");
      },
    };
    const result = await startTicketChat(loop, failing, "CYC", "CYC-9", track, trackerWith(21));
    expect(result).toEqual({
      kind: "failed",
      reason: "failed",
      sessionId: "s1",
      locationId: "local",
    });
  });
});

describe("Loop's stage on In Progress cards (CYC-443)", () => {
  const stageField = {
    id: 90,
    name: "Loop 阶段",
    options: [
      { id: 1, name: "开发" },
      { id: 3, name: "QA" },
    ],
  };
  const sinceField = { id: 91, name: "Loop 阶段开始于" };
  const since = "2026-11-26T08:00:00.000Z";
  const stagedBoard = (opts: { fields?: unknown[]; issue?: (id: unknown) => unknown }) => {
    const seen: { tool: string; args: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      const { params } = JSON.parse(String(init.body)) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const { name, arguments: args } = params;
      seen.push({ tool: name, args });
      let data: unknown;
      if (name === "get_project")
        data = {
          project: {},
          columns: boardColumns,
          labels: [],
          customFields: opts.fields ?? [stageField, sinceField],
        };
      else if (name === "get_issue") {
        const r = opts.issue?.(args.issueId);
        if (r instanceof Error) throw r;
        data = r;
      } else
        data = [
          {
            ...issue(Number(args.columnId) * 10, Number(args.columnId)),
            id: Number(args.columnId) * 100,
          },
        ];
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
  const good = () => ({
    fields: [
      { name: "Loop 阶段", optionIds: [3] },
      { name: "Loop 阶段开始于", value: since },
    ],
  });
  const tickets = (b: Awaited<ReturnType<typeof answerBoard>>, name: string) => {
    if (b.kind !== "ok") throw new Error("expected a board");
    return b.columns.find((c) => c.name === name)?.tickets ?? [];
  };

  test("In Progress tickets carry the stage; other columns are not read", async () => {
    writeKey(0o600);
    const { seen, fetchImpl } = stagedBoard({ issue: good });
    const board = await answerBoard(loop, "CYC", () => {}, fetchImpl);
    expect(tickets(board, "In Progress")[0]?.loopStage).toEqual({ stage: "qa", since });
    expect(tickets(board, "In Review")[0]).not.toHaveProperty("loopStage");
    expect(seen.filter((s) => s.tool === "get_issue").map((s) => s.args.issueId)).toEqual([2300]);
  });

  test("a failed read, a missing field or an empty field leaves the card without a stage", async () => {
    writeKey(0o600);
    const failed = await answerBoard(
      loop,
      "CYC",
      () => {},
      stagedBoard({ issue: () => new Error("boom") }).fetchImpl,
    );
    expect(tickets(failed, "In Progress")).toHaveLength(1);
    expect(tickets(failed, "In Progress")[0]).not.toHaveProperty("loopStage");
    const missing = stagedBoard({ fields: [stageField], issue: good });
    const noField = await answerBoard(loop, "CYC", () => {}, missing.fetchImpl);
    expect(tickets(noField, "In Progress")[0]).not.toHaveProperty("loopStage");
    expect(missing.seen.some((s) => s.tool === "get_issue")).toBe(false);
    const empty = await answerBoard(
      loop,
      "CYC",
      () => {},
      stagedBoard({ issue: () => ({ fields: [{ name: "Loop 阶段", optionIds: [] }] }) }).fetchImpl,
    );
    expect(tickets(empty, "In Progress")[0]).not.toHaveProperty("loopStage");
    expect(tickets(empty, "Todo")).toHaveLength(1);
  });
});

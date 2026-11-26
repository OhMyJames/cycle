import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopProjectInfo } from "@cycle/ui/api";
import {
  actionsOf,
  actOnMany,
  actOnTicket,
  answerBoard,
  answerRuns,
  answerTicket,
  type LoopRpcAnswer,
  loopFeed,
  loopRpc,
  readLoopProjects,
  readLoopRuns,
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

type Reply = (method: string, params: Record<string, unknown>) => unknown;

/** A Loop server on a unix socket: answers `runs/list` from `runs`, and `events/list` and the rest through `reply`. */
const run = (key: string, state: "active" | "blocked" | "done") => ({
  key,
  kind: "dev" as const,
  state,
  startedAt: "2026-11-26T01:00:00.000Z",
  updatedAt: "2026-11-26T02:00:00.000Z",
});

const loopServer = async (
  socket: string,
  options: { runs?: [string, ReturnType<typeof run>[]][]; reply?: Reply },
) => {
  const server = createServer((c) =>
    c.on("data", (chunk) => {
      const req = JSON.parse(chunk.toString("utf8").split("\n")[0] ?? "{}") as {
        method: string;
        params?: Record<string, unknown>;
      };
      const result =
        req.method === "runs/list"
          ? { projects: (options.runs ?? []).map(([projectKey, runs]) => ({ projectKey, runs })) }
          : options.reply?.(req.method, req.params ?? {});
      const body =
        result && typeof result === "object" && "error" in result
          ? { jsonrpc: "2.0", id: 1, ...result }
          : { jsonrpc: "2.0", id: 1, result };
      c.write(`${JSON.stringify(body)}\n`);
    }),
  );
  await new Promise<void>((r) => server.listen(socket, r));
  return server;
};

describe("where Loop is running (CYC-458)", () => {
  test("only an active record is running, and a server that does not answer says nothing runs", async () => {
    const socket = join(dir, "runs.sock");
    expect(await readLoopRuns(socket)).toEqual({ kind: "disconnected" });
    const server = await loopServer(socket, {
      runs: [
        ["CYC", [run("CYC-1", "active"), run("CYC-2", "done"), run("CYC-3", "blocked")]],
        ["OPS", []],
      ],
    });
    try {
      expect(await readLoopRuns(socket)).toEqual({
        kind: "ok",
        running: { CYC: ["CYC-1"], OPS: [] },
      });
    } finally {
      server.close();
    }
  });

  test("a ticket left in In Progress with no running record is not Loop running it", async () => {
    writeKey(0o600);
    const { fetchImpl } = tracker();
    const socket = join(dir, "idle.sock");
    // Loop is up, and its only record for the ticket is done: In Progress alone proves nothing.
    const server = await loopServer(socket, { runs: [["CYC", [run("CYC-230", "done")]]] });
    try {
      const board = await answerBoard({ ...loop, socket }, "CYC", () => {}, fetchImpl);
      if (board.kind !== "ok") throw new Error("expected a board");
      const progress = board.columns.find((c) => c.name === "In Progress");
      expect(progress?.tickets.map((t) => [t.identifier, t.chat])).toEqual([["CYC-230", "none"]]);
    } finally {
      server.close();
    }
    // And with a running record it is watched.
    const live = join(dir, "live.sock");
    const running = await loopServer(live, { runs: [["CYC", [run("CYC-230", "active")]]] });
    try {
      const board = await answerBoard({ ...loop, socket: live }, "CYC", () => {}, fetchImpl);
      if (board.kind !== "ok") throw new Error("expected a board");
      const progress = board.columns.find((c) => c.name === "In Progress");
      expect(progress?.tickets.map((t) => t.chat)).toEqual(["watch"]);
    } finally {
      running.close();
    }
  });

  const event = (seq: number) => ({
    seq,
    ts: "2026-11-26T02:00:00.000Z",
    run: "CYC-1",
    kind: "phase",
  });

  test("after a disconnect the next request carries the last seq, and a seq is applied once", async () => {
    const socket = join(dir, "feed.sock");
    const asked: unknown[] = [];
    let active = true;
    // The server resends seq 2 with the new one after it comes back: a client must not apply 2 a second time.
    let pages: Record<number, ReturnType<typeof event>[]> = { 0: [event(1), event(2)] };
    const reply: Reply = (method, params) => {
      if (method !== "events/list") return {};
      asked.push(params.afterSeq);
      const after = Number(params.afterSeq);
      const events = (pages[after] ?? []).filter((e) => e.seq > 0);
      return {
        projectKey: "CYC",
        events,
        lastSeq: events.at(-1)?.seq ?? after,
        hasMore: false,
      };
    };
    const start = () =>
      loopServer(socket, {
        runs: [["CYC", active ? [run("CYC-1", "active")] : [run("CYC-1", "done")]]],
        reply,
      });
    let server = await start();
    const told: unknown[] = [];
    const feed = loopFeed({
      call: (method, params) => loopRpc(socket, method, params),
      changed: (runs) => told.push(runs),
    });
    try {
      await feed.tick(); // reads the runs, then catches up on the log
      expect(told).toEqual([{ kind: "ok", running: { CYC: ["CYC-1"] } }]);
      expect(feed.lastSeq("CYC")).toBe(2);
      expect(asked).toEqual([0]);

      // The server goes away: nothing is asked of it, and the last seq is kept.
      await new Promise((r) => server.close(r));
      await feed.tick();
      expect(feed.lastSeq("CYC")).toBe(2);

      // It comes back: the Loop has finished meanwhile. The request carries 2; seq 2 comes back again, 3 is new.
      active = false;
      pages = { 2: [event(2), event(3)] };
      server = await start();
      await feed.tick();
      expect(asked.slice(1)).toEqual([2]);
      expect(feed.lastSeq("CYC")).toBe(3);
      expect(told).toEqual([
        { kind: "ok", running: { CYC: ["CYC-1"] } },
        { kind: "disconnected" },
        { kind: "ok", running: { CYC: [] } },
      ]);

      // Nothing new: only the seq is asked again, and nothing is told twice.
      pages = { 3: [event(3)] };
      await feed.tick();
      expect(asked.at(-1)).toBe(3);
      expect(told).toHaveLength(3);
    } finally {
      server.close();
    }
  });

  test("a read the page asked for is pushed too when it differs from what was told", async () => {
    const socket = join(dir, "read.sock");
    const server = await loopServer(socket, { runs: [["CYC", [run("CYC-1", "active")]]] });
    const told: unknown[] = [];
    const feed = loopFeed({
      call: (method, params) => loopRpc(socket, method, params),
      changed: (runs) => told.push(runs),
    });
    try {
      expect(await feed.read()).toEqual({ kind: "ok", running: { CYC: ["CYC-1"] } });
      expect(told).toHaveLength(1);
      expect(await feed.read()).toEqual({ kind: "ok", running: { CYC: ["CYC-1"] } });
      expect(told).toHaveLength(1);
      await new Promise((r) => server.close(r));
      expect(await feed.read()).toEqual({ kind: "disconnected" });
      expect(told).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  test("events/list that keeps failing does not make runs/list be read every tick, and backs off", async () => {
    const socket = join(dir, "broken.sock");
    let runsReads = 0;
    let eventAsks = 0;
    const server = createServer((c) =>
      c.on("data", (chunk) => {
        const req = JSON.parse(chunk.toString("utf8").split("\n")[0] ?? "{}") as { method: string };
        if (req.method === "runs/list") {
          runsReads++;
          const result = { projects: [{ projectKey: "CYC", runs: [run("CYC-1", "active")] }] };
          c.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n`);
        } else {
          eventAsks++;
          c.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "Internal error" } })}\n`,
          );
        }
      }),
    );
    await new Promise<void>((r) => server.listen(socket, r));
    try {
      const feed = loopFeed({
        call: (method, params) => loopRpc(socket, method, params),
        changed: () => {},
      });
      for (let i = 0; i < 12; i++) await feed.tick();
      // Runs were read at the start (and once more as a recheck); the failing events are asked less and less often.
      expect(runsReads).toBeLessThanOrEqual(3);
      expect(eventAsks).toBeLessThanOrEqual(6);
    } finally {
      server.close();
    }
  });

  test("the log that was there at the start is read to its end, and is not news", async () => {
    const socket = join(dir, "cold.sock");
    const server = await loopServer(socket, {
      runs: [["CYC", [run("CYC-1", "active")]]],
      reply: (_method, params) => {
        const after = Number(params.afterSeq);
        const events = [event(1), event(2), event(3)].filter((e) => e.seq > after);
        return { projectKey: "CYC", events, lastSeq: 3, hasMore: false };
      },
    });
    try {
      const feed = loopFeed({
        call: (method, params) => loopRpc(socket, method, params),
        changed: () => {},
      });
      await feed.tick();
      expect(feed.lastSeq("CYC")).toBe(3);
      await feed.tick();
      await feed.tick();
      expect(feed.lastSeq("CYC")).toBe(3);
    } finally {
      server.close();
    }
  });

  test("loop_runs_read is sent with the result alone", async () => {
    const sent: unknown[] = [];
    const track = (event: string, props: unknown) => sent.push([event, props]);
    expect(await answerRuns(undefined, track)).toEqual({ kind: "disconnected" });
    const runs = { kind: "ok" as const, running: { CYC: ["CYC-1"] } };
    expect(await answerRuns({ read: async () => runs }, track)).toEqual(runs);
    // Never a Project, a ticket or a count: the one fixed word.
    expect(sent).toEqual([
      ["loop_runs_read", { result: "disconnected" }],
      ["loop_runs_read", { result: "ok" }],
    ]);
  });

  test("a Loop that was away for several ticks is seen on the first tick after it is back", async () => {
    const socket = join(dir, "back.sock");
    const told: unknown[] = [];
    const feed = loopFeed({
      call: (method, params) => loopRpc(socket, method, params),
      changed: (runs) => told.push(runs),
    });
    for (let i = 0; i < 6; i++) await feed.tick();
    expect(told).toEqual([{ kind: "disconnected" }]);
    const server = await loopServer(socket, {
      runs: [["CYC", [run("CYC-1", "active")]]],
      reply: () => ({ projectKey: "CYC", events: [], lastSeq: 0, hasMore: false }),
    });
    try {
      await feed.tick();
      expect(told.at(-1)).toEqual({ kind: "ok", running: { CYC: ["CYC-1"] } });
    } finally {
      server.close();
    }
  });

  test("an older runs answer that arrives late is not applied over a newer one", async () => {
    const waiting: ((value: LoopRpcAnswer) => void)[] = [];
    const told: unknown[] = [];
    const feed = loopFeed({
      call: () => new Promise<LoopRpcAnswer>((resolve) => waiting.push(resolve)),
      changed: (runs) => told.push(runs),
    });
    const answer = (keys: string[]) => ({
      kind: "ok" as const,
      result: { projects: [{ projectKey: "CYC", runs: keys.map((k) => run(k, "active")) }] },
    });
    const older = feed.read();
    const newer = feed.read();
    waiting[1]?.(answer(["CYC-2"]));
    await newer;
    waiting[0]?.(answer([]));
    await older;
    expect(told).toEqual([{ kind: "ok", running: { CYC: ["CYC-2"] } }]);
  });

  test("a seq past the end of the log starts again from 0", async () => {
    const socket = join(dir, "ahead.sock");
    const asked: unknown[] = [];
    let lines = 5;
    const server = await loopServer(socket, {
      runs: [["CYC", [run("CYC-1", "active")]]],
      reply: (method, params) => {
        if (method !== "events/list") return {};
        const after = Number(params.afterSeq);
        asked.push(after);
        if (after > lines)
          return {
            error: { code: -32602, message: "Invalid params", data: { reason: "seq_ahead" } },
          };
        const events = Array.from({ length: lines - after }, (_, i) => event(after + i + 1));
        return { projectKey: "CYC", events, lastSeq: lines, hasMore: false };
      },
    });
    try {
      const feed = loopFeed({
        call: (method, params) => loopRpc(socket, method, params),
        changed: () => {},
      });
      await feed.tick();
      expect(feed.lastSeq("CYC")).toBe(5);
      lines = 2; // the log was swapped for a shorter one
      await feed.tick();
      expect(asked).toEqual([0, 5, 0]);
      expect(feed.lastSeq("CYC")).toBe(2);
    } finally {
      server.close();
    }
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
    // In Progress alone is not "running" (CYC-458): the run data has to say so.
    expect(chatOf("started", "progress")).toBe("none");
    expect(chatOf("started", "progress", false, true)).toBe("watch");
    expect(chatOf("started", "review", false, true)).toBe("none");
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
    // Left in In Progress, with no Loop server and so no running record: not watched as running.
    const left = await answerTicket(loop, "CYC", "CYC-9", () => {}, trackerWith(23));
    if (left.kind !== "ok") throw new Error("expected a ticket");
    expect(left.ticket.chat).toBe("none");
    const socket = join(dir, "running.sock");
    const server = await loopServer(socket, { runs: [["CYC", [run("CYC-9", "active")]]] });
    try {
      const doing = await answerTicket(
        { ...loop, socket },
        "CYC",
        "CYC-9",
        () => {},
        trackerWith(23),
      );
      if (doing.kind !== "ok") throw new Error("expected a ticket");
      expect(doing.ticket.chat).toBe("watch");
    } finally {
      server.close();
    }
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
    fieldType: "select",
    options: [
      { id: 1, value: "开发" },
      { id: 3, value: "QA" },
      { id: 4, name: "规划" },
      { id: 5, value: "constructor" },
    ],
  };
  const sinceField = { id: 91, name: "Loop 阶段开始于", fieldType: "datetime" };
  const since = "2026-11-26T08:00:00.000Z";
  // Each test has its own issue id: the last good stage is kept briefly by id.
  let nextId = 1000;
  const stagedBoard = (opts: {
    fields?: unknown[];
    issue?: (id: unknown) => unknown;
    viaExecuteRead?: boolean;
  }) => {
    const id = nextId++;
    const seen: { tool: string; args: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      const { params } = JSON.parse(String(init.body)) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const { name, arguments: args } = params;
      seen.push({ tool: name, args });
      const fields = { ok: true, data: opts.fields ?? [stageField, sinceField] };
      let data: unknown;
      if (name === "get_project") data = { project: {}, columns: boardColumns, labels: [] };
      else if (name === "list_custom_fields") {
        if (opts.viaExecuteRead) throw new Error("unknown tool");
        data = fields;
      } else if (name === "execute_read") data = fields;
      else if (name === "get_issue") {
        const r = opts.issue?.(args.issueId);
        if (r instanceof Error) throw r;
        data = r;
      } else data = [{ ...issue(Number(args.columnId) * 10, Number(args.columnId)), id }];
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify(data) }] },
        }),
      );
    }) as unknown as typeof fetch;
    return { id, seen, fetchImpl };
  };
  const withOption = (optionId: number) => () => ({
    fields: [
      { name: "Loop 阶段", optionIds: [optionId] },
      { name: "Loop 阶段开始于", value: since },
    ],
  });
  const tickets = (b: Awaited<ReturnType<typeof answerBoard>>, name: string) => {
    if (b.kind !== "ok") throw new Error("expected a board");
    return b.columns.find((c) => c.name === name)?.tickets ?? [];
  };
  const progress = async (opts: Parameters<typeof stagedBoard>[0]) => {
    writeKey(0o600);
    const made = stagedBoard(opts);
    return { ...made, board: await answerBoard(loop, "CYC", () => {}, made.fetchImpl) };
  };

  test("In Progress tickets carry the stage; other columns are not read", async () => {
    const { board, seen, id } = await progress({ issue: withOption(3) });
    expect(tickets(board, "In Progress")[0]?.loopStage).toEqual({ stage: "qa", since });
    expect(tickets(board, "In Review")[0]).not.toHaveProperty("loopStage");
    expect(seen.filter((s) => s.tool === "get_issue").map((s) => s.args.issueId)).toEqual([id]);
  });

  test("an option labelled by `name`, an optional phase, and a label that is not a stage", async () => {
    const plan = await progress({ issue: withOption(4) });
    expect(tickets(plan.board, "In Progress")[0]?.loopStage?.stage).toBe("plan");
    const odd = await progress({ issue: withOption(5) });
    expect(tickets(odd.board, "In Progress")[0]).not.toHaveProperty("loopStage");
  });

  test("the field list is read through execute_read when the direct tool is not there", async () => {
    const { board, seen } = await progress({ issue: withOption(1), viaExecuteRead: true });
    expect(tickets(board, "In Progress")[0]?.loopStage?.stage).toBe("develop");
    expect(seen.some((s) => s.tool === "execute_read")).toBe(true);
  });

  test("a failed read, a missing field or an empty field leaves the card without a stage", async () => {
    const failed = await progress({ issue: () => new Error("boom") });
    expect(tickets(failed.board, "In Progress")).toHaveLength(1);
    expect(tickets(failed.board, "In Progress")[0]).not.toHaveProperty("loopStage");
    const missing = await progress({ fields: [stageField], issue: withOption(3) });
    expect(tickets(missing.board, "In Progress")[0]).not.toHaveProperty("loopStage");
    expect(missing.seen.some((s) => s.tool === "get_issue")).toBe(false);
    const empty = await progress({
      issue: () => ({ fields: [{ name: "Loop 阶段", optionIds: [] }] }),
    });
    expect(tickets(empty.board, "In Progress")[0]).not.toHaveProperty("loopStage");
    expect(tickets(empty.board, "Todo")).toHaveLength(1);
  });
});

describe("tickets waiting for approval (CYC-451)", () => {
  const PENDING = 40;
  const SKIP = 41;
  const labels = [
    { id: 11, name: "auto" },
    { id: 5, name: "产品" },
    { id: PENDING, name: "待批准" },
    { id: SKIP, name: "Loop 跳过" },
  ];
  type Row = { id: number; n: number; columnId: number; labelIds: number[]; body?: string };
  const BODY = "x\n\n## 验收标准\n\n1. 一\n2. 二\n3. 三\n\n## 依赖\n\n- no";
  const NOTES = "Loop 规划\n\n拆小了，范围清楚。\n第二行\n\n盘点的理由：合适";
  /** A tracker with a few tickets and their comments; it remembers every write. */
  const world = (
    rows: Row[],
    opts: { labels?: typeof labels; commentsFail?: number[]; noComments?: boolean } = {},
  ) => {
    const writes: { tool: string; args: Record<string, unknown> }[] = [];
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      const { params } = JSON.parse(String(init.body)) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      const { name, arguments: args } = params;
      let data: unknown;
      if (name === "get_project")
        data = {
          project: {},
          columns: columns.map((c, position) => ({ ...c, position })),
          labels: opts.labels ?? labels,
        };
      else if (name === "list_issues")
        data = rows
          .filter((r) => r.columnId === args.columnId)
          .map((r) => ({
            id: r.id,
            identifier: `CYC-${r.n}`,
            title: `Ticket ${r.n}`,
            priority: "high",
            columnId: r.columnId,
            labelIds: r.labelIds,
          }));
      else if (name === "get_issue_by_number") {
        const r = rows.find((x) => x.n === args.sequenceNumber);
        if (!r) return new Response("no", { status: 404 });
        data = {
          id: r.id,
          identifier: `CYC-${r.n}`,
          title: `Ticket ${r.n}`,
          columnId: r.columnId,
          labelIds: r.labelIds,
          description: r.body ?? BODY,
        };
      } else if (name === "execute_read") {
        if (opts.commentsFail?.includes(Number((args.arguments as { issueId?: number }).issueId)))
          return new Response("no", { status: 500 });
        data = {
          items: opts.noComments
            ? []
            : [
                { id: 2, body: "别的评论", createdAt: "2026-11-26T02:00:00Z" },
                { id: 1, body: NOTES, createdAt: "2026-11-26T01:00:00Z" },
              ],
        };
      } else {
        writes.push({ tool: name, args });
        data = { ok: true };
      }
      return new Response(
        JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(data) }] } }),
      );
    }) as unknown as typeof fetch;
    return { writes, fetchImpl };
  };
  const many = (
    action: string,
    ids: string[],
    t: ReturnType<typeof world>,
    confirmed: unknown = true,
    reason?: unknown,
    events: unknown[] = [],
  ) =>
    actOnMany(
      loop,
      "CYC",
      action,
      ids,
      confirmed,
      reason,
      (e, p) => events.push([e, p]),
      t.fetchImpl,
    );

  const backlogOf = async (t: ReturnType<typeof world>) => {
    const b = await answerBoard(loop, "CYC", () => {}, t.fetchImpl);
    if (b.kind !== "ok") throw new Error("expected a board");
    return b.columns.find((c) => c.name === "Backlog")?.tickets ?? [];
  };

  test("the board marks Backlog tickets with 待批准, with the reason and the criteria count", async () => {
    writeKey(0o600);
    const t = world([
      { id: 1, n: 1, columnId: 21, labelIds: [PENDING, 5] },
      { id: 2, n: 2, columnId: 21, labelIds: [5] },
      { id: 3, n: 3, columnId: 22, labelIds: [PENDING] },
    ]);
    const tickets = await backlogOf(t);
    expect(tickets.find((x) => x.identifier === "CYC-1")?.pending).toEqual({
      reason: "拆小了，范围清楚。 第二行",
      criteria: 3,
    });
    expect(tickets.find((x) => x.identifier === "CYC-2")?.pending).toBeUndefined();
  });

  test("a failed read leaves that card without a reason; the rest of the board is as it was", async () => {
    writeKey(0o600);
    const t = world(
      [
        { id: 1, n: 1, columnId: 21, labelIds: [PENDING] },
        { id: 2, n: 2, columnId: 21, labelIds: [PENDING] },
      ],
      { commentsFail: [1] },
    );
    const tickets = await backlogOf(t);
    expect(tickets.find((x) => x.identifier === "CYC-1")?.pending?.reason).toBe("");
    expect(tickets.find((x) => x.identifier === "CYC-2")?.pending?.reason).toBe(
      "拆小了，范围清楚。 第二行",
    );
  });

  test("no 待批准 label in the Project: no pending", async () => {
    writeKey(0o600);
    const t = world([{ id: 1, n: 1, columnId: 21, labelIds: [PENDING] }], {
      labels: labels.filter((l) => l.id !== PENDING),
    });
    expect((await backlogOf(t)).every((x) => x.pending === undefined)).toBe(true);
  });

  test("approving many without confirmation writes nothing, not even a read", async () => {
    writeKey(0o600);
    const t = world([{ id: 1, n: 1, columnId: 21, labelIds: [PENDING] }]);
    const seen: string[] = [];
    const spy = (async (u: unknown, i: RequestInit) => {
      seen.push(String(i.body));
      return t.fetchImpl(u as never, i);
    }) as unknown as typeof fetch;
    for (const confirmed of [undefined, "yes", false])
      expect(
        await actOnMany(
          loop,
          "CYC",
          "approve_many",
          ["CYC-1"],
          confirmed,
          undefined,
          () => {},
          spy,
        ),
      ).toEqual({ kind: "failed", reason: "unconfirmed" });
    expect(seen).toEqual([]);
    expect(t.writes).toEqual([]);
  });

  test("approving many: Todo, auto on, 待批准 off, other labels kept; skips and results per ticket", async () => {
    writeKey(0o600);
    const t = world([
      { id: 1, n: 1, columnId: 21, labelIds: [5, PENDING] },
      { id: 2, n: 2, columnId: 22, labelIds: [PENDING] }, // not in Backlog any more
      { id: 3, n: 3, columnId: 21, labelIds: [5] }, // no 待批准 now
    ]);
    const events: unknown[] = [];
    const result = await many(
      "approve_many",
      ["CYC-1", "CYC-2", "CYC-3", "CYC-9"],
      t,
      true,
      undefined,
      events,
    );
    expect(result).toEqual({
      kind: "done",
      results: [
        { identifier: "CYC-1", outcome: "ok" },
        { identifier: "CYC-2", outcome: "skipped" },
        { identifier: "CYC-3", outcome: "skipped" },
        { identifier: "CYC-9", outcome: "failed", reason: "refused" },
      ],
    });
    expect(t.writes).toEqual([
      { tool: "update_issue", args: { issueId: 1, columnId: 22, labelIds: [5, 11] } },
    ]);
    expect(events).toEqual([
      ["loop_tickets_acted", { action: "approve_many", ok: 1, skipped: 2, failed: 1 }],
    ]);
  });

  test("returning many: 待批准 off, Loop 跳过 on, a reason becomes a comment, none means no comment", async () => {
    writeKey(0o600);
    const rows = [
      { id: 1, n: 1, columnId: 21, labelIds: [5, PENDING] },
      { id: 2, n: 2, columnId: 21, labelIds: [PENDING] },
    ];
    const a = world(rows);
    expect((await many("return_many", ["CYC-1", "CYC-2"], a, true, "  不做了  ")).kind).toBe(
      "done",
    );
    // Tickets are written a few at a time: the order between them is not fixed, within one it is.
    const of = (id: number) => a.writes.filter((w) => w.args.issueId === id);
    expect(of(1)).toEqual([
      { tool: "update_issue", args: { issueId: 1, labelIds: [5, SKIP] } },
      { tool: "add_comment", args: { issueId: 1, body: "不做了" } },
    ]);
    expect(of(2)).toEqual([
      { tool: "update_issue", args: { issueId: 2, labelIds: [SKIP] } },
      { tool: "add_comment", args: { issueId: 2, body: "不做了" } },
    ]);
    const b = world(rows);
    await many("return_many", ["CYC-1"], b);
    expect(b.writes.map((w) => w.tool)).toEqual(["update_issue"]);
    expect(await many("return_many", ["CYC-1"], world(rows), false)).toEqual({
      kind: "failed",
      reason: "unconfirmed",
    });
  });

  test("the single approve also takes 待批准 off", async () => {
    writeKey(0o600);
    const t = world([{ id: 7, n: 387, columnId: 21, labelIds: [5, PENDING] }]);
    expect(
      await actOnTicket(loop, "CYC", "CYC-387", "approve", true, () => {}, t.fetchImpl),
    ).toEqual({ kind: "ok" });
    expect(t.writes).toEqual([
      { tool: "update_issue", args: { issueId: 7, columnId: 22, labelIds: [5, 11] } },
    ]);
  });
});

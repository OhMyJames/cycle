import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopActFailure, LoopAction } from "@cycle/ui/api";
import {
  actOnGraph,
  actOnMany,
  actOnTicket,
  answerBoard,
  answerNotices,
  answerRun,
  answerRuns,
  answerTicket,
  type Called,
  callLoop,
  cancelLoopRun,
  loopFeed,
  readLoopProjects,
  readLoopRuns,
  retireKeyFile,
  retryLoopIntents,
  startTicketChat,
} from "../src/main/loop.ts";
import { type Answer, type Asked, fakeLoop } from "./loop-server.ts";

const dir = mkdtempSync(join(tmpdir(), "desktop-loop-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const sock = () => join(dir, `s${++n}.sock`);

const card = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Ticket ${key}`,
  type: null,
  priority: "high",
  labels: [],
  pendingReason: null,
  phase: null,
  ...extra,
});
const board = (stale = false) => ({
  project: "CYC",
  stale,
  readAt: "2026-11-26T00:00:00.000Z",
  columns: [
    {
      id: 1,
      name: "Backlog",
      stateType: "backlog",
      cards: [card("CYC-1", { pendingReason: "ready" })],
    },
    {
      id: 3,
      name: "Doing",
      stateType: "started",
      cards: [
        card("CYC-3", {
          parent: { key: "CYC-1", title: "Epic" },
          type: "Task",
          phase: { name: "qa", since: "2026-11-26T00:00:00.000Z" },
        }),
      ],
    },
  ],
});

describe("the board comes from the Loop server and nowhere else", () => {
  test("columns and cards are the server's; stale is passed on; only the kind is reported", async () => {
    const socket = sock();
    const server = await fakeLoop(socket, () => ({ result: board(true) }));
    const events: unknown[] = [];
    const answer = await answerBoard({ socket }, "CYC", (e, p) => events.push([e, p]));
    await server.close();
    expect(server.asked).toEqual([{ method: "loop/board/get", params: { project: "CYC" } }]);
    if (answer.kind !== "ok") throw new Error("expected a board");
    expect(answer.stale).toBe(true);
    expect(answer.columns.map((c) => c.name)).toEqual(["Backlog", "Doing"]);
    expect(answer.columns[0]?.tickets[0]).toMatchObject({
      identifier: "CYC-1",
      pending: { reason: "ready" },
    });
    expect(answer.columns[1]?.tickets[0]?.phase?.name).toBe("qa");
    expect(answer.columns[1]?.tickets[0]).toMatchObject({
      type: "Task",
      parent: { identifier: "CYC-1", title: "Epic" },
    });
    expect(answer.columns[0]?.tickets[0]).toMatchObject({ type: null, parent: null });
    expect(events).toEqual([["loop_board_read", { result: "ok" }]]);
    expect(JSON.stringify(events)).not.toContain("Ticket");
  });

  test("no server on the socket is no_server, and is reported as such", async () => {
    const events: unknown[] = [];
    expect(await answerBoard({ socket: sock() }, "CYC", (e, p) => events.push([e, p]))).toEqual({
      kind: "no_server",
    });
    expect(events).toEqual([["loop_board_read", { result: "no_server" }]]);
  });

  test("an error or an answer that is not the protocol's is unreachable", async () => {
    const a = sock();
    const err = await fakeLoop(a, () => ({
      error: { code: -32603, data: { reason: "tracker_unreachable" } },
    }));
    expect(await answerBoard({ socket: a }, "CYC", () => {})).toEqual({ kind: "unreachable" });
    await err.close();
    const b = sock();
    const odd = await fakeLoop(b, () => ({ result: { columns: "no" } }));
    expect(await answerBoard({ socket: b }, "CYC", () => {})).toEqual({ kind: "unreachable" });
    await odd.close();
  });

  test("no Loop configured is no_server and reports nothing; a bad project key is not sent", async () => {
    const events: unknown[] = [];
    expect(await answerBoard(undefined, "CYC", (e) => events.push(e))).toEqual({
      kind: "no_server",
    });
    const socket = sock();
    const server = await fakeLoop(socket, () => ({ result: board() }));
    expect(await answerBoard({ socket }, "../x?y", (e) => events.push(e))).toEqual({
      kind: "unreachable",
    });
    await server.close();
    expect(events).toEqual([]);
    expect(server.asked).toEqual([]);
  });
});

describe("projects", () => {
  test("no server on the socket is disconnected", async () => {
    expect(await readLoopProjects(sock())).toEqual({ kind: "disconnected" });
  });

  test("a server's projects are read and checked against the protocol", async () => {
    const socket = sock();
    const server = await fakeLoop(socket, () => ({
      result: {
        projects: [
          { name: "Cycle", projectKey: "CYC", repo: { displayName: "o/r", forge: "github" } },
        ],
      },
    }));
    const answer = await readLoopProjects(socket);
    await server.close();
    expect(answer).toEqual({
      kind: "ok",
      projects: [
        { name: "Cycle", projectKey: "CYC", repo: { displayName: "o/r", forge: "github" } },
      ],
    });
  });

  test("an answer that is not the protocol's is disconnected", async () => {
    const socket = sock();
    const server = await fakeLoop(socket, () => ({ result: { projects: [{ name: 1 }] } }));
    expect(await readLoopProjects(socket)).toEqual({ kind: "disconnected" });
    await server.close();
  });

  test("a server that never answers is given up on", async () => {
    const socket = sock();
    const { createServer } = await import("node:net");
    const silent = createServer(() => {});
    await new Promise<void>((r) => silent.listen(socket, r));
    expect(await callLoop(socket, "loop/status", undefined, 100)).toEqual({ kind: "no_server" });
    silent.close();
  });
});

describe("Notices", () => {
  const notice = (kind: string, key: string, session: unknown = null) => ({
    id: `CYC:${kind}:${key}`,
    project: "CYC",
    kind,
    key,
    session,
    text: "why",
    at: "2026-11-26T00:00:00.000Z",
  });

  test("research and QA sessions come through as the server names them; counts are reported, not content", async () => {
    const socket = sock();
    const server = await fakeLoop(socket, () => ({
      result: {
        notices: [
          notice("permission", "CYC-1", { kind: "research", id: "s-r" }),
          notice("permission", "CYC-2", { kind: "qa", id: "s-q" }),
          notice("blocked", "CYC-3", { kind: "dev", id: "s-d" }),
          notice("stuck", "CYC-4"),
        ],
      },
    }));
    const events: unknown[] = [];
    const answer = await answerNotices({ socket }, "CYC", (e, p) => events.push([e, p]));
    await server.close();
    expect(server.asked).toEqual([{ method: "loop/notices/list", params: { project: "CYC" } }]);
    if (answer.kind !== "ok") throw new Error("expected notices");
    expect(answer.notices.map((x) => [x.identifier, x.session?.kind])).toEqual([
      ["CYC-1", "research"],
      ["CYC-2", "qa"],
      ["CYC-3", "dev"],
      ["CYC-4", undefined],
    ]);
    expect(events).toEqual([
      ["loop_notices_read", { permission: 2, blocked: 1, review: 0, stuck: 1, intent_stuck: 0 }],
    ]);
  });

  test("no server, and an error, are said as they are", async () => {
    expect(await answerNotices({ socket: sock() }, "CYC", () => {})).toEqual({ kind: "no_server" });
    const socket = sock();
    const server = await fakeLoop(socket, () => ({ error: { code: -32603 } }));
    expect(await answerNotices({ socket }, "CYC", () => {})).toEqual({ kind: "unreachable" });
    await server.close();
  });
});

describe("approving and returning a batch", () => {
  const act =
    (results: unknown) =>
    (asked: Asked): Answer =>
      asked.method === "loop/tickets/act" ? { result: { results } } : { error: { code: -32601 } };

  test("approving sends the person's name as actor, and maps each ticket's result", async () => {
    const socket = sock();
    const server = await fakeLoop(
      socket,
      act([
        { key: "CYC-1", status: "ok" },
        { key: "CYC-2", status: "skipped", reason: "not_pending" },
        { key: "CYC-3", status: "failed", reason: "forbidden" },
      ]),
    );
    const result = await actOnMany(
      { socket, actor: () => " 小明 " },
      "CYC",
      "approve_many",
      ["CYC-1", "CYC-2", "CYC-3", "CYC-1"],
      true,
      "ignored for approve",
    );
    await server.close();
    expect(server.asked).toEqual([
      {
        method: "loop/tickets/act",
        params: {
          project: "CYC",
          verb: "approve",
          keys: ["CYC-1", "CYC-2", "CYC-3"],
          confirmed: true,
          actor: "小明",
          actorKind: "desktop",
        },
      },
    ]);
    expect(result).toEqual({
      kind: "done",
      results: [
        { identifier: "CYC-1", outcome: "ok" },
        { identifier: "CYC-2", outcome: "skipped" },
        { identifier: "CYC-3", outcome: "failed", reason: "forbidden" },
      ],
    });
  });

  test("with no name given the actor says where it came from; returning sends the reason", async () => {
    const socket = sock();
    const server = await fakeLoop(socket, act([{ key: "CYC-1", status: "ok" }]));
    await actOnMany({ socket, actor: () => "" }, "CYC", "return_many", ["CYC-1"], true, " 不合适 ");
    await server.close();
    expect(server.asked[0]?.params).toMatchObject({
      verb: "return",
      reason: "不合适",
      actor: "desktop",
      actorKind: "desktop",
    });
  });

  test("nothing is sent without confirmation, with no tickets, with too many, or with a bad action", async () => {
    const socket = sock();
    const server = await fakeLoop(socket, act([]));
    const loop = { socket };
    expect(await actOnMany(loop, "CYC", "approve_many", ["CYC-1"], false, "")).toEqual({
      kind: "failed",
      reason: "unconfirmed",
    });
    expect(await actOnMany(loop, "CYC", "approve_many", [], true, "")).toEqual({
      kind: "failed",
      reason: "refused",
    });
    const many = Array.from({ length: 51 }, (_, i) => `CYC-${i + 1}`);
    expect(await actOnMany(loop, "CYC", "approve_many", many, true, "")).toEqual({
      kind: "failed",
      reason: "refused",
    });
    expect(await actOnMany(loop, "CYC", "delete", ["CYC-1"], true, "")).toEqual({
      kind: "failed",
      reason: "refused",
    });
    await server.close();
    expect(server.asked).toEqual([]);
  });

  test("no server is no_server; a server error is said in a fixed word", async () => {
    expect(await actOnMany({ socket: sock() }, "CYC", "approve_many", ["CYC-1"], true, "")).toEqual(
      {
        kind: "failed",
        reason: "no_server",
      },
    );
    const socket = sock();
    const server = await fakeLoop(socket, () => ({
      error: { code: -32602, data: { reason: "actor_required" } },
    }));
    expect(await actOnMany({ socket }, "CYC", "return_many", ["CYC-1"], true, "")).toEqual({
      kind: "failed",
      reason: "refused",
    });
    await server.close();
  });
});

describe("the old itsaplan key file", () => {
  test("is removed at start and the person is told once; with none, nothing is said", async () => {
    const file = join(dir, "itsaplan-key");
    writeFileSync(file, "old-secret\n");
    let told = 0;
    expect(await retireKeyFile(file, () => told++)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(told).toBe(1);
    expect(await retireKeyFile(file, () => told++)).toBe(false);
    expect(told).toBe(1);
  });
});

const detail = (extra: Record<string, unknown> = {}) => ({
  identifier: "CYC-9",
  title: "Nine",
  priority: "high",
  column: "Backlog",
  actions: ["approve", "to_todo"] as LoopAction[],
  chat: "new" as const,
  body: "The text.",
  acceptance: ["one", "two"],
  links: ["https://example.com/pr/1"],
  ...extra,
});
const ticketServer =
  (extra: Record<string, unknown> = {}) =>
  (asked: Asked): Answer =>
    asked.method === "loop/ticket/get" ? { result: detail(extra) } : { error: { code: -32601 } };

describe("the ticket page (loop/ticket/get)", () => {
  test("the text, criteria, links, buttons and chat are the server's; the event carries no content", async () => {
    const socket = sock();
    const server = await fakeLoop(
      socket,
      ticketServer({
        attention: { kind: "review", text: "Look", prUrl: "https://example.com/pr/1" },
      }),
    );
    const events: unknown[] = [];
    const answer = await answerTicket({ socket }, "CYC", "CYC-9", (e, p) => events.push([e, p]));
    await server.close();
    expect(server.asked).toEqual([
      { method: "loop/ticket/get", params: { project: "CYC", key: "CYC-9" } },
    ]);
    expect(answer).toEqual({
      kind: "ok",
      ticket: {
        ...detail(),
        attention: { kind: "review", text: "Look", prUrl: "https://example.com/pr/1" },
      },
    });
    expect(events).toEqual([["loop_ticket_opened", {}]]);
  });

  test("no server, a wrong answer, a ticket of another Project: said, and nothing sent for the last", async () => {
    expect(await answerTicket({ socket: sock() }, "CYC", "CYC-9", () => {})).toEqual({
      kind: "no_server",
    });
    expect(await answerTicket(undefined, "CYC", "CYC-9", () => {})).toEqual({ kind: "no_server" });
    const socket = sock();
    const server = await fakeLoop(socket, () => ({ result: { nope: true } }));
    expect(await answerTicket({ socket }, "CYC", "CYC-9", () => {})).toEqual({
      kind: "unreachable",
    });
    expect(await answerTicket({ socket }, "CYC", "OTHER-9", () => {})).toEqual({
      kind: "unreachable",
    });
    await server.close();
    expect(server.asked).toHaveLength(1);
  });
});

describe("state buttons (loop/tickets/act with one key)", () => {
  const one =
    (status: Record<string, unknown>) =>
    (asked: Asked): Answer =>
      asked.method === "loop/tickets/act"
        ? { result: { results: [{ key: "CYC-9", ...status }] } }
        : { error: { code: -32601 } };

  test("a confirmed approval is one act with the person's name; the event is the action and the result", async () => {
    const socket = sock();
    const server = await fakeLoop(socket, one({ status: "ok" }));
    const events: unknown[] = [];
    const result = await actOnTicket(
      { socket, actor: () => "小明" },
      "CYC",
      "CYC-9",
      "approve",
      true,
      (e, p) => events.push([e, p]),
    );
    await server.close();
    expect(result).toEqual({ kind: "ok" });
    expect(server.asked).toEqual([
      {
        method: "loop/tickets/act",
        params: {
          project: "CYC",
          verb: "approve",
          keys: ["CYC-9"],
          confirmed: true,
          actor: "小明",
          actorKind: "desktop",
        },
      },
    ]);
    expect(events).toEqual([["loop_ticket_acted", { action: "approve", result: "ok" }]]);
  });

  test("back to Backlog and to Todo are verbs of their own, and need no confirmation", async () => {
    for (const action of ["to_backlog", "to_todo"]) {
      const socket = sock();
      const server = await fakeLoop(socket, one({ status: "ok" }));
      expect(await actOnTicket({ socket }, "CYC", "CYC-9", action, false, () => {})).toEqual({
        kind: "ok",
      });
      await server.close();
      expect(server.asked[0]?.params).toMatchObject({ verb: action, actor: "desktop" });
    }
  });

  test("approving without confirmation, a bad action, or another Project's ticket sends nothing", async () => {
    const socket = sock();
    const server = await fakeLoop(socket, one({ status: "ok" }));
    const loop = { socket };
    expect(await actOnTicket(loop, "CYC", "CYC-9", "approve", false, () => {})).toEqual({
      kind: "failed",
      reason: "unconfirmed",
    });
    expect(await actOnTicket(loop, "CYC", "CYC-9", "delete", true, () => {})).toEqual({
      kind: "failed",
      reason: "refused",
    });
    expect(await actOnTicket(loop, "CYC", "OTHER-9", "to_todo", true, () => {})).toEqual({
      kind: "failed",
      reason: "refused",
    });
    await server.close();
    expect(server.asked).toEqual([]);
  });

  test("a skipped ticket is not_allowed; failures and a missing server are said in fixed words", async () => {
    const cases: [Record<string, unknown>, LoopActFailure][] = [
      [{ status: "skipped", reason: "not_in_backlog" }, "not_allowed"],
      [{ status: "failed", reason: "forbidden" }, "forbidden"],
      [{ status: "failed", reason: "conflict" }, "conflict"],
      [{ status: "failed", reason: "offline" }, "offline"],
      [{ status: "failed", reason: "label_missing" }, "refused"],
    ];
    for (const [status, reason] of cases) {
      const socket = sock();
      const server = await fakeLoop(socket, one(status));
      const events: unknown[] = [];
      expect(
        await actOnTicket({ socket }, "CYC", "CYC-9", "to_todo", false, (e, p) =>
          events.push([e, p]),
        ),
      ).toEqual({ kind: "failed", reason });
      await server.close();
      expect(events).toEqual([["loop_ticket_acted", { action: "to_todo", result: reason }]]);
    }
    expect(
      await actOnTicket({ socket: sock() }, "CYC", "CYC-9", "to_todo", false, () => {}),
    ).toEqual({
      kind: "failed",
      reason: "no_server",
    });
  });
});

describe("a conversation about a ticket (CYC-389)", () => {
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
  const withChat = async (chat: string) => {
    const socket = sock();
    const server = await fakeLoop(socket, ticketServer({ chat }));
    return { loop: { socket }, close: server.close };
  };

  test("a ticket the server says is new gets a session with its number and the default model", async () => {
    const { loop, close } = await withChat("new");
    const { made, prompts, events, deps, track } = setup({ model: "deepseek-flash" });
    const result = await startTicketChat(loop, deps, "CYC", "CYC-9", track);
    await close();
    expect(result).toEqual({ kind: "started", locationId: "local", sessionId: "s1" });
    expect(made).toEqual([
      { cwd: join(dir, "work"), agent: "codex", config: { model: "deepseek-flash" } },
    ]);
    expect(prompts[0]).toContain("CYC-9");
    // Only the word of the outcome: no ticket, no text.
    expect(events).toEqual([["loop_ticket_chat", { result: "started" }]]);
  });

  test("watch and none are not allowed: no session is made", async () => {
    for (const chat of ["watch", "none"]) {
      const { loop, close } = await withChat(chat);
      const { made, deps, track } = setup({ model: "deepseek-flash" });
      const result = await startTicketChat(loop, deps, "CYC", "CYC-9", track);
      await close();
      expect(result).toEqual({ kind: "failed", reason: "not_allowed" });
      expect(made).toEqual([]);
    }
  });

  test("with no default model it says so and makes nothing", async () => {
    for (const defaults of [{}, { model: "  " }]) {
      const { loop, close } = await withChat("new");
      const { made, events, deps, track } = setup(defaults);
      const result = await startTicketChat(loop, deps, "CYC", "CYC-9", track);
      await close();
      expect(result).toEqual({ kind: "failed", reason: "needs_model" });
      expect(made).toEqual([]);
      expect(events).toEqual([["loop_ticket_chat", { result: "needs_model" }]]);
    }
  });

  test("no server is said so; no key is not a word any more", async () => {
    const { deps, track, events } = setup({ model: "m" });
    expect(await startTicketChat({ socket: sock() }, deps, "CYC", "CYC-9", track)).toEqual({
      kind: "failed",
      reason: "no_server",
    });
    expect(await startTicketChat(undefined, deps, "CYC", "CYC-9", track)).toEqual({
      kind: "failed",
      reason: "no_server",
    });
    expect(events).toEqual([
      ["loop_ticket_chat", { result: "no_server" }],
      ["loop_ticket_chat", { result: "no_server" }],
    ]);
  });

  test("the session runs in the ticket-chat folder, made on first use, never the home folder", async () => {
    const cwd = join(dir, "data", "ticket-chat");
    const a = await withChat("new");
    const { made, deps, track } = setup({ model: "deepseek-flash" });
    await startTicketChat(a.loop, { ...deps, cwd }, "CYC", "CYC-9", track);
    await a.close();
    expect(made).toEqual([{ cwd, agent: "codex", config: { model: "deepseek-flash" } }]);
    expect(statSync(cwd).isDirectory()).toBe(true);
    const b = await withChat("new");
    const none = setup({ model: "deepseek-flash" });
    const result = await startTicketChat(
      b.loop,
      { ...none.deps, cwd: "" },
      "CYC",
      "CYC-9",
      none.track,
    );
    await b.close();
    expect(result).toEqual({ kind: "failed", reason: "no_folder" });
    expect(none.made).toEqual([]);
  });

  test("a first message that does not go leaves the session's id with the failure", async () => {
    const { loop, close } = await withChat("new");
    const { deps, track } = setup({ model: "deepseek-flash" });
    const failing = {
      ...deps,
      cwd: join(dir, "chat2"),
      prompt: async () => {
        throw new Error("down");
      },
    };
    const result = await startTicketChat(loop, failing, "CYC", "CYC-9", track);
    await close();
    expect(result).toEqual({
      kind: "failed",
      reason: "failed",
      sessionId: "s1",
      locationId: "local",
    });
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
      call: (method, params) => callLoop(socket, method, params, 3000),
      changed: (runs) => told.push(runs),
    });
    try {
      await feed.tick(); // reads the runs, then catches up on the log
      expect(told).toEqual([{ kind: "ok", running: { CYC: ["CYC-1"] } }]);
      expect(feed.lastSeq("CYC")).toBe(2);
      expect(asked).toEqual([0]);

      // The server goes away: nothing is asked of it, and the last seq is kept.
      await new Promise((r) => server.close(r));
      // One or two misses keep what was known; the third in a row says the server is away.
      await feed.tick();
      await feed.tick();
      expect(told).toHaveLength(1);
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
      call: (method, params) => callLoop(socket, method, params, 3000),
      changed: (runs) => told.push(runs),
    });
    try {
      expect(await feed.read()).toEqual({ kind: "ok", running: { CYC: ["CYC-1"] } });
      expect(told).toHaveLength(1);
      expect(await feed.read()).toEqual({ kind: "ok", running: { CYC: ["CYC-1"] } });
      expect(told).toHaveLength(1);
      await new Promise((r) => server.close(r));
      expect((await feed.read()).kind).toBe("ok");
      expect((await feed.read()).kind).toBe("ok");
      expect(told).toHaveLength(1);
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
        call: (method, params) => callLoop(socket, method, params, 3000),
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
        call: (method, params) => callLoop(socket, method, params, 3000),
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
      call: (method, params) => callLoop(socket, method, params, 3000),
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
    const waiting: ((value: Called) => void)[] = [];
    const told: unknown[] = [];
    const feed = loopFeed({
      call: () => new Promise<Called>((resolve) => waiting.push(resolve)),
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

  test("one Project whose events are broken does not hold back a healthy one", async () => {
    const socket = join(dir, "two.sock");
    let ops: string[] = ["CYC-5"];
    let ops2seq = 1;
    const server = createServer((c) =>
      c.on("data", (chunk) => {
        const req = JSON.parse(chunk.toString("utf8").split("\n")[0] ?? "{}") as {
          method: string;
          params?: { projectKey?: string; afterSeq?: number };
        };
        const send = (o: object) => c.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, ...o })}\n`);
        if (req.method === "runs/list")
          return send({
            result: {
              projects: [
                { projectKey: "BAD", runs: [] },
                { projectKey: "OPS", runs: ops.map((k) => run(k, "active")) },
              ],
            },
          });
        if (req.params?.projectKey === "BAD")
          return send({ error: { code: -32603, message: "Internal error" } });
        const after = req.params?.afterSeq ?? 0;
        const events = after < ops2seq ? [event(ops2seq)] : [];
        send({ result: { projectKey: "OPS", events, lastSeq: ops2seq, hasMore: false } });
      }),
    );
    await new Promise<void>((r) => server.listen(socket, r));
    const told: unknown[] = [];
    try {
      const feed = loopFeed({
        call: (method, params) => callLoop(socket, method, params, 3000),
        changed: (runs) => told.push(runs),
      });
      for (let i = 0; i < 4; i++) await feed.tick();
      // BAD is backing off; a new event in OPS still gets through at once.
      ops = ["CYC-5", "CYC-6"];
      ops2seq = 2;
      await feed.tick();
      expect(told.at(-1)).toEqual({ kind: "ok", running: { BAD: [], OPS: ["CYC-5", "CYC-6"] } });
    } finally {
      server.close();
    }
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
        call: (method, params) => callLoop(socket, method, params, 3000),
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

describe("graph nodes (loop/graph/act)", () => {
  const graph = {
    runKey: "CYC-9",
    source: "plan_doc",
    revision: 2,
    currentNodeId: "n1",
    nodes: [
      {
        id: "n1",
        position: 0,
        origin: "planned",
        title: "Secret title",
        goal: "Secret goal",
        dependsOn: [],
        filesHint: [],
        verify: ["bun test"],
        status: "pending",
        sessionId: null,
        commitSha: null,
        rounds: 0,
        lastError: null,
        summary: null,
        startedAt: null,
        finishedAt: null,
      },
    ],
    createdAt: "2026-11-26T00:00:00Z",
    updatedAt: "2026-11-26T00:00:00Z",
  };
  const ok = (asked: Asked): Answer =>
    asked.method === "loop/graph/act"
      ? { result: { key: "CYC-9", nodeId: "n1", action: "retry_node", phase: "graph_plan", graph } }
      : { error: { code: -32601 } };

  test("a retry is one act with the node and the person; the event is the action and result only", async () => {
    const socket = sock();
    const server = await fakeLoop(socket, ok);
    const events: unknown[] = [];
    const result = await actOnGraph(
      { socket, actor: () => "小明" },
      "CYC",
      "CYC-9",
      "n1",
      "retry_node",
      (e, p) => events.push([e, p]),
    );
    await server.close();
    expect(result).toEqual({ kind: "ok" });
    expect(server.asked).toEqual([
      {
        method: "loop/graph/act",
        params: {
          project: "CYC",
          key: "CYC-9",
          nodeId: "n1",
          action: "retry_node",
          actor: "小明",
          actorKind: "desktop",
        },
      },
    ]);
    expect(events).toEqual([["loop_graph_acted", { action: "retry_node", result: "ok" }]]);
  });

  test("a node that may not be acted on, no server, and bad input come out as words", async () => {
    const socket = sock();
    const server = await fakeLoop(socket, () => ({
      error: { code: -32602, data: { reason: "node_not_allowed" } },
    }));
    const events: unknown[] = [];
    const track = (e: string, p: unknown) => events.push([e, p]);
    expect(await actOnGraph({ socket }, "CYC", "CYC-9", "n1", "skip_node", track)).toEqual({
      kind: "failed",
      reason: "not_allowed",
    });
    await server.close();
    expect(await actOnGraph({ socket: sock() }, "CYC", "CYC-9", "n1", "skip_node", track)).toEqual({
      kind: "failed",
      reason: "no_server",
    });
    // Not sent, not reported.
    expect(await actOnGraph({ socket }, "CYC", "CYC-9", "n1", "edit_node", track)).toEqual({
      kind: "failed",
      reason: "refused",
    });
    expect(await actOnGraph({ socket }, "CYC", "OTHER-9", "n1", "retry_node", track)).toEqual({
      kind: "failed",
      reason: "refused",
    });
    expect(events).toEqual([
      ["loop_graph_acted", { action: "skip_node", result: "not_allowed" }],
      ["loop_graph_acted", { action: "skip_node", result: "no_server" }],
    ]);
  });
});

describe("run detail, cancel, intent retry and activity feed", () => {
  const runDetail = {
    key: "CYC-9",
    title: "Secret title",
    kind: "dev" as const,
    phase: "qa",
    state: "active" as const,
    round: 1,
    startedAt: "2026-11-26T00:00:00Z",
    updatedAt: "2026-11-26T00:10:00Z",
    blockedReason: null,
    sessions: [{ kind: "dev", id: "sess-1" }],
    prUrl: null,
    events: [{ ts: "2026-11-26T00:00:00Z", kind: "claimed" }],
    heartbeat: { at: "2026-11-26T00:10:00Z", detail: "Running QA" },
  };

  test("answerRun parses a run, maps unknown_run to none, and guards project keys", async () => {
    const socket = sock();
    const server = await fakeLoop(socket, (asked) =>
      asked.params?.key === "CYC-9"
        ? { result: runDetail }
        : { error: { code: -32602, data: { reason: "unknown_run" } } },
    );
    expect(await answerRun({ socket }, "CYC", "CYC-9")).toEqual({
      kind: "ok",
      run: runDetail,
    });
    expect(await answerRun({ socket }, "CYC", "CYC-99")).toEqual({ kind: "none" });
    expect(await answerRun({ socket }, "CYC", "OTHER-9")).toEqual({ kind: "unreachable" });
    await server.close();
    expect(await answerRun({ socket: sock() }, "CYC", "CYC-9")).toEqual({ kind: "no_server" });
    expect(await answerRun(undefined, "CYC", "CYC-9")).toEqual({ kind: "no_server" });
  });

  test("cancelLoopRun calls loop/run/cancel and reports behaviour-only outcome", async () => {
    const socket = sock();
    let cancelled = true;
    const server = await fakeLoop(socket, () => ({ result: { cancelled } }));
    const events: unknown[] = [];
    const track = (e: string, p: unknown) => events.push([e, p]);
    expect(await cancelLoopRun({ socket, actor: () => "小明" }, "CYC", "CYC-9", track)).toEqual({
      kind: "ok",
      cancelled: true,
    });
    cancelled = false;
    expect(await cancelLoopRun({ socket }, "CYC", "CYC-9", track)).toEqual({
      kind: "ok",
      cancelled: false,
    });
    await server.close();
    expect(await cancelLoopRun({ socket: sock() }, "CYC", "CYC-9", track)).toEqual({
      kind: "failed",
      reason: "no_server",
    });
    expect(server.asked[0]).toEqual({
      method: "loop/run/cancel",
      params: { project: "CYC", key: "CYC-9", actor: "小明", actorKind: "desktop" },
    });
    expect(events).toEqual([
      ["loop_run_cancelled", { result: "ok" }],
      ["loop_run_cancelled", { result: "not_running" }],
      ["loop_run_cancelled", { result: "no_server" }],
    ]);
    expect(JSON.stringify(events)).not.toContain("CYC-9");
  });

  test("retryLoopIntents calls loop/intents/retry and reports outcome and count only", async () => {
    const socket = sock();
    const server = await fakeLoop(socket, () => ({ result: { retried: 2 } }));
    const events: unknown[] = [];
    const track = (e: string, p: unknown) => events.push([e, p]);
    expect(await retryLoopIntents({ socket, actor: () => "小明" }, "CYC", "CYC-9", track)).toEqual({
      kind: "ok",
      retried: 2,
    });
    await server.close();
    expect(await retryLoopIntents({ socket: sock() }, "CYC", "CYC-9", track)).toEqual({
      kind: "failed",
      reason: "no_server",
    });
    expect(server.asked[0]).toEqual({
      method: "loop/intents/retry",
      params: { project: "CYC", key: "CYC-9", actor: "小明", actorKind: "desktop" },
    });
    expect(events).toEqual([
      ["loop_intents_retried", { result: "ok", retried: 2 }],
      ["loop_intents_retried", { result: "no_server", retried: 0 }],
    ]);
    expect(JSON.stringify(events)).not.toContain("CYC-9");
  });

  test("loopFeed reports project activity when new events arrive even if active run keys stay the same", async () => {
    let seq = 1;
    const activities: string[][] = [];
    const changes: unknown[] = [];
    const feed = loopFeed({
      call: async (method, params): Promise<Called> => {
        if (method === "runs/list")
          return {
            kind: "ok",
            result: {
              projects: [
                {
                  projectKey: "CYC",
                  runs: [
                    {
                      key: "CYC-9",
                      kind: "dev",
                      state: "active",
                      startedAt: "2026-11-26T00:00:00Z",
                      updatedAt: "2026-11-26T00:01:00Z",
                    },
                  ],
                },
              ],
            },
          };
        const afterSeq = (params as { afterSeq?: number } | undefined)?.afterSeq ?? 0;
        const events =
          seq > afterSeq
            ? [{ seq, ts: "2026-11-26T00:02:00Z", run: "CYC-9", kind: "phase_changed" }]
            : [];
        return { kind: "ok", result: { projectKey: "CYC", events, lastSeq: seq, hasMore: false } };
      },
      changed: (runs) => changes.push(runs),
      activity: (keys) => activities.push(keys),
    });
    await feed.tick(); // seeds history at seq=1: not reported as new activity
    expect(activities).toEqual([]);
    expect(changes).toHaveLength(1);
    seq = 2;
    await feed.tick(); // same active run key, new event -> activity fires!
    expect(activities).toEqual([["CYC"]]);
    expect(changes).toHaveLength(1);
  });
});

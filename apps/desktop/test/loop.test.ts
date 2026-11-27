import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopActFailure, LoopAction } from "@cycle/ui/api";
import {
  actOnMany,
  actOnTicket,
  answerBoard,
  answerNotices,
  answerTicket,
  callLoop,
  readLoopProjects,
  retireKeyFile,
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
      cards: [card("CYC-3", { phase: { name: "qa", since: "2026-11-26T00:00:00.000Z" } })],
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
    expect(events).toEqual([["loop_notices_read", { permission: 2, blocked: 1, review: 0 }]]);
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

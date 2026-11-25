import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopProjectInfo } from "@cycle/ui/api";
import { answerBoard, readLoopProjects } from "../src/main/loop.ts";

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
        ? { project: {}, columns }
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

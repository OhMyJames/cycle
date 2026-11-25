import { expect, test } from "bun:test";
import { join } from "node:path";
import { LineJsonRpcProcess, type LineRpcHandlers, RpcError } from "../src/index.ts";

const peer = join(import.meta.dir, "peer.ts");

const start = (
  handlers: Partial<LineRpcHandlers> = {},
  options: { jsonrpc?: boolean; timeoutMs?: number } = {},
) => {
  const exits: Error[] = [];
  const rpc = new LineJsonRpcProcess(
    {
      name: "peer",
      executable: process.execPath,
      args: [peer],
      cwd: import.meta.dir,
      env: { PATH: process.env.PATH ?? "" },
      jsonrpc: options.jsonrpc ?? true,
      timeoutMs: options.timeoutMs ?? 5_000,
    },
    {
      onNotification: handlers.onNotification ?? (() => {}),
      onRequest: handlers.onRequest ?? (async () => undefined),
      onExit: (error) => exits.push(error),
    },
  );
  return { rpc, exits };
};

test("a request is answered, with or without the jsonrpc field as asked", async () => {
  const on = start();
  const off = start({}, { jsonrpc: false });
  try {
    expect(await on.rpc.request<{ jsonrpc: boolean }>("echo", { a: 1 })).toMatchObject({
      jsonrpc: true,
      got: { method: "echo", params: { a: 1 } },
    });
    expect(await off.rpc.request<{ jsonrpc: boolean }>("echo", {})).toMatchObject({
      jsonrpc: false,
    });
  } finally {
    on.rpc.close();
    off.rpc.close();
  }
}, 10_000);

test("an error answer keeps its code, message and data", async () => {
  const { rpc } = start();
  try {
    const error = await rpc.request("fail", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: -32000, message: "no", data: 1 });
  } finally {
    rpc.close();
  }
}, 10_000);

test("a request of the process is answered with the handler's own code, else an internal error", async () => {
  const { rpc } = start({
    onRequest: async (method) => {
      if (method === "refuse") throw new RpcError(-32602, "bad params");
      if (method === "unknown") throw new RpcError(-32601, "no such method");
      if (method === "ok") return { fine: true };
      if (method === "aborted") throw new DOMException("stopped", "AbortError");
      throw new Error("broke");
    },
  });
  try {
    const answer = (method: string) =>
      rpc.request<{ result?: unknown; error?: { code: number; message: string } }>("ask", {
        method,
      });
    expect((await answer("ok")).result).toEqual({ fine: true });
    expect((await answer("refuse")).error).toEqual({ code: -32602, message: "bad params" });
    expect((await answer("unknown")).error).toEqual({ code: -32601, message: "no such method" });
    expect((await answer("other")).error).toEqual({ code: -32603, message: "broke" });
    // A DOMException's code (20) is not a JSON-RPC one.
    expect((await answer("aborted")).error).toEqual({ code: -32603, message: "stopped" });
  } finally {
    rpc.close();
  }
}, 10_000);

test("blank lines are skipped; a line that is not JSON ends the process", async () => {
  const { rpc, exits } = start();
  expect(await rpc.request("blank", {})).toBe("after blank");
  expect(rpc.closed).toBe(false);
  const waiting = rpc.request("silent", {});
  rpc.notify("garbage", {});
  await expect(waiting).rejects.toThrow();
  expect(rpc.closed).toBe(true);
  expect(exits).toHaveLength(1);
}, 10_000);

test("a request that could not be sent does not wait for an answer", async () => {
  const { rpc } = start({}, { timeoutMs: 0 });
  try {
    await expect(rpc.request("echo", { n: 1n })).rejects.toThrow(TypeError);
    expect(rpc.waiting).toBe(0);
    expect(await rpc.request("echo", {})).toBeDefined();
  } finally {
    rpc.close();
  }
}, 10_000);

test("each request can say how long it waits; 0 waits until the process ends", async () => {
  const { rpc } = start({}, { timeoutMs: 0 });
  const forever = rpc.request("silent", {});
  await expect(rpc.request("silent", {}, 50)).rejects.toThrow("peer timed out: silent");
  expect(rpc.waiting).toBe(1);
  rpc.notify("exit", {});
  await expect(forever).rejects.toThrow("peer exited (3)");
  expect(rpc.waiting).toBe(0);
}, 10_000);

test("notifications both ways", async () => {
  const seen: unknown[] = [];
  const { rpc } = start({ onNotification: (method, params) => seen.push([method, params]) });
  try {
    rpc.notify("note", { x: 1 });
    await rpc.request("echo", {}); // answered after the note's notification
    expect(seen).toEqual([["noted", { x: 1 }]]);
  } finally {
    rpc.close();
  }
}, 10_000);

test("a closed process takes no requests, and close is said once", async () => {
  const { rpc, exits } = start();
  rpc.close();
  rpc.close();
  await expect(rpc.request("echo", {})).rejects.toThrow("peer is closed");
  expect(exits).toHaveLength(1);
}, 10_000);

test("an error answer of the wrong shape is still an RpcError with a code", async () => {
  const { rpc } = start();
  try {
    await expect(rpc.request("bad error", {})).rejects.toMatchObject({
      code: -32603,
      message: "boom",
    });
  } finally {
    rpc.close();
  }
}, 10_000);

test("a message with a null id is neither a request nor a notification", async () => {
  const seen: string[] = [];
  const { rpc } = start({
    onNotification: (method) => seen.push(`note ${method}`),
    onRequest: async (method) => {
      seen.push(`request ${method}`);
    },
  });
  try {
    expect(await rpc.request("null id", {})).toBe("after null id");
    expect(seen).toEqual([]);
  } finally {
    rpc.close();
  }
}, 10_000);

test("an incomplete last line is not a parse error when the process exits", async () => {
  const { rpc, exits } = start();
  await expect(rpc.request("partial", {})).rejects.toThrow("peer exited (0)");
  expect(rpc.closed).toBe(true);
  expect(exits).toHaveLength(1);
  expect(exits[0]?.message).toContain("peer exited (0)");
}, 10_000);

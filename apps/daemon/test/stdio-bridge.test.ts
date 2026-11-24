import { expect, test } from "bun:test";
import { type Spawned, StdioBridge } from "../src/index.ts";

/** A process in this test: what is written to it is recorded, what it says is pushed by the test. */
const fakeProcess = () => {
  const written: unknown[] = [];
  let push: (line: string) => void = () => {};
  let fail: (error: Error) => void = () => {};
  let kills = 0;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (line) => controller.enqueue(new TextEncoder().encode(line));
      fail = (error) => controller.error(error);
    },
  });
  const process: Spawned = {
    stdin: {
      write: (data) => {
        written.push(JSON.parse(data));
      },
      end: () => {},
    },
    stdout,
    exited: new Promise(() => {}),
    kill: () => {
      kills++;
    },
  };
  return { process, written, push: (line: string) => push(line), fail, kills: () => kills };
};

const post = (body: unknown, signal?: AbortSignal) =>
  new Request("http://127.0.0.1/mcp/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });

test("a request is answered with the process's reply to it", async () => {
  const p = fakeProcess();
  const bridge = new StdioBridge(p.process, () => {});
  const answer = bridge.handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  await Bun.sleep(5);
  p.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } })}\n`);
  expect(await (await answer).json()).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  bridge.stop();
});

test("output that breaks ends the process too, and says it failed; a stop by Cycle does not", async () => {
  const broken = fakeProcess();
  const failures: boolean[] = [];
  const bridge = new StdioBridge(broken.process, (failed) => failures.push(failed));
  broken.fail(new Error("stdout broke"));
  await bridge.ended;
  expect(broken.kills()).toBeGreaterThan(0);
  expect(failures).toEqual([true]);

  const stopped = fakeProcess();
  const ends: boolean[] = [];
  const second = new StdioBridge(stopped.process, (failed) => ends.push(failed));
  second.stop();
  stopped.fail(new Error("killed"));
  await second.ended;
  expect(ends).toEqual([false]);
});

test("a request the agent cancels, or gives up on, stops being waited for", async () => {
  const p = fakeProcess();
  const bridge = new StdioBridge(p.process, () => {});
  const first = bridge.handle(post({ jsonrpc: "2.0", id: 7, method: "tools/call" }));
  await Bun.sleep(5);
  await bridge.handle(
    post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }),
  );
  expect(await (await first).json()).toMatchObject({ id: 7, error: { code: -32800 } });

  const controller = new AbortController();
  const second = bridge.handle(
    post({ jsonrpc: "2.0", id: 8, method: "tools/call" }, controller.signal),
  );
  await Bun.sleep(5);
  controller.abort();
  expect(await (await second).json()).toMatchObject({ id: 8, error: { code: -32800 } });
  // The process is told, by the id it was asked with.
  expect(p.written.at(-1)).toMatchObject({
    method: "notifications/cancelled",
    params: { requestId: 2 },
  });
  bridge.stop();
});

test("a batch given up on cancels only its own requests, not another's that reused an answered id", async () => {
  const p = fakeProcess();
  const bridge = new StdioBridge(p.process, () => {});
  const controller = new AbortController();
  const batch = bridge.handle(
    post(
      [
        { jsonrpc: "2.0", id: 5, method: "tools/list" },
        { jsonrpc: "2.0", id: 6, method: "tools/call" },
      ],
      controller.signal,
    ),
  );
  await until(() => p.written.length === 2);
  p.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "five" })}\n`);
  await Bun.sleep(5);
  const other = bridge.handle(post({ jsonrpc: "2.0", id: 5, method: "tools/list" }));
  await until(() => p.written.length === 3);
  controller.abort();
  expect(await (await batch).json()).toEqual([
    { jsonrpc: "2.0", id: 5, result: "five" },
    { jsonrpc: "2.0", id: 6, error: { code: -32800, message: "Request cancelled" } },
  ]);
  p.push(`${JSON.stringify({ jsonrpc: "2.0", id: 3, result: "other" })}\n`);
  expect(await (await other).json()).toEqual({ jsonrpc: "2.0", id: 5, result: "other" });
  bridge.stop();
}, 5_000);

/** Waits, briefly, until `ready` holds. */
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 200 && !ready(); i++) await Bun.sleep(5);
  expect(ready()).toBe(true);
};

test("the process is asked with the bridge's own ids, and each answer goes back with the agent's", async () => {
  const p = fakeProcess();
  const bridge = new StdioBridge(p.process, () => {});
  const first = bridge.handle(post({ jsonrpc: "2.0", id: "a", method: "tools/list" }));
  const second = bridge.handle(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  await until(() => p.written.length === 2);
  expect(p.written).toEqual([
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  // A server that answers a number as a string is understood too.
  p.push(`${JSON.stringify({ jsonrpc: "2.0", id: "2", result: "second" })}\n`);
  p.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "first" })}\n`);
  expect(await (await first).json()).toEqual({ jsonrpc: "2.0", id: "a", result: "first" });
  expect(await (await second).json()).toEqual({ jsonrpc: "2.0", id: 1, result: "second" });
  bridge.stop();
}, 5_000);

test("a request with an id still waiting is refused and not passed on; the first keeps its answer", async () => {
  const p = fakeProcess();
  const bridge = new StdioBridge(p.process, () => {});
  const first = bridge.handle(post({ jsonrpc: "2.0", id: 3, method: "tools/call" }));
  await until(() => p.written.length === 1);
  const again = await bridge.handle(post({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
  expect(await again.json()).toMatchObject({ id: 3, error: { code: -32600 } });
  const batch = bridge.handle(
    post([
      { jsonrpc: "2.0", id: "b", method: "tools/list" },
      { jsonrpc: "2.0", id: "b", method: "tools/list" },
    ]),
  );
  await until(() => p.written.length === 2);
  expect(p.written).toEqual([
    { jsonrpc: "2.0", id: 1, method: "tools/call" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  p.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "first" })}\n`);
  p.push(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: "b" })}\n`);
  expect(await (await first).json()).toEqual({ jsonrpc: "2.0", id: 3, result: "first" });
  expect(await (await batch).json()).toEqual([
    { jsonrpc: "2.0", id: "b", result: "b" },
    { jsonrpc: "2.0", id: "b", error: { code: -32600, message: "Request id already in use" } },
  ]);
  bridge.stop();
}, 5_000);

test("an id used again after its request was cancelled does not get the late answer to the old one", async () => {
  const p = fakeProcess();
  const bridge = new StdioBridge(p.process, () => {});
  const old = bridge.handle(post({ jsonrpc: "2.0", id: 5, method: "tools/call" }));
  await until(() => p.written.length === 1);
  await bridge.handle(
    post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } }),
  );
  expect(await (await old).json()).toMatchObject({ id: 5, error: { code: -32800 } });
  // The process hears of it by its own id; a cancel of what waits no more is not passed on.
  await bridge.handle(
    post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } }),
  );
  const reused = bridge.handle(post({ jsonrpc: "2.0", id: 5, method: "tools/list" }));
  await until(() => p.written.length === 3);
  expect(p.written.slice(1)).toEqual([
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  p.push(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "late, for the old one" })}\n`);
  p.push(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: "new" })}\n`);
  expect(await (await reused).json()).toEqual({ jsonrpc: "2.0", id: 5, result: "new" });
  bridge.stop();
}, 5_000);

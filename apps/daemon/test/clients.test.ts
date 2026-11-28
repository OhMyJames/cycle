import { expect, test } from "bun:test";
import { Clients } from "../src/clients.ts";
import type { Fields, Logger } from "../src/logger.ts";
import type { ClientConn } from "../src/session.ts";

const conn = (id: string, notify: ClientConn["notify"]): ClientConn => ({
  id,
  notify,
  request: async () => undefined,
  elicitation: false,
  updateNotify: false,
  ackReturns: false,
});

test("a client that cannot be told does not stop the others, and is logged without what was said", async () => {
  const warned: [string, Fields | undefined][] = [];
  const none = () => {};
  const log: Logger = {
    error: none,
    warn: (event, fields) => warned.push([event, fields]),
    info: none,
    debug: none,
  };
  const clients = new Clients(log);
  const told: string[] = [];
  clients.add(conn("c1", async () => Promise.reject(new Error("gone"))));
  clients.add(
    conn("c2", async (method) => {
      told.push(method);
    }),
  );
  clients.broadcast("_cycle/test_changed", { secret: "content" });
  await Bun.sleep(0);
  expect(told).toEqual(["_cycle/test_changed"]);
  expect(warned).toEqual([
    ["notify_failed", { conn: "c1", method: "_cycle/test_changed", error: "gone" }],
  ]);
  expect(JSON.stringify(warned)).not.toContain("content");
});

test("a client that keeps failing is logged once, not once per notification", async () => {
  const warned: string[] = [];
  const none = () => {};
  const clients = new Clients({
    error: none,
    warn: (event) => warned.push(event),
    info: none,
    debug: none,
  });
  clients.add(conn("c1", async () => Promise.reject(new Error("gone"))));
  for (let i = 0; i < 5; i++) clients.broadcast("_cycle/test_changed", {});
  await Bun.sleep(0);
  expect(warned).toEqual(["notify_failed"]);
});

test("a client that has gone is told nothing more", async () => {
  const clients = new Clients({ error() {}, warn() {}, info() {}, debug() {} });
  const told: string[] = [];
  const c = conn("c1", async (method) => {
    told.push(method);
  });
  clients.add(c);
  expect(clients.size).toBe(1);
  clients.delete(c);
  clients.broadcast("_cycle/test_changed", {});
  expect(told).toEqual([]);
  expect(clients.size).toBe(0);
});

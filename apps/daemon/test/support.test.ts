import { expect, test } from "bun:test";
import type { TerminalInfo, TerminalOptions } from "@cycle/protocol";
import {
  JsonStore,
  Terminals,
  type UsageFile,
  UsageLedger,
  allowedRequest,
  describeFile,
  isInside,
  localDate,
  normalizePath,
  sameToken,
  tokenDelta,
} from "../src/index.ts";
import { FakeHarness, manualSchedule } from "./fake-harness.ts";

const count = (total: number) => ({
  total,
  input: total,
  cachedInput: 0,
  output: 0,
  reasoning: 0,
});

test.each([
  [{ host: "127.0.0.1:4747", origin: null }, true],
  [{ host: "localhost:4747", origin: "http://localhost:4747" }, true],
  [{ host: "127.0.0.1:4747", origin: "http://127.0.0.1:4747" }, true],
  [{ host: "evil.example:4747", origin: null }, false],
  [{ host: "127.0.0.1:4747", origin: "https://evil.example" }, false],
  [{ host: "127.0.0.1:9999", origin: null }, false],
  [{ host: null, origin: null }, false],
])("request %j is allowed: %p", (headers, allowed) => {
  expect(allowedRequest(headers, 4747)).toBe(allowed);
});

test("a token matches only itself", () => {
  expect(sameToken("secret", "secret")).toBe(true);
  expect(sameToken("secre", "secret")).toBe(false);
  expect(sameToken(null, "secret")).toBe(false);
});

test.each([
  ["/a/b/../c/./d", "/a/c/d"],
  ["/a//b/", "/a/b"],
  ["/../..", "/"],
])("path %p is %p", (path, normal) => {
  expect(normalizePath(path)).toBe(normal);
});

test("a path is inside a folder only when it cannot climb out", () => {
  expect(isInside("/repo/src/a.ts", "/repo")).toBe(true);
  expect(isInside("/repo", "/repo")).toBe(true);
  expect(isInside("/repo/../etc/passwd", "/repo")).toBe(false);
  expect(isInside("/repository/a", "/repo")).toBe(false);
});

test("a file is described as text, binary or an image", () => {
  const text = describeFile("/a/b.ts", new TextEncoder().encode("hi"));
  expect(text).toEqual({ size: 2, binary: false, text: "hi", truncated: false, image: null });
  expect(describeFile("/a/b.bin", new Uint8Array([1, 0, 2]))).toMatchObject({
    binary: true,
    text: "",
  });
  expect(describeFile("/a/b.png", new Uint8Array([137, 80, 0])).image).toEqual({
    mime: "image/png",
    data: "iVAA",
  });
});

test("usage adds up per local day, and a total that fell counts in full", async () => {
  expect(tokenDelta(count(10), count(25)).total).toBe(15);
  expect(tokenDelta(count(30), count(5)).total).toBe(5);
  expect(tokenDelta(null, count(7)).total).toBe(7);
  let now = new Date(2026, 0, 5, 12).getTime();
  const timers = manualSchedule();
  const file = { read: async () => null, write: async () => {} };
  const store = await JsonStore.open<UsageFile>(file, { days: {} }, timers.schedule);
  const ledger = new UsageLedger(store, () => now);
  ledger.add(count(10), 1);
  ledger.add(count(5), 0);
  now += 86_400_000;
  expect(ledger.add(count(1), 1)).toMatchObject({ date: "2026-01-06", turns: 1 });
  expect(ledger.days().map((day) => [day.date, day.tokens.total, day.turns])).toEqual([
    ["2026-01-05", 15, 1],
    ["2026-01-06", 1, 1],
  ]);
  expect(localDate(now)).toBe("2026-01-06");
});

test("a store writes once for a burst of changes, and reads back what was written", async () => {
  const written: string[] = [];
  const timers = manualSchedule();
  const file = {
    read: async () => '{"count":2}',
    write: async (text: string) => void written.push(text),
  };
  const store = await JsonStore.open(file, { count: 0, name: "kept" }, timers.schedule);
  expect(store.value).toEqual({ count: 2, name: "kept" });
  store.update((value) => void value.count++);
  store.update((value) => void value.count++);
  expect(timers.count()).toBe(1);
  timers.run();
  await store.flush();
  expect(written.map((text) => JSON.parse(text) as unknown)).toEqual([{ count: 4, name: "kept" }]);
});

test("a store refuses a file it cannot read instead of starting empty", () => {
  const file = { read: async () => "{not json", write: async () => {} };
  expect(JsonStore.open(file, { sessions: {} })).rejects.toThrow();
});

test("a terminal batches its output, keeps it for the next viewer, and reports its exit", async () => {
  const harness = new FakeHarness();
  let opened: TerminalOptions | null = null;
  const killed: string[] = [];
  harness.openTerminal = async (options) => {
    opened = options;
    return { write() {}, resize() {}, kill: () => void killed.push(options.id) };
  };
  const timers = manualSchedule();
  const output: string[] = [];
  const lists: TerminalInfo[][] = [];
  const terminals = new Terminals({
    harness,
    schedule: timers.schedule,
    shell: "/bin/sh",
    env: {},
    publish: {
      output: (_id, data) => void output.push(new TextDecoder().decode(data)),
      changed: (_sessionId, list) => void lists.push(list),
    },
  });
  const info = await terminals.create("s1", "/project", 80, 24);
  const options = opened as TerminalOptions | null;
  options?.onData(new TextEncoder().encode("a"));
  options?.onData(new TextEncoder().encode("b"));
  expect(output).toEqual([]);
  timers.run();
  expect(output).toEqual(["ab"]);
  expect(new TextDecoder().decode(terminals.snapshot(info.id).data)).toBe("ab");
  options?.onExit(3);
  expect(lists.at(-1)?.[0]).toMatchObject({ exited: true, exitCode: 3 });
  terminals.closeSession("s1");
  expect(killed).toEqual([]);
  expect(terminals.list("s1")).toEqual([]);
});

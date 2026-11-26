import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopEventsListResultSchema } from "@cycle/protocol";
import type { Config } from "../src/config.ts";
import { eventsList } from "../src/events.ts";
import { listen } from "../src/server.ts";
import { RunStore } from "../src/store.ts";

const dir = mkdtempSync(join(tmpdir(), "loop-events-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const fresh = (name: string): string => join(dir, name);
const write = async (state: string, n: number): Promise<void> => {
  const store = new RunStore(state, () => new Date("2026-11-26T02:00:00.000Z"));
  for (let i = 1; i <= n; i++) await store.event(`CYC-${i}`, "phase", { phase: "dev" });
};

describe("events/list", () => {
  test("events get increasing seq in order, and an event never gets two", async () => {
    const state = fresh("a");
    await write(state, 5);
    const one = await eventsList("CYC", state, 0, 100);
    expect(one.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(one.events.map((e) => e.run)).toEqual(["CYC-1", "CYC-2", "CYC-3", "CYC-4", "CYC-5"]);
    await write(state, 2);
    const two = await eventsList("CYC", state, 0, 100);
    expect(two.events.slice(0, 5)).toEqual(one.events);
    expect(two.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(two.events.map((e) => e.seq)).size).toBe(two.events.length);
  });

  test("resuming from a seq returns only larger seqs, with no repeat and no gap", async () => {
    const state = fresh("b");
    await write(state, 7);
    const all = (await eventsList("CYC", state, 0, 100)).events;
    const seen: number[] = [];
    let after = 3;
    seen.push(...all.filter((e) => e.seq <= 3).map((e) => e.seq)); // what the client had before the drop
    for (;;) {
      const page = await eventsList("CYC", state, after, 2);
      expect(page.events.every((e) => e.seq > after)).toBe(true);
      seen.push(...page.events.map((e) => e.seq));
      after = page.lastSeq;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const none = await eventsList("CYC", state, 7, 10);
    expect(none).toEqual({ projectKey: "CYC", events: [], lastSeq: 7, hasMore: false });
  });

  test("a half-written last line waits; a corrupt line keeps its number but is not sent", async () => {
    const state = fresh("c");
    await write(state, 1);
    appendFileSync(join(state, "events.jsonl"), "{broken\n");
    appendFileSync(join(state, "events.jsonl"), '{"ts":"t","run":"CYC-9","kind":"x"');
    let r = await eventsList("CYC", state, 0, 10);
    expect(r.events.map((e) => e.seq)).toEqual([1]);
    expect(r.lastSeq).toBe(2);
    appendFileSync(join(state, "events.jsonl"), "}\n");
    r = await eventsList("CYC", state, r.lastSeq, 10);
    expect(r.events.map((e) => e.seq)).toEqual([3]);
  });

  test("no file is an empty stream; a seq past the end and an unknown directory are errors", async () => {
    expect((await eventsList("CYC", fresh("none"), 0, 10)).events).toEqual([]);
    await expect(eventsList("CYC", fresh("none"), 4, 10)).rejects.toThrow("seq_ahead");
    await expect(eventsList("CYC", undefined, 0, 10)).rejects.toThrow("state_dir_unknown");
  });

  test("the serialized events hold no token, repository address or local path", async () => {
    const state = fresh("d");
    const store = new RunStore(state, () => new Date());
    await store.event("CYC-1", "pr", {
      url: "https://x-access-token:abc@github.com/clawdot/cycle.git",
      token: "ghp_SECRETTOKEN_EVENTS",
      worktree: join(dir, "worktrees", "CYC-1"),
    });
    writeFileSync(join(state, "other"), "");
    const result = LoopEventsListResultSchema.parse(await eventsList("CYC", state, 0, 10));
    const raw = JSON.stringify(result);
    expect(result.events).toHaveLength(1);
    for (const secret of [
      "ghp_SECRETTOKEN_EVENTS",
      "x-access-token",
      "github.com",
      dir,
      "worktree",
    ])
      expect(raw).not.toContain(secret);
  });
});

describe("over the socket", () => {
  const config: Config = {
    projects: [
      {
        name: "Cycle",
        projectKey: "CYC",
        repo: { url: "https://github.com/clawdot/cycle.git", forge: "github" },
        token: "ghp_SOCKETTOKEN",
      },
    ],
  };
  const ask = (
    sock: string,
    params: unknown,
  ): Promise<{ result?: unknown; error?: { code: number } }> =>
    new Promise((resolve) => {
      const socket = connect(sock);
      socket.once("data", (d) => {
        socket.end();
        resolve(JSON.parse(d.toString()));
      });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events/list", params })}\n`);
    });

  test("events/list through the server returns events and resumes", async () => {
    const state = fresh("sock");
    await write(state, 3);
    const server = await listen(config, join(dir, "e.sock"), (k) =>
      k === "CYC" ? state : undefined,
    );
    try {
      const all = await ask(join(dir, "e.sock"), { projectKey: "CYC" });
      expect(LoopEventsListResultSchema.parse(all.result).events.map((e) => e.seq)).toEqual([
        1, 2, 3,
      ]);
      const rest = await ask(join(dir, "e.sock"), { projectKey: "CYC", afterSeq: 2 });
      expect(LoopEventsListResultSchema.parse(rest.result).events.map((e) => e.seq)).toEqual([3]);
      expect((await ask(join(dir, "e.sock"), { projectKey: "NOPE" })).error?.code).toBe(-32602);
      expect((await ask(join(dir, "e.sock"), { projectKey: "CYC", afterSeq: 9 })).error?.code).toBe(
        -32602,
      );
    } finally {
      server.close();
    }
  });
});

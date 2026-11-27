import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { Daemon } from "../src/index.ts";
import { tokensOf } from "../src/search.ts";
import { connectClient } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

type Hit = { sessionId: string; seq: number; from: string; snippet: string };
type Found = { hits: Hit[]; truncated: boolean };

let dir: string;
let dispose: () => Promise<void>;
let open: Daemon[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  for (const daemon of open) await daemon.close();
  open = [];
  await dispose();
});

const text = (t: string) => [{ type: "text" as const, text: t }];

const start = async () => {
  let reply = "";
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say({
        sessionUpdate: "agent_message_chunk",
        messageId: `m${Math.random()}`,
        content: { type: "text", text: reply },
      });
      await say({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
      return "ended";
    },
  });
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  const say = async (prompt: string, answer: string) => {
    reply = answer;
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text(prompt) });
    // The reply is on record once its line is in the history file.
    const file = join(dir, "sessions", `${sessionId}.jsonl`);
    const written = async () => {
      const content = await readFile(file, "utf8").catch(() => "");
      return content.includes(JSON.stringify(answer).slice(1, -1));
    };
    const started = Date.now();
    while (!(await written())) {
      if (Date.now() - started > 3000) throw new Error("the reply was not written");
      await Bun.sleep(5);
    }
    await Bun.sleep(150);
  };
  const find = (query: string, limit?: number) =>
    c.agent.request("_cycle/search" as never, { query, limit } as never) as Promise<Found>;
  return { daemon, c, sessionId, say, find };
};

test("the protocol document defines _cycle/search and its capability", async () => {
  const doc = await readFile(join(import.meta.dir, "../../../docs/protocol.md"), "utf8");
  expect(doc).toContain("`_cycle/search`(客户端 → daemon),参数 `{query, limit?}`");
  expect(doc).toContain('"search": true');
  expect(doc).toContain("能力 `search` 为 `true` 才有这个方法");
});

test("a word said in a conversation finds that session, with a snippet and where it is", async () => {
  const { c, sessionId, say, find } = await start();
  const capabilities = (c.init._meta as Record<string, { search?: boolean }>)["cycle/capabilities"];
  expect(capabilities?.search).toBe(true);
  await say("please fix the zebrafish parser", "I looked at the Zebrafish module and changed it.");
  const found = await find("zebrafish");
  expect(found.truncated).toBe(false);
  expect(found.hits.length).toBe(2);
  for (const hit of found.hits) {
    expect(hit.sessionId).toBe(sessionId);
    expect(hit.seq).toBeGreaterThan(0);
    expect(hit.snippet.toLowerCase()).toContain("zebrafish");
  }
  expect(found.hits.map((h) => h.from).sort()).toEqual(["agent", "user"]);
  expect((await find("ZEBRAFISH parser")).hits.map((h) => h.from)).toEqual(["user"]);
  expect((await find("zebrafish", 1)).truncated).toBe(true);
});

test("a word nowhere in the history gives an empty result, not an error", async () => {
  const { say, find } = await start();
  await say("hello there", "general greetings");
  expect(await find("quokka")).toEqual({ hits: [], truncated: false });
  expect(await find("   ,,, ")).toEqual({ hits: [], truncated: false });
});

test("Chinese text is found by its characters", () => {
  expect([...tokensOf("登录失败")]).toEqual(expect.arrayContaining(["登", "登录", "失败"]));
});

test("a search reads only what was added since the last one", async () => {
  const { daemon, say, find } = await start();
  await say("first about quokka", "ok");
  expect((await find("quokka")).hits.length).toBe(1);
  const before = daemon.searchProcessed;
  expect(before).toBeGreaterThan(0);
  // Nothing new: nothing is read again.
  await find("quokka");
  expect(daemon.searchProcessed).toBe(before);
  await say("now about axolotl", "axolotl noted");
  const found = await find("axolotl");
  expect(found.hits.length).toBe(2);
  const added = daemon.searchProcessed - before;
  expect(added).toBeGreaterThan(0);
  // Only the new turn: fewer records than the whole history holds.
  expect(daemon.searchProcessed).toBeLessThan(before * 2 + 1);
  expect((await find("quokka")).hits.length).toBe(1);
});

test("punctuation in the query does not hide a message", async () => {
  const { say, find } = await start();
  await say("hello, world: what's up?", "fine");
  expect((await find("hello, world")).hits.length).toBe(1);
  expect((await find("what's up?")).hits.length).toBe(1);
  expect((await find("HELLO")).hits[0]?.snippet).toContain("hello");
});

test("a reply streamed in chunks is one message", async () => {
  const { sessionId, find } = await start();
  const file = join(dir, "sessions", `${sessionId}.jsonl`);
  const line = (seq: number, data: object) =>
    `${JSON.stringify({ seq, ts: "2026-11-26T00:00:00.000Z", kind: "update", data })}\n`;
  const chunk = (seq: number, text: string) =>
    line(seq, {
      sessionUpdate: "agent_message_chunk",
      messageId: "m-split",
      content: { type: "text", text },
    });
  const before = (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
  const { appendFile } = await import("node:fs/promises");
  await appendFile(
    file,
    chunk(before + 1, "the zebra") +
      chunk(before + 2, "fish parser was ") +
      chunk(before + 3, "fixed"),
  );
  const found = await find("zebrafish parser");
  expect(found.hits.length).toBe(1);
  expect(found.hits[0]?.seq).toBe(before + 1);
  expect(found.hits[0]?.snippet).toContain("fixed");
  expect((await find("parser was fixed")).hits.length).toBe(1);
});

test("a file rewritten and grown past the old offset is indexed again", async () => {
  const { sessionId, find } = await start();
  const file = join(dir, "sessions", `${sessionId}.jsonl`);
  const line = (seq: number, text: string) =>
    `${JSON.stringify({ seq, ts: "2026-11-26T00:00:00.000Z", kind: "update", data: { sessionUpdate: "user_message", messageId: `u${seq}`, content: [{ type: "text", text }] } })}\n`;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, line(1, "alpha one") + line(2, "alpha two"));
  expect((await find("alpha")).hits.length).toBe(2);
  // Rewritten with other content, and longer than before.
  await writeFile(
    file,
    line(1, "beta one padded padded padded") +
      line(2, "beta two padded padded") +
      line(3, "beta three"),
  );
  expect((await find("alpha")).hits.length).toBe(0);
  expect((await find("beta")).hits.length).toBe(3);
});

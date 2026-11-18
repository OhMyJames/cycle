import { expect, test } from "bun:test";
import type { Item, Session, Turn } from "@cycle/protocol";
import { type SessionSource, answerMcp, sessionText } from "../src/index.ts";

const info = (id: string, title: string, updatedAt: number): Session => ({
  id,
  harness: "codex",
  title,
  preview: "",
  cwd: `/work/${id}`,
  model: "m",
  effort: null,
  mode: "auto",
  status: "idle",
  branch: null,
  worktree: null,
  sandbox: null,
  sandboxCwd: null,
  directories: [],
  createdAt: 0,
  updatedAt,
  archived: false,
  pinned: false,
  unread: false,
  forkedFrom: null,
  scheduleId: null,
});

const turn = (id: string, items: Item[]): Turn => ({ id, items }) as unknown as Turn;
const item = (value: Record<string, unknown>): Item => value as unknown as Item;

const sessions = [info("a", "Fix the login", 2), info("b", "Write the docs", 1)];
const source: SessionSource = {
  list: async () => sessions,
  turns: async (id) =>
    id === "a"
      ? {
          info: sessions[0] as Session,
          turns: [
            turn("t1", [item({ id: "1", kind: "userMessage", text: "first ask" })]),
            turn("t2", [
              item({ id: "2", kind: "userMessage", text: "why does login fail" }),
              item({ id: "3", kind: "reasoning", text: "private thought" }),
              item({ id: "4", kind: "command", command: "bun test", exitCode: 1 }),
              item({ id: "5", kind: "agentMessage", text: "The token expired." }),
            ]),
          ],
        }
      : null,
};

interface Answer {
  result?: { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] };
  error?: { code: number };
}
const ask = (method: string, params?: unknown) =>
  answerMcp({ jsonrpc: "2.0", id: 1, method, params }, source) as Promise<Answer>;
const call = async (name: string, args: Record<string, unknown>) => {
  const answer = await ask("tools/call", { name, arguments: args });
  return { text: answer.result?.content?.[0]?.text ?? "", failed: answer.result?.isError === true };
};

test("the server names its two tools, and both only read", async () => {
  const answer = await ask("tools/list");
  expect(answer.result?.tools?.map((tool) => tool.name)).toEqual(["list_sessions", "read_session"]);
  expect(JSON.stringify(answer.result)).not.toContain('"readOnlyHint":false');
});

test("a notification has no answer, and an unknown method is refused", async () => {
  expect(
    await answerMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, source),
  ).toBeNull();
  expect((await ask("resources/list")).error?.code).toBe(-32601);
});

test("list_sessions lists every session, or those a query finds", async () => {
  const all = await call("list_sessions", {});
  expect(all.text.split("\n")).toHaveLength(2);
  expect(all.text).toContain("id a");
  const found = await call("list_sessions", { query: "DOCS" });
  expect(found.text).toContain("Write the docs");
  expect(found.text).not.toContain("Fix the login");
  expect((await call("list_sessions", { query: "nothing" })).text).toBe("No sessions.");
});

test("read_session gives the conversation without the agent's reasoning", async () => {
  const read = await call("read_session", { session_id: "cycle://session/a" });
  expect(read.failed).toBe(false);
  expect(read.text).toContain("# Fix the login");
  expect(read.text).toContain("## Owner\nwhy does login fail");
  expect(read.text).toContain("- ran `bun test` (exit 1)");
  expect(read.text).toContain("## Agent\nThe token expired.");
  expect(read.text).not.toContain("private thought");
});

test("read_session reads only the latest turns asked for", async () => {
  const read = await call("read_session", { session_id: "a", turns: 1 });
  expect(read.text).toContain("Showing the last 1 of 2 turns.");
  expect(read.text).not.toContain("first ask");
});

test("a session that is not there is an error the agent can read", async () => {
  const read = await call("read_session", { session_id: "zz" });
  expect(read.failed).toBe(true);
  expect(read.text).toContain("There is no session zz");
  expect((await call("read_session", {})).failed).toBe(true);
  expect((await call("write_session", {})).failed).toBe(true);
});

test("a long conversation keeps its end", () => {
  const long = turn("t", [
    item({ id: "1", kind: "agentMessage", text: `${"x".repeat(70_000)}END` }),
  ]);
  const text = sessionText(sessions[0] as Session, [long], 10);
  expect(text).toContain("[Earlier text left out]");
  expect(text.endsWith("END")).toBe(true);
  expect(text.length).toBeLessThan(61_000);
});

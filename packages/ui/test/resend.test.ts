import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { CycleErrorCode } from "@cycle/protocol";
import { blocksOf, failureOf, reduce, resendOf, stepOf } from "../src/model/index.ts";

const u = (update: object) => update as SessionUpdate;
const you = (id: string, extra: object[] = []) =>
  u({
    sessionUpdate: "user_message",
    messageId: id,
    content: [{ type: "text", text: `said ${id}` }, ...extra],
  });
const say = (id: string) =>
  u({ sessionUpdate: "agent_message", messageId: id, content: [{ type: "text", text: id }] });
const tool = (id: string, kind: string, status: string) =>
  u({ sessionUpdate: "tool_call_update", toolCallId: id, name: id, kind, status });
const running = u({ sessionUpdate: "state_update", state: "running" });
const idle = (stopReason: string, extra: object = {}) =>
  u({ sessionUpdate: "state_update", state: "idle", stopReason, ...extra });
const failed = (code?: number) =>
  idle("error", { error: { ...(code !== undefined ? { code } : {}), message: "it broke" } });
const retry = (attempt: number) =>
  u({
    sessionUpdate: "notice",
    severity: "info",
    title: `Retrying the request (attempt ${attempt} of 10)`,
    _meta: { "cycle/retry": { attempt, maxRetries: 10, delayMs: 500 } },
  });

test("the last turn that failed can be sent again: what was said in it, the message and what was put into it", () => {
  const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
  const c = reduce([
    you("u1"),
    say("a1"),
    idle("end_turn"),
    you("u2", [image]),
    running,
    you("u3"),
    failed(),
  ]);
  const resend = resendOf(c);
  expect(resend?.turn).toBe(1);
  expect(resend?.prompts.map((p) => p[0])).toEqual([
    { type: "text", text: "said u2" },
    { type: "text", text: "said u3" },
  ]);
  // The image goes back with its words.
  expect(resend?.prompts[0]?.[1]).toEqual(image);
  expect(resend?.changed).toEqual([]);
  expect(resend?.failure).toBe("agent_error");
  expect(resend?.busy).toBe(false);
});

test("while the agent is at work again and nothing is in the new turn yet, it is still offered, as busy", () => {
  const resend = resendOf(reduce([you("u1"), failed(), running]));
  expect(resend?.turn).toBe(0);
  expect(resend?.busy).toBe(true);
});

test("only a failure, only the last turn, only when nothing has happened since, and only what a person said", () => {
  // A stop by the person, a limit: not failures.
  expect(resendOf(reduce([you("u1"), idle("cancelled")]))).toBeUndefined();
  expect(resendOf(reduce([you("u1"), idle("max_tokens")]))).toBeUndefined();
  expect(resendOf(reduce([you("u1"), idle("end_turn")]))).toBeUndefined();
  // A failed turn that is not the last.
  expect(resendOf(reduce([you("u1"), failed(), you("u2"), idle("end_turn")]))).toBeUndefined();
  // Something going on since: a new turn has begun.
  expect(resendOf(reduce([you("u1"), failed(), running, you("u2")]))).toBeUndefined();
  // A turn the agent began by itself has nothing to send.
  expect(resendOf(reduce([running, say("a1"), failed()]))).toBeUndefined();
  // Nothing while the history is being replayed.
  expect(resendOf({ ...reduce([you("u1"), failed()]), replaying: true })).toBeUndefined();
});

test("calls that may have changed something are named: started commands and edits, not reads or ones never run", () => {
  const c = reduce([
    you("u1"),
    running,
    tool("bash", "execute", "completed"),
    tool("edit", "edit", "failed"),
    tool("read", "read", "completed"),
    tool("search", "search", "completed"),
    tool("asked", "execute", "pending"),
    tool("going", "move", "in_progress"),
    failed(-32018),
  ]);
  const resend = resendOf(c);
  // `going` was cut short when the turn ended (cancelled), and may have done its work: it counts. `asked` never ran.
  expect(resend?.changed.map((t) => t.id).sort()).toEqual(["bash", "edit", "going"]);
  expect(resend?.failure).toBe("daemon_stopped");
});

test("the failure is named by Cycle's code, never by its message", () => {
  expect(failureOf(CycleErrorCode.AgentExited)).toBe("agent_exited");
  expect(failureOf(CycleErrorCode.DaemonStopped)).toBe("daemon_stopped");
  expect(failureOf(CycleErrorCode.LogUnavailable)).toBe("history");
  expect(failureOf(CycleErrorCode.ResumeFailed)).toBe("resume");
  expect(failureOf(-32603)).toBe("agent_error");
  expect(failureOf(undefined)).toBe("agent_error");
});

test("the agent trying its request again is a state of the step line, not a row, and goes when the turn moves on", () => {
  const trying = reduce([you("u1"), running, retry(1), retry(2)]);
  expect(stepOf(trying)).toEqual({ kind: "retrying", attempt: 2, maxRetries: 10 });
  expect(blocksOf(trying).map((b) => b.kind)).toEqual(["user"]);
  const on = reduce([you("u1"), running, retry(1), say("a1")]);
  expect(stepOf(on)).toBeUndefined();
  expect(blocksOf(on).map((b) => b.kind)).toEqual(["user", "agent"]);
  // A notice that is not a retry is a row, as before.
  const notice = reduce([
    you("u1"),
    running,
    u({ sessionUpdate: "notice", severity: "warning", title: "Model not restored" }),
  ]);
  expect(blocksOf(notice).map((b) => b.kind)).toEqual(["user", "notice"]);
  // Retries that ran out end the turn as any failure: it can be sent again.
  const out = reduce([you("u1"), running, retry(1), failed()]);
  expect(resendOf(out)?.failure).toBe("agent_error");
  expect(blocksOf(out).map((b) => b.kind)).toEqual(["user", "end"]);
});

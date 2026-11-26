import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopNotice, LoopNoticesAnswer } from "@cycle/ui/api";
import { actionsOf, actOnTicket, answerNotices, answerTicket } from "../src/main/loop.ts";
import { type Alertable, newAlerts, noticePoller, showAlert } from "../src/main/loop-alerts.ts";

const dir = mkdtempSync(join(tmpdir(), "desktop-notices-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const keyFile = join(dir, "key");
writeFileSync(keyFile, "secret-key\n");
chmodSync(keyFile, 0o600);
const loop = { socket: join(dir, "x.sock"), keyFile, trackerUrl: "https://tracker.invalid/mcp" };

const columns = [
  { id: 22, name: "Todo", stateType: "unstarted", position: 2 },
  { id: 23, name: "In Progress", stateType: "started", position: 3 },
  { id: 34, name: "In Review", stateType: "started", position: 4 },
  { id: 35, name: "Blocked", stateType: "started", position: 5 },
  { id: 24, name: "Done", stateType: "completed", position: 6 },
];
const BLOCKED =
  "自动化在「开发」卡住了：测试一直失败\n\n现场已保留：Dev 会话「[CYC-7] Dev」可在 Cycle 桌面端打开接管。";
const REVIEW =
  "已开 PR：https://github.com/o/r/pull/9\nCI 已跑完，独立评审结论为升级给人（escalate），未开启自动合并：\n- 动了评审边界";

/** A tracker with tickets by column, and comments by ticket id. */
const world = (state: {
  tickets: Record<number, { id: number; identifier: string; columnId: number }[]>;
  comments: Record<number, string[]>;
}) => {
  const writes: Record<string, unknown>[] = [];
  const fetchImpl = (async (_u: unknown, init: RequestInit) => {
    const { name, arguments: args } = (
      JSON.parse(String(init.body)) as {
        params: { name: string; arguments: Record<string, unknown> };
      }
    ).params;
    let data: unknown;
    if (name === "get_project") data = { columns, labels: [{ id: 11, name: "auto" }] };
    else if (name === "list_issues")
      data = (state.tickets[Number(args.columnId)] ?? []).map((t) => ({
        ...t,
        title: `T${t.id}`,
        labelIds: [11],
      }));
    else if (name === "get_issue_by_number") {
      const all = Object.values(state.tickets).flat();
      const t = all.find((x) => x.identifier === `CYC-${args.sequenceNumber}`);
      data = { ...t, title: "T", labelIds: [11], description: "" };
    } else if (name === "execute_read")
      data = {
        ok: true,
        status: 200,
        data: {
          items: (
            state.comments[Number((args.arguments as { issueId: number }).issueId)] ?? []
          ).map((body) => ({ kind: "comment", body })),
        },
      };
    else {
      writes.push(args);
      data = {};
    }
    return new Response(
      JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(data) }] } }),
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, writes };
};

const noop = () => {};
const sessions = (...rows: { title: string; state: string }[]) =>
  rows.map((r, i) => ({ locationId: "local", sessionId: `s${i}`, archived: false, ...r }));

describe("Notices", () => {
  const state = {
    tickets: {
      35: [{ id: 7, identifier: "CYC-7", columnId: 35 }],
      34: [
        { id: 9, identifier: "CYC-9", columnId: 34 },
        { id: 10, identifier: "CYC-10", columnId: 34 },
      ],
    },
    comments: {
      7: [BLOCKED],
      9: ["x", REVIEW],
      10: ["PR 已在自动化之外合并：https://github.com/o/r/pull/3。"],
    },
  };

  test("a Blocked ticket, a waiting session and an escalated review each make one, most urgent first", async () => {
    const { fetchImpl } = world(state);
    const events: unknown[] = [];
    const answer = await answerNotices(
      loop,
      "CYC",
      () =>
        sessions(
          { title: "[CYC-5] Dev", state: "requires_action" },
          { title: "[CYC-6] Dev", state: "running" },
        ),
      (_e, p) => events.push(p),
      fetchImpl,
    );
    if (answer.kind !== "ok") throw new Error("expected notices");
    expect(answer.notices.map((n) => [n.kind, n.identifier])).toEqual([
      ["permission", "CYC-5"],
      ["blocked", "CYC-7"],
      ["review", "CYC-9"],
    ]);
    expect(answer.notices[1]).toMatchObject({ reason: "测试一直失败" });
    // An In Review ticket merged outside the loop (CYC-10) is not for a person to decide: no Notice.
    // Only counts are reported, never text.
    expect(events).toEqual([{ permission: 1, blocked: 1, review: 1 }]);
  });

  test("they are gone when their cause is: moved out, or the session answered", async () => {
    const { fetchImpl } = world({ tickets: {}, comments: {} });
    const answer = await answerNotices(
      loop,
      "CYC",
      () => sessions({ title: "[CYC-5] Dev", state: "idle" }),
      noop,
      fetchImpl,
    );
    expect(answer).toEqual({ kind: "ok", notices: [] });
  });

  test("a session of another Project, or not a Dev session, is not a Notice", async () => {
    const { fetchImpl } = world({ tickets: {}, comments: {} });
    const answer = await answerNotices(
      loop,
      "CYC",
      () =>
        sessions(
          { title: "[OTHER-1] Dev", state: "requires_action" },
          { title: "scratch", state: "requires_action" },
        ),
      noop,
      fetchImpl,
    );
    expect(answer).toEqual({ kind: "ok", notices: [] });
  });

  test("an unreadable comment does not hide a Blocked ticket", async () => {
    const base = world(state).fetchImpl;
    const failing = (async (u: unknown, init: RequestInit) =>
      String(init.body).includes("execute_read")
        ? new Response("no", { status: 500 })
        : base(u as never, init)) as unknown as typeof fetch;
    const answer = await answerNotices(loop, "CYC", () => [], noop, failing);
    if (answer.kind !== "ok") throw new Error("expected notices");
    expect(answer.notices.find((n) => n.kind === "blocked")).toMatchObject({ reason: "" });
  });

  test("the ticket page of a Blocked ticket has the reason and the session, and its buttons work despite `auto`", async () => {
    const { fetchImpl, writes } = world(state);
    const answer = await answerTicket(loop, "CYC", "CYC-7", noop, fetchImpl);
    if (answer.kind !== "ok") throw new Error("expected a ticket");
    expect(answer.ticket.attention).toEqual({
      kind: "blocked",
      text: "测试一直失败",
      session: "[CYC-7] Dev",
    });
    expect(answer.ticket.actions).toEqual(["to_backlog", "to_todo"]);
    const acted = await actOnTicket(loop, "CYC", "CYC-7", "to_todo", false, noop, fetchImpl);
    expect(acted).toEqual({ kind: "ok" });
    // Back in Todo with its labels untouched, so Loop takes it up again.
    expect(writes[0]?.columnId).toBe(22);
    expect(writes[0]).not.toHaveProperty("labelIds");
  });

  test("an escalated review's page shows the conclusion and the PR address", async () => {
    const { fetchImpl } = world(state);
    const answer = await answerTicket(loop, "CYC", "CYC-9", noop, fetchImpl);
    if (answer.kind !== "ok") throw new Error("expected a ticket");
    expect(answer.ticket.attention).toMatchObject({
      kind: "review",
      prUrl: "https://github.com/o/r/pull/9",
    });
    expect(answer.ticket.attention?.text).toContain("动了评审边界");
  });

  test("a ticket in Doing that Loop is working on still has no buttons", () => {
    expect(actionsOf("started", true, "progress")).toEqual([]);
    expect(actionsOf("started", true, "review")).toEqual([]);
    expect(actionsOf("started", true, "blocked")).toEqual(["to_backlog", "to_todo"]);
  });
});

describe("system notifications", () => {
  const blocked = (id: string): Alertable => ({
    kind: "blocked",
    identifier: id,
    title: "",
    reason: "",
  });
  const review = (id: string): Alertable => ({
    kind: "review",
    identifier: id,
    title: "",
    conclusion: "",
  });
  const permission = (id: string): LoopNotice => ({
    kind: "permission",
    identifier: id,
    locationId: "local",
    sessionId: "s",
  });

  test("the first read says nothing; a new Blocked or escalated one is told once", () => {
    expect(newAlerts(undefined, [blocked("CYC-1")])).toEqual([]);
    const before = new Set(["blocked:CYC-1"]);
    expect(newAlerts(before, [blocked("CYC-1"), blocked("CYC-2"), review("CYC-3")])).toEqual([
      blocked("CYC-2"),
      review("CYC-3"),
    ]);
  });

  test("a session waiting on a permission is never told here", () => {
    expect(newAlerts(new Set(), [permission("CYC-4")])).toEqual([]);
  });

  test("the poller tells a new one once, not again while it stays, and again if it returns", async () => {
    let answer: LoopNoticesAnswer = { kind: "ok", notices: [] };
    const told: Alertable[] = [];
    const poller = noticePoller({
      projects: async () => [
        { name: "C", projectKey: "CYC", repo: { displayName: "o/r", forge: "github" } },
      ],
      read: async () => answer,
      alert: (_k, n) => told.push(n),
    });
    await poller.tick(); // first read: nothing
    answer = { kind: "ok", notices: [blocked("CYC-1"), permission("CYC-2")] };
    await poller.tick();
    await poller.tick();
    expect(told.map((n) => n.identifier)).toEqual(["CYC-1"]);
    answer = { kind: "unreachable" }; // a failed read changes nothing
    await poller.tick();
    answer = { kind: "ok", notices: [blocked("CYC-1")] };
    await poller.tick();
    expect(told).toHaveLength(1);
    answer = { kind: "ok", notices: [] };
    await poller.tick();
    answer = { kind: "ok", notices: [blocked("CYC-1")] };
    await poller.tick();
    expect(told).toHaveLength(2);
  });
});

describe("the notification itself", () => {
  const make = (focused: boolean) => {
    const shown: { title: string; body: string }[] = [];
    const opened: string[] = [];
    const tracked: string[] = [];
    let click = () => {};
    const win = {
      isFocused: () => focused,
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: noop,
      show: noop,
      focus: noop,
    };
    const alert = showAlert({
      window: () => win,
      supported: () => true,
      create: (o) => {
        shown.push(o);
        return {
          show: noop,
          on: (e, l) => {
            if (e === "click") click = l;
          },
        };
      },
      activate: noop,
      say: (k) => `say ${k}`,
      open: (_p, id) => opened.push(id),
      track: (k) => tracked.push(k),
    });
    return { alert, shown, opened, tracked, click: () => click() };
  };
  const notice: Alertable = {
    kind: "blocked",
    identifier: "CYC-1",
    title: "Fix it",
    reason: "secret reason",
  };

  test("shown while the window is not in front; pressing it opens the ticket; only the kind is reported", () => {
    const m = make(false);
    m.alert("CYC", notice);
    expect(m.shown).toEqual([{ title: "CYC-1 Fix it", body: "say blocked" }]);
    m.click();
    expect(m.opened).toEqual(["CYC-1"]);
    expect(m.tracked).toEqual(["blocked"]);
    expect(JSON.stringify(m.tracked)).not.toContain("secret");
  });

  test("not shown while the window is in front", () => {
    const m = make(true);
    m.alert("CYC", notice);
    expect(m.shown).toEqual([]);
  });
});

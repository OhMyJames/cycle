import { describe, expect, test } from "bun:test";
import type { LoopNotice, LoopNoticesAnswer } from "@cycle/ui/api";
import { type Alertable, newAlerts, noticePoller, showAlert } from "../src/main/loop-alerts.ts";

const noop = () => {};
const notice = (kind: LoopNotice["kind"], identifier: string): LoopNotice => ({
  id: `CYC:${kind}:${identifier}`,
  kind,
  identifier,
  text: "",
  session: null,
});

describe("system notifications", () => {
  const blocked = (id: string) => notice("blocked", id) as Alertable;
  const review = (id: string) => notice("review", id) as Alertable;
  const permission = (id: string) => notice("permission", id);

  test("the first read says nothing; a new Blocked, review, stuck or intent_stuck notice is told once", () => {
    expect(newAlerts(undefined, [blocked("CYC-1")])).toEqual([]);
    const before = new Set(["blocked:CYC-1"]);
    const stuck = notice("stuck", "CYC-4") as Alertable;
    const intentStuck = notice("intent_stuck", "CYC-5") as Alertable;
    const intentStuckDup = { ...intentStuck, id: "CYC:intent_stuck:2" } as Alertable;
    const supervisor = notice("supervisor", "CYC-6");
    expect(
      newAlerts(before, [
        blocked("CYC-1"),
        blocked("CYC-2"),
        review("CYC-3"),
        stuck,
        intentStuck,
        intentStuckDup,
        supervisor,
      ]),
    ).toEqual([blocked("CYC-2"), review("CYC-3"), stuck, intentStuck]);
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
  const blockedOne = { ...notice("blocked", "CYC-1"), text: "secret reason" } as Alertable;

  test("shown while the window is not in front; pressing it opens the ticket; only the kind is reported", () => {
    const m = make(false);
    m.alert("CYC", blockedOne);
    expect(m.shown).toEqual([{ title: "CYC-1", body: "say blocked" }]);
    m.click();
    expect(m.opened).toEqual(["CYC-1"]);
    expect(m.tracked).toEqual(["blocked"]);
    expect(JSON.stringify(m.tracked)).not.toContain("secret");
  });

  test("not shown while the window is in front", () => {
    const m = make(true);
    m.alert("CYC", blockedOne);
    expect(m.shown).toEqual([]);
  });
});

describe("overlapping ticks", () => {
  test("a tick that finds the last still reading does nothing, so a new Notice is told once", async () => {
    let release = () => {};
    let calls = 0;
    const told: string[] = [];
    let answer: LoopNoticesAnswer = { kind: "ok", notices: [] };
    const poller = noticePoller({
      projects: async () => [
        { name: "C", projectKey: "CYC", repo: { displayName: "o/r", forge: "github" } },
      ],
      read: async () => {
        calls += 1;
        if (calls === 2) await new Promise<void>((r) => (release = r));
        return answer;
      },
      alert: (_k, n) => told.push(n.identifier),
    });
    await poller.tick();
    answer = {
      kind: "ok",
      notices: [notice("blocked", "CYC-1")],
    };
    const slow = poller.tick();
    await poller.tick();
    release();
    await slow;
    expect(told).toEqual(["CYC-1"]);
  });
});

describe("a Notice that was not shown", () => {
  test("is offered again until it is shown, then not again", async () => {
    let shown = false;
    let answer: LoopNoticesAnswer = { kind: "ok", notices: [] };
    const told: string[] = [];
    const poller = noticePoller({
      projects: async () => [
        { name: "C", projectKey: "CYC", repo: { displayName: "o/r", forge: "github" } },
      ],
      read: async () => answer,
      alert: (_k, n) => {
        if (!shown) return false; // the window is in front
        told.push(n.identifier);
        return true;
      },
    });
    await poller.tick();
    answer = {
      kind: "ok",
      notices: [notice("blocked", "CYC-1")],
    };
    await poller.tick();
    shown = true;
    await poller.tick();
    await poller.tick();
    expect(told).toEqual(["CYC-1"]);
  });
});

describe("a Project that is no longer listed", () => {
  test("is forgotten, so listing it again is a first read", async () => {
    let listed = true;
    const told: string[] = [];
    let answer: LoopNoticesAnswer = { kind: "ok", notices: [] };
    const poller = noticePoller({
      projects: async () =>
        listed
          ? [{ name: "C", projectKey: "CYC", repo: { displayName: "o/r", forge: "github" } }]
          : [],
      read: async () => answer,
      alert: (_k, n) => told.push(n.identifier),
    });
    await poller.tick();
    listed = false;
    await poller.tick();
    listed = true;
    answer = {
      kind: "ok",
      notices: [notice("blocked", "CYC-1")],
    };
    await poller.tick(); // first read again: what is there is not news
    expect(told).toEqual([]);
  });
});

describe("round 3 rules", () => {
  const project = {
    name: "C",
    projectKey: "CYC",
    repo: { displayName: "o/r", forge: "github" as const },
  };

  test("a Loop server that does not answer forgets nothing: what appeared meanwhile is told", async () => {
    let up = true;
    let answer: LoopNoticesAnswer = { kind: "ok", notices: [] };
    const told: string[] = [];
    const poller = noticePoller({
      projects: async () => {
        if (!up) throw new Error("no answer");
        return [project];
      },
      read: async () => answer,
      alert: (_k, n) => told.push(n.identifier),
    });
    await poller.tick();
    up = false;
    await poller.tick();
    up = true;
    answer = {
      kind: "ok",
      notices: [notice("blocked", "CYC-1")],
    };
    await poller.tick();
    expect(told).toEqual(["CYC-1"]);
  });

  test("a Notice withheld while the window is in front is offered twice at most", async () => {
    let offers = 0;
    let answer: LoopNoticesAnswer = { kind: "ok", notices: [] };
    const poller = noticePoller({
      projects: async () => [project],
      read: async () => answer,
      alert: () => {
        offers += 1;
        return false;
      },
    });
    await poller.tick();
    answer = {
      kind: "ok",
      notices: [notice("blocked", "CYC-1")],
    };
    for (let i = 0; i < 5; i++) await poller.tick();
    expect(offers).toBe(2);
  });
});

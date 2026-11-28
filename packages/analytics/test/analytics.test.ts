import { describe, expect, test } from "bun:test";
import { agentOf, settingOf, sizeOf, viaOf } from "../src/events.ts";
import { createAnalytics, EVENTS, isUiEvent, noAnalytics, type Sink } from "../src/index.ts";

const recording = () => {
  const sent: { distinctId: string; event: string; properties: Record<string, unknown> }[] = [];
  let shutdowns = 0;
  const sink: Sink = {
    capture: (m) => void sent.push(m),
    shutdown: async () => void shutdowns++,
  };
  return { sink, sent, shutdowns: () => shutdowns };
};
const context = { app_version: "1.2.3", platform: "darwin", arch: "arm64" };
const make = (enabled = true) => {
  const r = recording();
  const dropped: string[] = [];
  const analytics = createAnalytics({
    sink: r.sink,
    distinctId: "anon-1",
    enabled,
    context,
    sessionId: "launch-1",
    onDrop: (name, reason) => void dropped.push(`${name}: ${reason}`),
  });
  return { ...r, analytics, dropped };
};

describe("track", () => {
  test("sends the event with its properties, the app's context, and no person", () => {
    const { analytics, sent } = make();
    analytics.track("prompt_sent", {
      agent: "claude",
      location: "local",
      size: "short",
      images: 1,
      files: 0,
      mentions: 0,
      steered: false,
      via: "enter",
    });
    expect(sent).toEqual([
      {
        distinctId: "anon-1",
        event: "prompt_sent",
        properties: {
          agent: "claude",
          location: "local",
          size: "short",
          images: 1,
          files: 0,
          mentions: 0,
          steered: false,
          via: "enter",
          ...context,
          $session_id: "launch-1",
          $geoip_disable: true,
        },
      },
    ]);
  });

  test("held events go when released, and are thrown away when the person says no", () => {
    const r = recording();
    const make = () =>
      createAnalytics({ sink: r.sink, distinctId: "x", enabled: true, held: true, context });
    const a = make();
    a.track("update_install_started", {});
    expect(r.sent).toHaveLength(0);
    a.release(true);
    expect(r.sent).toHaveLength(1);
    a.track("update_install_started", {});
    expect(r.sent).toHaveLength(2);

    const b = make();
    b.track("update_install_started", {});
    b.release(false);
    b.track("update_install_started", {});
    expect(r.sent).toHaveLength(3);
  });

  test("what is held is bounded", () => {
    const r = recording();
    const a = createAnalytics({
      sink: r.sink,
      distinctId: "x",
      enabled: true,
      held: true,
      context,
    });
    for (let i = 0; i < 500; i++) a.track("update_install_started", {});
    a.release(true);
    expect(r.sent.length).toBe(200);
  });

  test("sends nothing while it is off, and again once it is on", () => {
    const { analytics, sent } = make(false);
    analytics.track("update_install_started", {});
    expect(sent).toHaveLength(0);
    analytics.setEnabled(true);
    analytics.track("update_install_started", {});
    expect(sent).toHaveLength(1);
    analytics.setEnabled(false);
    analytics.track("update_install_started", {});
    expect(sent).toHaveLength(1);
  });

  test("a property that is not in the schema is not sent: free text cannot ride along", () => {
    const { analytics, sent, dropped } = make();
    expect(analytics.trackUnchecked("session_renamed", { title: "the secret project" })).toBe(
      false,
    );
    expect(sent).toHaveLength(0);
    expect(dropped[0]).toContain("session_renamed");
  });

  test("a value outside its list is not sent", () => {
    const { analytics, sent } = make();
    expect(
      analytics.trackUnchecked("session_created", {
        agent: "/home/me/agent",
        location: "local",
        configured: true,
      }),
    ).toBe(false);
    expect(
      analytics.trackUnchecked("prompt_sent", {
        agent: "claude",
        location: "local",
        size: "short",
        images: -1,
        mentions: 0,
      }),
    ).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test("an event that is not in the dictionary is not sent", () => {
    const { analytics, sent, dropped } = make();
    expect(analytics.trackUnchecked("page_view", {})).toBe(false);
    expect(analytics.trackUnchecked("toString", {})).toBe(false);
    expect(sent).toHaveLength(0);
    expect(dropped).toHaveLength(2);
  });

  test("a sink that throws does not reach the caller", () => {
    const analytics = createAnalytics({
      sink: {
        capture: () => {
          throw new Error("offline");
        },
        shutdown: async () => {},
      },
      distinctId: "x",
      enabled: true,
      context,
    });
    expect(() => analytics.track("update_install_started", {})).not.toThrow();
  });

  test("shutdown goes to the sink, and a sink that fails does not fail it", async () => {
    const { analytics, shutdowns } = make();
    await analytics.shutdown();
    expect(shutdowns()).toBe(1);
    const failing = createAnalytics({
      sink: { capture: () => {}, shutdown: () => Promise.reject(new Error("x")) },
      distinctId: "x",
      enabled: true,
      context,
    });
    await expect(failing.shutdown()).resolves.toBeUndefined();
  });

  test("no analytics does nothing", async () => {
    noAnalytics.track("update_install_started", {});
    expect(noAnalytics.trackUnchecked("update_install_started", {})).toBe(false);
    await noAnalytics.shutdown();
  });
});

describe("the dictionary", () => {
  test("the page may send only its own events", () => {
    expect(isUiEvent("panel_opened")).toBe(true);
    expect(isUiEvent("sidebar_toggled")).toBe(true);
    expect(isUiEvent("prompt_sent")).toBe(false);
    expect(isUiEvent("session_deleted")).toBe(false);
    expect(isUiEvent("mention_picked")).toBe(true);
  });

  test("a mention picked says what kind of thing it was, and nothing of which", () => {
    expect(EVENTS.mention_picked.safeParse({ kind: "session" }).success).toBe(true);
    expect(EVENTS.mention_picked.safeParse({ kind: "src/main.ts" }).success).toBe(false);
    expect(EVENTS.mention_picked.safeParse({ kind: "session", title: "Fix" }).success).toBe(false);
  });

  test("the graph events take words and numbers only, and drop text that rides along", () => {
    expect(isUiEvent("loop_graph_viewed")).toBe(true);
    expect(isUiEvent("loop_graph_node_opened")).toBe(true);
    expect(isUiEvent("loop_graph_acted")).toBe(false);
    expect(EVENTS.loop_graph_viewed.safeParse({ node_count: 3, source: "single" }).success).toBe(
      true,
    );
    expect(
      EVENTS.loop_graph_viewed.safeParse({ node_count: 3, source: "single", goal: "secret" })
        .success,
    ).toBe(false);
    expect(
      EVENTS.loop_graph_node_opened.safeParse({ status: "blocked", origin: "fix" }).success,
    ).toBe(true);
    expect(
      EVENTS.loop_graph_node_opened.safeParse({ status: "blocked", origin: "n1" }).success,
    ).toBe(false);
    expect(
      EVENTS.loop_graph_acted.safeParse({ action: "retry_node", result: "ok", lastError: "x" })
        .success,
    ).toBe(false);
  });

  test("the run workflow, cancel, intent retry and extended notice events take words and numbers only", () => {
    expect(isUiEvent("loop_run_viewed")).toBe(true);
    expect(isUiEvent("loop_run_cancelled")).toBe(false);
    expect(isUiEvent("loop_intents_retried")).toBe(false);
    expect(
      EVENTS.loop_run_viewed.safeParse({ kind: "dev", state: "active", sessions: 2 }).success,
    ).toBe(true);
    expect(
      EVENTS.loop_run_viewed.safeParse({
        kind: "dev",
        state: "active",
        sessions: 2,
        title: "CYC-1",
      }).success,
    ).toBe(false);
    expect(EVENTS.loop_run_cancelled.safeParse({ result: "ok" }).success).toBe(true);
    expect(EVENTS.loop_run_cancelled.safeParse({ result: "not_running" }).success).toBe(true);
    expect(EVENTS.loop_run_cancelled.safeParse({ result: "ok", key: "CYC-1" }).success).toBe(false);
    expect(EVENTS.loop_intents_retried.safeParse({ result: "ok", retried: 3 }).success).toBe(true);
    expect(
      EVENTS.loop_intents_retried.safeParse({ result: "ok", retried: 1, error: "secret" }).success,
    ).toBe(false);
    expect(EVENTS.loop_notice_notified.safeParse({ kind: "stuck" }).success).toBe(true);
    expect(EVENTS.loop_notice_notified.safeParse({ kind: "intent_stuck" }).success).toBe(true);
    expect(EVENTS.loop_notice_opened.safeParse({ kind: "intent_stuck" }).success).toBe(true);
    expect(EVENTS.loop_notice_opened.safeParse({ kind: "operator" }).success).toBe(true);
  });

  test("no event takes free text: every property is a number, a boolean or one of a list", () => {
    for (const [name, schema] of Object.entries(EVENTS)) {
      for (const [key, field] of Object.entries(schema.shape)) {
        const type = (field as { def: { type: string } }).def.type;
        expect([name, key, ["number", "boolean", "enum"].includes(type)]).toEqual([
          name,
          key,
          true,
        ]);
      }
    }
  });

  test("agents, settings and lengths are put into words, not sent as they are", () => {
    expect(agentOf("claude")).toBe("claude");
    // Each agent of ours is told apart (CYCL-155); the word is its id, which is ours, never one a user chose.
    expect(["codex", "agy", "pi"].map(agentOf)).toEqual(["codex", "agy", "pi"]);
    expect(agentOf("Codex")).toBe("other");
    expect(agentOf("")).toBe("other");
    expect(agentOf("my-private-agent")).toBe("other");
    expect(settingOf("mode")).toBe("mode");
    expect(settingOf("model")).toBe("model");
    expect(settingOf("effort")).toBe("effort");
    expect(settingOf("advisor")).toBe("advisor");
    expect(viaOf("shortcut")).toBe("shortcut");
    expect(viaOf("enter")).toBe("enter");
    expect(viaOf("button")).toBe("button");
    expect(viaOf("voice")).toBe("other");
    expect(viaOf(undefined)).toBe("other");
    expect(settingOf("anything")).toBe("other");
    expect([sizeOf(0), sizeOf(199), sizeOf(200), sizeOf(1999), sizeOf(2000)]).toEqual([
      "short",
      "short",
      "medium",
      "medium",
      "long",
    ]);
  });
});

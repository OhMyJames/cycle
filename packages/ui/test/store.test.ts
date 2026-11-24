import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { AppEvent, PermissionRequest, SessionSnapshot } from "../src/api.ts";
import { DraftStore } from "../src/draft.ts";
import { applyUpdate, emptyConversation, reduce } from "../src/model/index.ts";
import { AppStore, BLANK_KEY, viewKey } from "../src/store/index.ts";

import { fakeBridge, idle, summary as summaryOf, text } from "./fake-bridge.ts";

const update = (version: number, u: SessionUpdate, sessionId = "s1"): AppEvent => ({
  type: "update",
  locationId: "local",
  sessionId,
  update: u,
  version,
});

const opened = async (script = fakeBridge({ connected: true }), drafts?: DraftStore) => {
  const store = new AppStore(script.bridge, drafts ?? new DraftStore(undefined));
  await store.start();
  await store.selectSession("local", "s1");
  return { store, ...script };
};

test("starts: reads the locations and what main has of them, and the agents of those that are connected", async () => {
  const { bridge, named } = fakeBridge({ connected: true });
  const store = new AppStore(bridge);
  await store.start();
  const s = store.getState();
  expect(s.ready).toBe(true);
  expect(s.selectedLocation).toBe("local");
  // Main connects every location: the page does not.
  expect(named("connect")).toHaveLength(0);
  expect(s.sessions.local?.map((x) => x.sessionId)).toEqual(["s1"]);
  expect(s.agents.local?.map((a) => a.id)).toEqual(["fake"]);
});

test("the agents of a host are read when it connects, not before", async () => {
  const script = fakeBridge({ connected: false });
  const store = new AppStore(script.bridge);
  await store.start();
  expect(store.getState().agents.local).toBeUndefined();
  expect(script.named("agents")).toEqual([]);
  script.emit({ type: "location-status", locationId: "local", state: "connected" });
  await Bun.sleep(5);
  expect(store.getState().agents.local?.map((a) => a.id)).toEqual(["fake"]);
});

test("a session of a host that is away cannot be opened unless it was already, and the person is told", async () => {
  const script = fakeBridge({ connected: false });
  const store = new AppStore(script.bridge);
  await store.start();
  // Its last list is there, from main, though the location is not connected.
  expect(store.getState().sessions.local?.map((x) => x.sessionId)).toEqual(["s1"]);
  await store.selectSession("local", "s1");
  expect(store.getState().error).toEqual({
    key: "session.awayCannotOpen",
    params: { location: "Local" },
  });
  expect(store.getState().selectedSession).toBeUndefined();
  expect(script.named("openSession")).toEqual([]);

  // Open while it was connected, then the location goes away: what was read can still be looked at.
  store.dismissError();
  script.emit({ type: "location-status", locationId: "local", state: "connected" });
  await store.selectSession("local", "s1");
  script.emit({ type: "location-status", locationId: "local", state: "closed" });
  await store.selectSession("local", "s1");
  expect(store.getState().error).toBeUndefined();
  expect(store.getState().selectedSession).toBe("s1");
  expect(script.named("openSession")).toHaveLength(1);
});

test("a host that is saved is connected, and one that is removed leaves nothing behind", async () => {
  const script = fakeBridge({ connected: true });
  const store = new AppStore(script.bridge);
  await store.start();
  await store.selectSession("local", "s1");
  await store.saveLocation({
    id: "box",
    name: "Box",
    kind: "remote",
    transport: { type: "ssh", host: "me@box" },
  });
  expect(script.named("connect")).toEqual([["connect", "box"]]);
  script.emit({
    type: "sessions",
    locationId: "box",
    sessions: [{ ...summaryOf("b1"), locationId: "box" }],
  });
  script.emit({ type: "location-status", locationId: "box", state: "connected" });
  await store.removeLocation("box");
  const s = store.getState();
  expect(s.sessions.box).toBeUndefined();
  expect(s.agents.box).toBeUndefined();
  expect(s.status.box).toBeUndefined();
  // What was open on another location stays open.
  expect(s.selectedSession).toBe("s1");
});

test("a host that cannot be connected says so in its status, not in an error to dismiss", async () => {
  const script = fakeBridge();
  script.bridge.connect = async () => {
    throw new Error("Host key verification failed");
  };
  const store = new AppStore(script.bridge);
  await store.start();
  await store.connectLocation("local");
  expect(store.getState().error).toBeUndefined();
});

test("opening a session shows what main has, and then each event in turn", async () => {
  const history = [text("Hel"), text("lo")].reduce(
    (c, u) => applyUpdate(c, u),
    emptyConversation(),
  );
  const { store, emit } = await opened(
    fakeBridge({ snapshot: () => ({ conversation: history, permissions: [], version: 2 }) }),
  );
  const key = viewKey("local", "s1");
  expect(store.getState().views[key]?.version).toBe(2);
  emit(update(3, text("!")));
  emit(update(4, idle({ stopReason: "end_turn" })));
  const view = store.getState().views[key];
  expect(view?.version).toBe(4);
  expect(view?.conversation.turns).toBe(1);
  expect(JSON.stringify(view?.conversation.items)).toContain("Hello!");
});

test("an event it has already seen is ignored", async () => {
  const { store, emit } = await opened(
    fakeBridge({
      snapshot: () => ({ conversation: emptyConversation(), permissions: [], version: 5 }),
    }),
  );
  emit(update(5, text("again")));
  emit(update(3, text("older")));
  expect(store.getState().views[viewKey("local", "s1")]?.conversation.items).toEqual([]);
});

test("a missed event makes it ask main for the session again", async () => {
  let version = 1;
  const script = fakeBridge({
    snapshot: () => ({
      conversation: [text(`v${version}`)].reduce((c, u) => applyUpdate(c, u), emptyConversation()),
      permissions: [],
      version,
    }),
  });
  const { store, emit, named } = await opened(script);
  expect(named("openSession")).toHaveLength(1);
  version = 9;
  emit(update(4, text("skipped ahead")));
  await Bun.sleep(10);
  expect(named("openSession")).toHaveLength(2);
  expect(store.getState().views[viewKey("local", "s1")]?.version).toBe(9);
});

test("a re-read that fails does not take the conversation away", async () => {
  let version = 1;
  let broken = false;
  const script = fakeBridge({
    snapshot: () => {
      if (broken) throw new Error("the connection dropped");
      return {
        conversation: [text("kept")].reduce((c, u) => applyUpdate(c, u), emptyConversation()),
        permissions: [],
        version,
      };
    },
  });
  const { store, emit, named } = await opened(script);
  broken = true;
  version = 9;
  emit(update(4, text("skipped ahead")));
  await Bun.sleep(10);
  expect(named("openSession")).toHaveLength(2);
  const view = store.getState().views[viewKey("local", "s1")];
  expect(view?.loading).toBe(false);
  // The next event asks again, instead of being applied to a conversation that is behind.
  expect(view?.version).toBe(-1);
  expect(view?.conversation.items.length).toBeGreaterThan(0);
});

test("events that come while a session is being read are applied after it, in order", async () => {
  let release: (s: SessionSnapshot) => void = () => {};
  const script = fakeBridge({
    snapshot: () => new Promise<SessionSnapshot>((resolve) => (release = resolve)),
  });
  const store = new AppStore(script.bridge);
  await store.start();
  const selecting = store.selectSession("local", "s1");
  await Bun.sleep(5);
  // Two events overtake the answer; one of them was already in the snapshot.
  script.emit(update(1, text("seen")));
  script.emit(update(2, text(" and new")));
  release({
    conversation: [text("seen")].reduce((c, u) => applyUpdate(c, u), emptyConversation()),
    permissions: [],
    version: 1,
  });
  await selecting;
  const view = store.getState().views[viewKey("local", "s1")];
  expect(view?.loading).toBe(false);
  expect(view?.version).toBe(2);
  expect(JSON.stringify(view?.conversation.items)).toContain("seen and new");
});

test("a permission request appears and closes", async () => {
  const request: PermissionRequest = {
    key: "local:s1:p1",
    locationId: "local",
    sessionId: "s1",
    title: "Allow Bash?",
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  };
  const { store, emit, named } = await opened();
  emit({ type: "permission", request, version: 1 });
  expect(store.getState().views[viewKey("local", "s1")]?.permissions).toEqual([request]);
  await store.answerPermission(request.key, "allow");
  expect(named("answerPermission")).toEqual([["answerPermission", "local:s1:p1", "allow"]]);
  emit({
    type: "permission-closed",
    locationId: "local",
    sessionId: "s1",
    key: request.key,
    version: 2,
  });
  expect(store.getState().views[viewKey("local", "s1")]?.permissions).toEqual([]);
});

test("a request asked again keeps its place in the order they came", async () => {
  const ask = (key: string, title: string): PermissionRequest => ({
    key,
    locationId: "local",
    sessionId: "s1",
    title,
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  });
  const { store, emit } = await opened();
  emit({ type: "permission", request: ask("a", "A"), version: 1 });
  emit({ type: "permission", request: ask("b", "B"), version: 2 });
  emit({ type: "permission", request: ask("a", "A again"), version: 3 });
  expect(store.getState().views[viewKey("local", "s1")]?.permissions.map((p) => p.title)).toEqual([
    "A again",
    "B",
  ]);
});

test("sends a prompt, ignoring an empty one, and can cancel", async () => {
  const { store, named } = await opened();
  const key = viewKey("local", "s1");
  store.drafts.setText(key, "   ");
  await store.send();
  expect(named("prompt")).toHaveLength(0);
  store.drafts.setText(key, "hello");
  await store.send();
  expect(named("prompt")).toEqual([["prompt", "local", "s1", [{ type: "text", text: "hello" }]]]);
  // The box is empty from the moment it went.
  expect(store.drafts.get(key).text).toBe("");
  await store.cancel();
  expect(named("cancel")).toHaveLength(1);
});

test("takes a queued prompt back, and an error says why it could not", async () => {
  const script = fakeBridge();
  script.bridge.dequeue = async (_host, _session, queueId) => {
    if (queueId === "gone")
      throw new Error(
        "Error invoking remote method 'cycle:dequeue': Error: That prompt is not waiting",
      );
    return [{ type: "text", text: "back" }];
  };
  const { store } = await opened(script);
  store.drafts.setText(viewKey("local", "s1"), "typing");
  expect(await store.dequeue("q1")).toEqual([{ type: "text", text: "back" }]);
  // It is in the box now, in front of what was being written.
  expect(store.drafts.get(viewKey("local", "s1")).text).toBe("back\n\ntyping");
  expect(await store.dequeue("gone")).toBeUndefined();
  expect(store.getState().error).toBe("That prompt is not waiting");
});

test("what goes wrong is kept for the user, without Electron's wrapping, and can be dismissed", async () => {
  const script = fakeBridge();
  script.bridge.prompt = async () => {
    throw new Error("Error invoking remote method 'cycle:prompt': Error: The session is working");
  };
  const { store } = await opened(script);
  store.drafts.setText(viewKey("local", "s1"), "hi");
  await store.send();
  expect(store.getState().error).toBe("The session is working");
  // What could not go is back in the box.
  expect(store.drafts.get(viewKey("local", "s1")).text).toBe("hi");
  store.dismissError();
  expect(store.getState().error).toBeUndefined();
});

test("a session that cannot be opened is not left half-shown", async () => {
  const script = fakeBridge({
    snapshot: () => {
      throw new Error("No such session");
    },
  });
  const store = new AppStore(script.bridge);
  await store.start();
  await store.selectSession("local", "gone");
  expect(store.getState().error).toBe("No such session");
  expect(store.getState().views[viewKey("local", "gone")]).toBeUndefined();
});

test("a new session is a blank conversation until its first message, which makes the session and sends it", async () => {
  const script = fakeBridge({ connected: true });
  script.bridge.agentDefaults = async () => ({ mode: "plan" });
  const { store, named } = await opened(script);
  store.openBlank({ locationId: "local", cwd: "/work" });
  // Nothing is asked of the daemon to open it: it is only here until something is said.
  expect(store.getState().selectedSession).toBeUndefined();
  expect(named("createSession")).toEqual([]);
  await Bun.sleep(1);
  expect(store.getState().blank).toMatchObject({ cwd: "/work", config: { mode: "plan" } });
  store.changeBlank({ setting: { key: "mode", value: "default" } });

  store.drafts.setText(BLANK_KEY, "hi");
  await store.send();
  expect(named("createSession")).toEqual([
    ["createSession", "local", { cwd: "/work", agent: "fake", config: { mode: "default" } }],
  ]);
  expect(named("prompt")).toEqual([["prompt", "local", "s2", [{ type: "text", text: "hi" }]]]);
  // The session is open in its place, and the box it was written in is empty for the next one.
  expect(store.getState().blank).toBeUndefined();
  expect(store.getState().selectedSession).toBe("s2");
  expect(store.drafts.get(BLANK_KEY).text).toBe("");

  await store.deleteSession("s2");
  expect(store.getState().selectedSession).toBeUndefined();
  expect(store.getState().views[viewKey("local", "s2")]).toBeUndefined();
});

test("the first message is shown while the session is made, and comes back to the box if it cannot be", async () => {
  const script = fakeBridge({ connected: true });
  let fail: (error: Error) => void = () => {};
  script.bridge.createSession = () =>
    new Promise((_, reject) => {
      fail = reject;
    });
  const { store, named } = await opened(script);
  store.openBlank({ locationId: "local", cwd: "/work" });
  await Bun.sleep(1);
  store.drafts.setText(BLANK_KEY, "hi");
  const sending = store.send();
  expect(store.getState().blank?.starting).toEqual([{ type: "text", text: "hi" }]);
  // Nothing about it changes while it starts.
  store.changeBlank({ cwd: "/elsewhere" });
  expect(store.getState().blank?.cwd).toBe("/work");
  fail(new Error("Error invoking remote method 'cycle:createSession': Error: No such folder"));
  await sending;
  expect(store.getState().error).toBe("No such folder");
  expect(store.getState().blank?.starting).toBeUndefined();
  expect(store.drafts.get(BLANK_KEY).text).toBe("hi");
  expect(named("prompt")).toEqual([]);
});

test("a session that was made but whose first message could not go is opened, with the message in its box", async () => {
  const script = fakeBridge({ connected: true });
  script.bridge.prompt = async () => {
    throw new Error("The agent cannot start");
  };
  const { store } = await opened(script);
  store.openBlank({ locationId: "local", cwd: "/work" });
  await Bun.sleep(1);
  store.drafts.setText(BLANK_KEY, "hi");
  await store.send();
  expect(store.getState().error).toBe("The agent cannot start");
  expect(store.getState().selectedSession).toBe("s2");
  expect(store.drafts.get(viewKey("local", "s2")).text).toBe("hi");
  expect(store.drafts.get(BLANK_KEY).text).toBe("");
});

test("a blank conversation does not start until it has a folder and its agent's defaults, and refuses a form it could not read", async () => {
  const script = fakeBridge({ connected: true });
  script.bridge.agentDefaults = async () => {
    throw new Error("cannot read");
  };
  const { store, named } = await opened(script);
  store.openBlank({ locationId: "local" });
  await Bun.sleep(1);
  expect(store.getState().blank?.unreadable).toBe(true);
  store.changeBlank({ cwd: "/work" });
  store.drafts.setText(BLANK_KEY, "hi");
  await store.send();
  expect(named("createSession")).toEqual([]);
  expect(store.drafts.get(BLANK_KEY).text).toBe("hi");
});

test("@ in a blank conversation looks in its folder, only on a daemon that can", async () => {
  const script = fakeBridge({
    connected: true,
    capabilities: { queue: true, files: true, folders: true, filesInFolder: true },
  });
  const { store, named } = await opened(script);
  store.openBlank({ locationId: "local" });
  // No folder yet: nothing to look in.
  expect(await store.searchFiles("a")).toBeUndefined();
  store.changeBlank({ cwd: "/work" });
  await store.searchFiles("a");
  expect(named("searchFiles")).toEqual([["searchFiles", "local", { cwd: "/work" }, "a"]]);

  const old = fakeBridge({ connected: true });
  const before = await opened(old);
  before.store.openBlank({ locationId: "local", cwd: "/work" });
  expect(await before.store.searchFiles("a")).toBeUndefined();
  expect(old.named("searchFiles")).toEqual([]);
  // In a session, as always.
  await before.store.selectSession("local", "s1");
  await before.store.searchFiles("a");
  expect(old.named("searchFiles")).toEqual([["searchFiles", "local", { sessionId: "s1" }, "a"]]);
});

test("leaving a blank conversation while it starts does not pull the person back to it", async () => {
  const script = fakeBridge({ connected: true });
  let made: (id: string) => void = () => {};
  script.bridge.createSession = () =>
    new Promise((resolve) => {
      made = resolve;
    });
  const { store, named } = await opened(script);
  store.openBlank({ locationId: "local", cwd: "/work" });
  await Bun.sleep(1);
  store.drafts.setText(BLANK_KEY, "hi");
  const sending = store.send();
  await store.selectSession("local", "s1");
  made("s2");
  await sending;
  expect(named("prompt")).toEqual([["prompt", "local", "s2", [{ type: "text", text: "hi" }]]]);
  expect(store.getState().selectedSession).toBe("s1");
  expect(store.getState().blank).toBeUndefined();
});

test("the update state is read at the start, follows main's events, and the user can ask for a check", async () => {
  const { bridge, named, emit } = fakeBridge();
  const store = new AppStore(bridge);
  await store.start();
  expect(store.getState().update).toEqual({ current: "0.1.0", kind: "idle" });
  emit({ type: "app-update", state: { current: "0.1.0", kind: "available", version: "0.2.0" } });
  expect(store.getState().update).toMatchObject({ kind: "available", version: "0.2.0" });
  await store.checkForUpdate();
  expect(named("checkForUpdate")).toHaveLength(1);
  expect(store.getState().update?.kind).toBe("up-to-date");
  await store.installUpdate();
  expect(named("installUpdate")).toHaveLength(1);
});

test("an install that main refuses shows its reason, in the words main used", async () => {
  const script = fakeBridge();
  script.bridge.installUpdate = async () => {
    throw new Error("Error invoking remote method 'cycle:installUpdate': Error: no room");
  };
  const store = new AppStore(script.bridge);
  await store.start();
  await store.installUpdate();
  expect(store.getState().error).toBe("no room");
});

const handBack = (texts: string[], reason = "cancelled") => ({
  sessionUpdate: "_cycle/queue_update",
  entries: [],
  reason,
  returned: texts.map((text, i) => ({ queueId: `${text}-${i}`, prompt: [{ type: "text", text }] })),
});

test("what the daemon hands back goes into that session's box once, even for a session not in view", async () => {
  const { store, emit } = await opened();
  const key = viewKey("local", "s1");
  store.drafts.setText(key, "later");
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    update: handBack(["one", "two"]) as never,
    version: 1,
  });
  expect(store.drafts.get(key).text).toBe("one\n\ntwo\n\nlater");
  // Another update does not put it there again.
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    update: { sessionUpdate: "_cycle/queue_update", entries: [] } as never,
    version: 2,
  });
  expect(store.drafts.get(key).text).toBe("one\n\ntwo\n\nlater");
});

test("a page that opens a session whose hand-back it has already taken does not take it again", async () => {
  const snapshot = () => ({
    conversation: reduce([handBack(["gone"]) as never]),
    permissions: [],
    version: 1,
  });
  const drafts = new DraftStore(undefined);
  const key = viewKey("local", "s1");
  drafts.markHandled(key, "gone-0");
  const { store } = await opened(fakeBridge({ connected: true, snapshot }), drafts);
  expect(store.drafts.get(key).text).toBe("");
  // One it has not taken is put in the box when the session opens: it came while nobody looked.
  const other = new DraftStore(undefined);
  const again = await opened(fakeBridge({ connected: true, snapshot }), other);
  expect(again.store.drafts.get(key).text).toBe("gone");
});

test("deleting a session forgets what was written for it", async () => {
  const { store } = await opened();
  const key = viewKey("local", "s1");
  store.drafts.setText(key, "never sent");
  await store.deleteSession("s1");
  expect(store.drafts.get(key).text).toBe("");
});

test("a notification pressed shows that session, on whichever host", async () => {
  const script = fakeBridge({ connected: true });
  const store = new AppStore(script.bridge);
  await store.start();
  script.emit({ type: "focus-session", locationId: "local", sessionId: "s1" });
  // The focus is asked for without waiting (the event handler cannot); the session is opened a moment later.
  for (let i = 0; i < 100 && script.named("openSession").length === 0; i += 1) await Bun.sleep(5);
  expect(store.getState().selectedLocation).toBe("local");
  expect(store.getState().selectedSession).toBe("s1");
  expect(script.named("openSession").at(-1)).toEqual(["openSession", "local", "s1"]);
});

test("a notification about a session that is gone shows nothing and says nothing", async () => {
  const script = fakeBridge({ connected: true });
  const store = new AppStore(script.bridge);
  await store.start();
  await store.focusSession("local", "gone");
  expect(store.getState().selectedSession).toBeUndefined();
  expect(script.named("openSession")).toEqual([]);
  expect(store.getState().error).toBeUndefined();
});

test("a session deleted elsewhere takes its view, its draft and its place as the open one with it", async () => {
  const { store, emit } = await opened();
  const key = viewKey("local", "s1");
  store.drafts.setText(key, "half a thought");
  expect(store.getState().views[key]).toBeDefined();
  expect(store.drafts.get(key).text).toBe("half a thought");
  expect(store.getState().selectedSession).toBe("s1");

  emit({ type: "session-gone", locationId: "local", sessionId: "s1" });
  expect(store.getState().views[key]).toBeUndefined();
  expect(store.getState().selectedSession).toBeUndefined();
  expect(store.drafts.get(key).text).toBe("");
});

test("a session gone on another host does not close the one that is open here", async () => {
  const { store, emit } = await opened();
  emit({ type: "session-gone", locationId: "elsewhere", sessionId: "s1" });
  expect(store.getState().selectedSession).toBe("s1");
  expect(store.getState().views[viewKey("local", "s1")]).toBeDefined();
});

test("a blank conversation follows the agent's defaults when they change, under what was chosen on it", async () => {
  const script = fakeBridge({ connected: true });
  let defaults: Record<string, string> = { mode: "plan", model: "sonnet" };
  script.bridge.agentDefaults = async () => defaults;
  const { store } = await opened(script);
  store.openBlank({ locationId: "local", cwd: "/work" });
  await Bun.sleep(1);
  store.changeBlank({ setting: { key: "model", value: "opus" } });
  defaults = { mode: "default", model: "haiku" };
  script.emit({ type: "agent-defaults", locationId: "local", agent: "fake" });
  await Bun.sleep(1);
  expect(store.getState().blank?.config).toEqual({ mode: "default", model: "opus" });
});

test("a first message that could not go after the person left is kept in the blank conversation's box", async () => {
  const script = fakeBridge({ connected: true });
  let made: (id: string) => void = () => {};
  script.bridge.createSession = () =>
    new Promise((resolve) => {
      made = resolve;
    });
  script.bridge.prompt = async () => {
    throw new Error("The agent cannot start");
  };
  const { store } = await opened(script);
  store.openBlank({ locationId: "local", cwd: "/work" });
  await Bun.sleep(1);
  store.drafts.setText(BLANK_KEY, "hi");
  const sending = store.send();
  await store.selectSession("local", "s1");
  made("s2");
  await sending;
  expect(store.getState().selectedSession).toBe("s1");
  expect(store.drafts.get(BLANK_KEY).text).toBe("hi");
  expect(store.drafts.get(viewKey("local", "s2")).text).toBe("");
});

test("what the page counts goes to main as it is, and a failing report is not the page's trouble", async () => {
  const script = fakeBridge({ connected: true });
  const store = new AppStore(script.bridge, new DraftStore(undefined));
  await store.start();
  store.track("panel_opened", { panel: "search", via: "shortcut" });
  expect(script.calls.filter(([name]) => name === "track")).toEqual([
    ["track", "panel_opened", { panel: "search", via: "shortcut" }],
  ]);

  const broken = fakeBridge({ connected: true });
  broken.bridge.track = () => Promise.reject(new Error("main is gone"));
  const other = new AppStore(broken.bridge, new DraftStore(undefined));
  await other.start();
  expect(() => other.track("slash_command_used", {})).not.toThrow();
  await Bun.sleep(0);
  expect(other.getState().error).toBeUndefined();
});

test("connectors: a change elsewhere is read again only where the page has asked, and a failed read keeps what was read", async () => {
  const script = fakeBridge({ connected: true });
  const store = new AppStore(script.bridge, new DraftStore(undefined));
  await store.start();
  // Nobody has asked about this location's connectors: a change there is not read.
  script.emit({ type: "connectors", locationId: "local" });
  expect(script.named("listConnectors")).toHaveLength(0);
  await store.loadConnectors("local");
  expect(store.getState().connectors.local).toEqual({ list: [] });
  script.emit({ type: "connectors", locationId: "local" });
  await Bun.sleep(0);
  expect(script.named("listConnectors")).toHaveLength(2);

  const added = await store.addConnector("local", {
    name: "docs",
    transport: { type: "http", url: "https://docs.example/mcp" },
    auth: { type: "none" },
  });
  expect("connector" in added).toBe(true);
  expect(store.getState().connectors.local?.list?.map((c) => c.name)).toEqual(["docs"]);

  script.bridge.listConnectors = async () => {
    throw new Error("Error invoking remote method 'cycle:listConnectors': Error: Not connected");
  };
  await store.loadConnectors("local");
  expect(store.getState().connectors.local).toMatchObject({
    list: [{ name: "docs" }],
    error: "Not connected",
  });

  // What main throws is an answer the panel shows like the daemon's own words.
  script.bridge.removeConnector = async () => {
    throw new Error("Not connected to that location");
  };
  expect(await store.removeConnector("local", "c1")).toEqual({
    problem: "failed",
    message: "Not connected to that location",
  });
});

test("saveLocation, renameSession, and reloadAgents surface failures and refresh agents", async () => {
  const script = fakeBridge({ connected: true });
  script.bridge.saveLocation = async () => {
    throw new Error("Could not write settings");
  };
  script.bridge.renameSession = async () => {
    throw new Error("Session locked");
  };
  let calls = 0;
  script.bridge.agents = async () => {
    calls += 1;
    return [{ id: "claude", name: "Claude", available: calls > 1, configSchema: {} }];
  };
  const store = new AppStore(script.bridge, new DraftStore(undefined));
  await store.start();
  expect(store.getState().agents.local?.[0]?.available).toBe(false);

  expect(
    await store.saveLocation({
      id: "ssh-bad",
      name: "Bad",
      kind: "remote",
      transport: { type: "ssh", host: "bad" },
    }),
  ).toBe("Could not write settings");
  expect(await store.renameSession("s1", "New")).toBe("Session locked");

  await store.reloadAgents("local");
  expect(store.getState().agents.local?.[0]?.available).toBe(true);
});

test("config_option_update only reloads agents when a live update introduces a new model catalog", async () => {
  const script = fakeBridge({ connected: true });
  let agentCalls = 0;
  script.bridge.agents = async () => {
    agentCalls += 1;
    return [
      {
        id: "fake",
        name: "Fake",
        available: true,
        configSchema: {
          type: "object",
          properties: {
            model: {
              type: "string",
              oneOf:
                agentCalls > 1
                  ? [
                      { const: "default", title: "Default model" },
                      { const: "fabel", title: "Fabel" },
                    ]
                  : [
                      { const: "default", title: "Default model" },
                      { const: "sonnet", title: "Sonnet" },
                    ],
            },
          },
        },
      },
    ];
  };
  const { emit } = await opened(script);
  expect(agentCalls).toBe(1);

  // Unchanged model catalog (e.g. permission mode flip) does not reload agents.
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    version: 1,
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          configId: "model",
          name: "Model",
          type: "select",
          currentValue: "default",
          options: [
            { value: "default", name: "Default model" },
            { value: "sonnet", name: "Sonnet" },
          ],
        },
      ],
    },
  });
  await Bun.sleep(5);
  expect(agentCalls).toBe(1);

  // A live update advertising a newly discovered model refreshes agents once.
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    version: 2,
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          configId: "model",
          name: "Model",
          type: "select",
          currentValue: "default",
          options: [
            { value: "default", name: "Default model" },
            { value: "fabel", name: "Fabel" },
          ],
        },
      ],
    },
  });
  await Bun.sleep(5);
  expect(agentCalls).toBe(2);
});

test("the blank folder's trust is read once its location says it keeps trust", async () => {
  const script = fakeBridge({ connected: false });
  script.bridge.readTrust = async (_location, path) => ({ path, trusted: null, from: null });
  const store = new AppStore(script.bridge);
  await store.start();
  store.openBlank({ locationId: "local", cwd: "/work" });
  // Not connected: nothing can be asked yet.
  await Bun.sleep(5);
  expect(store.getState().blank?.trust).toBeUndefined();
  script.emit({
    type: "location-status",
    locationId: "local",
    state: "connected",
    capabilities: { queue: true, files: true, folders: true, trust: true },
  });
  await Bun.sleep(10);
  expect(store.getState().blank?.trust).toBe("undecided");
});

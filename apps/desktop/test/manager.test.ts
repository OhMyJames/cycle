import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Channel, connectUnix } from "@cycle/client";
import { Daemon, listenUnix } from "@cycle/daemon";
import { type AppEvent, applyUpdate, emptyConversation, type LocationConfig } from "@cycle/ui";
import { AppStore, viewKey } from "../../../packages/ui/src/store/store.ts";
import { fakeBridge } from "../../../packages/ui/test/fake-bridge.ts";
import { fakeAgent } from "../../daemon/test/fake-agent.ts";
import { environmentRefusalOf } from "../src/main/actions.ts";
import { memoryEnvironments } from "../src/main/environments.ts";
import {
  type AttentionNotice,
  ConnectionManager,
  formAnswerOf,
  type Tracker,
} from "../src/main/manager.ts";
import { fileSettings, LOCAL_LOCATION } from "../src/main/settings.ts";
import { MIN_DAEMON_VERSION } from "../src/shared/release.ts";

let dir: string;
let cleanup: (() => void | Promise<void>)[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-"));
});
afterEach(async () => {
  for (const clean of cleanup.reverse()) await clean();
  cleanup = [];
  await rm(dir, { recursive: true, force: true });
});

const until = async (condition: () => boolean, what: string, ms = 3_000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

/** A daemon on a socket with a fake agent, and managers that reach it. */
const setup = async (fake = fakeAgent(), daemonVersion?: string) => {
  const daemon = await Daemon.start({
    dataDir: join(dir, "daemon"),
    agents: [fake.definition],
    ...(daemonVersion !== undefined ? { version: daemonVersion } : {}),
  });
  const socket = join(dir, "d.sock");
  const server = await listenUnix({
    path: socket,
    onConnection: ({ stream }) => void daemon.accept(stream),
  });
  cleanup.push(async () => {
    server.close();
    await daemon.close();
  });
  const channels: Channel[] = [];
  /** Managers (by name) that cannot reach the daemon for now. */
  const held = new Set<string>();
  const manager = async (
    name = "app",
    appVersion?: string,
    attention?: (notice: AttentionNotice) => void,
    track?: Tracker,
    more: Partial<ConstructorParameters<typeof ConnectionManager>[0]> = {},
  ) => {
    const events: AppEvent[] = [];
    const m = new ConnectionManager({
      settings: fileSettings(join(dir, `settings-${name}.json`)),
      channelFor: () => async () => {
        if (held.has(name)) throw new Error("the network is down");
        const channel = await connectUnix(socket);
        channels.push(channel);
        return channel;
      },
      emit: (event) => events.push(event),
      backoff: { first: 10, max: 50 },
      ...(appVersion !== undefined ? { appVersion } : {}),
      ...(attention !== undefined ? { attention } : {}),
      ...(track !== undefined ? { track } : {}),
      ...more,
    });
    await m.init();
    cleanup.push(() => m.close());
    return { m, events };
  };
  return {
    fake,
    manager,
    held,
    drop: () => {
      for (const channel of channels.splice(0)) channel.close();
    },
  };
};

/** The first of a list that must not be empty. */
const first = <T>(items: T[]): T => {
  const item = items[0];
  if (item === undefined) throw new Error("expected something, found nothing");
  return item;
};

/** A session is in the list from its first message (docs/protocol.md §6): say something in it, and wait for the list. */
const said = async (m: ConnectionManager, id: string, words = "hi") => {
  await m.prompt("local", id, words);
  const started = Date.now();
  while (!(await m.sessions("local")).some((s) => s.sessionId === id)) {
    if (Date.now() - started > 3_000)
      throw new Error("timed out waiting for the session to be listed");
    await Bun.sleep(10);
  }
};

const of = <T extends AppEvent["type"]>(events: AppEvent[], type: T) =>
  events.filter((e): e is Extract<AppEvent, { type: T }> => e.type === type);

test("the first page reaches the sidebar before the full search list, and subsequent refreshes are atomic", async () => {
  const dataDir = join(dir, "daemon");
  const sessions: Record<string, unknown> = {};
  for (let i = 0; i < 51; i++) {
    const id = String(i).padStart(2, "0");
    sessions[id] = {
      agent: "fake",
      agentSessionId: id,
      cwd: "/private/project",
      title: `private-${id}`,
      createdAt: "2026-01-02T00:00:00.000Z",
      prompted: true,
      turnOpen: false,
    };
    await Bun.write(join(dataDir, "sessions", `${id}.jsonl`), "");
  }
  await Bun.write(join(dataDir, "index.json"), JSON.stringify({ version: 1, sessions }));
  const { manager } = await setup();
  const reports: unknown[] = [];
  const { m, events } = await manager("app", undefined, undefined, (name, props) => {
    if (name === "session_list_loaded") reports.push(props);
  });
  await m.connect("local");
  expect(of(events, "sessions").map((e) => e.sessions.length)).toEqual([50, 51]);
  expect(of(events, "sessions").at(-1)?.sessions.at(-1)?.title).toBe("private-50");
  await m.sessions("local");
  expect(of(events, "sessions").map((e) => e.sessions.length)).toEqual([50, 51, 51]);
  expect(reports).toEqual([{ pages: 2 }]);
});

test("connects, creates a session, and lists it", async () => {
  const { manager } = await setup();
  const { m, events } = await manager();
  await m.connect("local");
  expect(of(events, "location-status").map((e) => e.state)).toEqual(["connecting", "connected"]);
  const id = await m.createSession("local", { cwd: "/tmp" });
  // Nothing said in it yet: not in the list.
  expect(await m.sessions("local")).toEqual([]);
  await said(m, id);
  const sessions = await m.sessions("local");
  // Its agent is running, so it is idle and not stopped.
  expect(sessions).toMatchObject([
    { sessionId: id, cwd: "/tmp", agent: "fake", archived: false, state: "idle" },
  ]);
  expect(of(events, "sessions").length).toBeGreaterThan(0);
  // What the daemon said it can do reaches the page with the connection's state.
  expect(of(events, "location-status").at(-1)?.capabilities).toEqual({
    queue: true,
    steer: true,
    files: true,
    folders: true,
    filesInFolder: true,
    trust: true,
    connectors: true,
    plugins: [],
    agentSetup: true,
    sessionMentions: true,
    fs: true,
    diff: true,
    terminal: true,
    environments: true,
    stopSubagent: true,
  });
  expect((await m.agents("local")).map((a) => a.id)).toEqual(["fake"]);
});

test("an agent that takes images says so, and a message of blocks reaches it as the same blocks", async () => {
  const fake = fakeAgent({}, { promptCapabilities: { image: {} } });
  const { manager } = await setup(fake);
  const { m } = await manager();
  await m.connect("local");
  // What the composer looks at to decide whether to offer an attach button.
  const [agent] = await m.agents("local");
  expect(agent?.promptCapabilities?.image).toEqual({});
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  const picture = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
  await m.prompt("local", id, [{ type: "text", text: "what is this" }, picture]);
  await until(() => fake.log.blocks.length === 1, "the agent to be asked");
  expect(fake.log.blocks[0]).toEqual([{ type: "text", text: "what is this" }, picture]);
  // A plain text still goes as it always did.
  await m.prompt("local", id, "and this");
  await until(() => fake.log.blocks.length === 2, "the second prompt");
  expect(fake.log.blocks[1]).toEqual([{ type: "text", text: "and this" }]);
});

test("every prompt says whether the person wants a suggestion of what to say next, as the setting is now (CYCL-225)", async () => {
  const fake = fakeAgent();
  const { manager } = await setup(fake);
  let wanted = true;
  const { m } = await manager("app", undefined, undefined, undefined, {
    promptSuggestions: () => wanted,
  });
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, "one");
  await until(() => fake.log.promptMetas.length === 1, "the first prompt");
  wanted = false;
  await m.prompt("local", id, "two");
  await until(() => fake.log.promptMetas.length === 2, "the second prompt");
  expect(fake.log.promptMetas).toEqual([
    { "cycle/promptSuggestions": true },
    { "cycle/promptSuggestions": false },
  ]);
});

test("an image to an agent that did not say it takes images is refused, and nothing reaches it", async () => {
  const fake = fakeAgent();
  const { manager } = await setup(fake);
  const { m } = await manager();
  await m.connect("local");
  const [agent] = await m.agents("local");
  // No word of images: the interface has no attach button for this agent.
  expect(agent?.promptCapabilities?.image).toBeUndefined();
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await expect(
    m.prompt("local", id, [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]),
  ).rejects.toThrow();
  expect(fake.log.blocks).toHaveLength(0);
});

test("a session opened after the fact comes whole, and its version counts the events", async () => {
  const { manager } = await setup();
  const { m, events } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  const opened = await m.openSession("local", id);
  expect(opened.version).toBeGreaterThanOrEqual(0);
  await m.prompt("local", id, "hello");
  await until(
    () =>
      of(events, "update").some(
        (e) => (e.update as { stopReason?: string }).stopReason === "end_turn",
      ),
    "the turn",
  );

  // The renderer reloads: it asks again and is given everything.
  const snapshot = await m.openSession("local", id);
  expect(snapshot.conversation.turns).toBe(1);
  expect(snapshot.conversation.items.map((i) => i.kind)).toEqual(["user", "agent"]);
  const updates = of(events, "update").filter((e) => e.sessionId === id);
  expect(snapshot.version).toBe(updates.at(-1)?.version as number);
  // Versions go up by one, so a renderer can tell if it missed any.
  expect(updates.map((e) => e.version)).toEqual(updates.map((_, n) => first(updates).version + n));
  // The conversation main holds is what applying the events one by one gives, with the times they carry.
  expect(updates.some((e) => e.at !== undefined)).toBe(true);
  const rebuilt = updates.reduce((c, e) => applyUpdate(c, e.update, { at: e.at }), {
    ...emptyConversation(),
    replaying: true,
  });
  expect(rebuilt).toEqual(snapshot.conversation);
});

test("agent mode changes reach the open session list, reconnect and fresh history replay", async () => {
  const offline = Promise.withResolvers<void>();
  let reported = false;
  const { manager, held, drop } = await setup(
    fakeAgent({
      onPrompt: async ({ say }) => {
        for (const mode of ["plan", "default"]) {
          if (mode === "default") await offline.promise;
          await say({
            sessionUpdate: "config_option_update",
            configOptions: [
              {
                configId: "mode",
                type: "select",
                name: "Permission mode",
                currentValue: mode,
                options: [
                  { value: "plan", name: "Plan" },
                  { value: "default", name: "Default" },
                ],
              },
            ],
          });
        }
        reported = true;
      },
    }),
  );
  const { m, events } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, "work");
  const listedMode = () =>
    of(events, "sessions")
      .at(-1)
      ?.sessions.find((s) => s.sessionId === id)?.config?.mode;
  try {
    await until(() => listedMode() === "plan", "the live setting");
    held.add("app");
    drop();
    await until(() => of(events, "location-status").at(-1)?.state === "reconnecting", "disconnect");
  } finally {
    offline.resolve();
  }
  await until(() => reported, "the agent to report the offline change");
  held.delete("app");
  await until(() => listedMode() === "default", "the setting changed while disconnected");

  const fresh = await manager("fresh");
  await fresh.m.connect("local");
  expect(of(fresh.events, "sessions").at(-1)?.sessions[0]?.config?.mode).toBe("default");
  const snapshot = await fresh.m.openSession("local", id);
  expect(snapshot.conversation.replaying).toBe(false);
  expect(snapshot.conversation.configOptions).toMatchObject([
    { configId: "mode", currentValue: "default" },
  ]);
});

test("opening a session twice at once watches it once", async () => {
  const { manager } = await setup();
  const { m } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  const [a, b] = await Promise.all([m.openSession("local", id), m.openSession("local", id)]);
  expect(a.version).toBe(b.version);
});

test("a permission request is shown, held for a reloaded renderer, and answered", async () => {
  const outcomes: unknown[] = [];
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        outcomes.push(await ask());
      },
    }),
  );
  const { m, events } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, "ask");
  await until(() => of(events, "permission").length === 1, "the request");
  const request = first(of(events, "permission")).request;
  expect(request).toMatchObject({ locationId: "local", sessionId: id, title: "Allow it?" });
  expect(request.options.map((o) => o.optionId)).toEqual(["allow", "deny"]);

  // A renderer that reloads is given the request that is still waiting.
  const snapshot = await m.openSession("local", id);
  expect(snapshot.permissions.map((p) => p.key)).toEqual([request.key]);

  await m.answerPermission(request.key, "allow");
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(outcomes[0]).toMatchObject({ outcome: { outcome: "selected", optionId: "allow" } });
  expect(of(events, "permission-closed").map((e) => e.key)).toEqual([request.key]);
  expect((await m.openSession("local", id)).permissions).toEqual([]);
});

test("a request answered by another client is closed here", async () => {
  const outcomes: unknown[] = [];
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        outcomes.push(await ask());
      },
    }),
  );
  const mine = await manager("mine");
  const theirs = await manager("theirs");
  await mine.m.connect("local");
  await theirs.m.connect("local");
  const id = await mine.m.createSession("local", { cwd: "/tmp" });
  await mine.m.openSession("local", id);
  // The other client finds it in the list once something is said in it, and is asked too.
  await mine.m.prompt("local", id, "ask");
  await until(() => of(mine.events, "permission").length === 1, "the request");
  const started = Date.now();
  while (!(await theirs.m.sessions("local")).some((s) => s.sessionId === id)) {
    if (Date.now() - started > 3_000) throw new Error("timed out waiting for the list");
    await Bun.sleep(10);
  }
  await theirs.m.openSession("local", id);
  await until(
    () =>
      of(mine.events, "permission").length === 1 && of(theirs.events, "permission").length === 1,
    "both to be asked",
  );

  await theirs.m.answerPermission(first(of(theirs.events, "permission")).request.key, "deny");
  await until(() => of(mine.events, "permission-closed").length === 1, "the request to close here");
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ outcome: { optionId: "deny" } });
});

test("a connection that drops is picked up again, and a request still open is not shown twice", async () => {
  const outcomes: unknown[] = [];
  const { manager, drop } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        outcomes.push(await ask());
      },
    }),
  );
  const { m, events } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, "ask");
  await until(() => of(events, "permission").length === 1, "the request");

  drop();
  await until(
    () => of(events, "location-status").some((e) => e.state === "reconnecting"),
    "the loss",
  );
  // What the daemon can do is not forgotten while the line is down.
  expect(
    of(events, "location-status").find((e) => e.state === "reconnecting")?.capabilities,
  ).toEqual({
    queue: true,
    steer: true,
    files: true,
    folders: true,
    filesInFolder: true,
    trust: true,
    connectors: true,
    plugins: [],
    agentSetup: true,
    sessionMentions: true,
    fs: true,
    diff: true,
    terminal: true,
    environments: true,
    stopSubagent: true,
  });
  await until(() => of(events, "location-status").at(-1)?.state === "connected", "the reconnect");
  // The daemon asked again on the new connection: still one request on screen, not two.
  await Bun.sleep(100);
  expect(of(events, "permission")).toHaveLength(1);
  const key = first(of(events, "permission")).request.key;
  await m.answerPermission(key, "allow");
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(outcomes[0]).toMatchObject({ outcome: { optionId: "allow" } });
});

test("a request of a connection that was closed is not answered, and the one asked again after is", async () => {
  const outcomes: unknown[] = [];
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        outcomes.push(await ask());
      },
    }),
  );
  const tracked: string[] = [];
  const { m, events } = await manager("app", undefined, undefined, (name) => tracked.push(name));
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, "ask");
  await until(() => of(events, "permission").length === 1, "the request");
  const key = first(of(events, "permission")).request.key;

  await m.disconnect("local");
  await m.answerPermission(key, "allow");
  await m.answerForm(key, { action: "accept", content: {} });
  expect(of(events, "permission-closed")).toEqual([]);
  expect(tracked).not.toContain("permission_answered");
  expect(tracked).not.toContain("form_answered");

  // Connected again, the daemon asks again under the same key: that one is the new connection's, and is answered.
  await m.connect("local");
  await m.openSession("local", id);
  await until(() => of(events, "permission").length === 2, "the request asked again");
  expect(of(events, "permission").at(-1)?.request.key).toBe(key);
  await m.answerPermission(key, "allow");
  await until(() => outcomes.length === 1, "the agent to be answered");
  expect(outcomes[0]).toMatchObject({ outcome: { optionId: "allow" } });
  expect(of(events, "permission-closed").map((e) => e.key)).toEqual([key]);
  expect(tracked.filter((name) => name === "permission_answered")).toHaveLength(1);
});

test("renames, archives and deletes a session, and the list follows", async () => {
  const { manager } = await setup();
  const { m } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await said(m, id);
  await m.renameSession("local", id, "Named");
  await m.archiveSession("local", id, true);
  expect(await m.sessions("local")).toMatchObject([{ title: "Named", archived: true }]);
  await m.deleteSession("local", id);
  expect(await m.sessions("local")).toEqual([]);
});

test("an agent's defaults are read and set", async () => {
  const { manager } = await setup();
  const { m, events } = await manager();
  await m.connect("local");
  expect(await m.agentDefaults("local", "fake")).toEqual({});
  await m.setAgentDefaults("local", "fake", { mode: "plan" });
  expect(await m.agentDefaults("local", "fake")).toEqual({ mode: "plan" });
  await until(() => of(events, "agent-defaults").length === 1, "the change");
});

test("a location whose address ssh would read as an option is refused, not saved", async () => {
  const { manager } = await setup();
  const { m } = await manager("opt");
  await expect(
    m.saveLocation({
      id: "x",
      name: "X",
      kind: "remote",
      transport: { type: "ssh", host: "-oProxyCommand=touch /tmp/x" },
    }),
  ).rejects.toThrow("not a location");
  expect((await m.locations()).locations.map((e) => e.id)).toEqual(["local"]);
});

test("locations are kept across runs, and the local one stays", async () => {
  const { manager } = await setup();
  const first = await manager("a");
  const box: LocationConfig = {
    id: "box",
    name: "Box",
    kind: "remote",
    transport: { type: "ssh", host: "me@box" },
  };
  await first.m.saveLocation(box);
  expect((await first.m.locations()).locations.map((h) => h.id)).toEqual(["local", "box"]);
  const again = new ConnectionManager({
    settings: fileSettings(join(dir, "settings-a.json")),
    channelFor: () => async () => {
      throw new Error("no");
    },
    emit: () => {},
  });
  await again.init();
  expect((await again.locations()).locations).toEqual([LOCAL_LOCATION, box]);
  await expect(again.removeLocation("local")).rejects.toThrow("cannot be removed");
  await again.removeLocation("box");
  expect((await again.locations()).locations).toEqual([LOCAL_LOCATION]);
});

test("a host that cannot be reached ends closed, with why", async () => {
  const events: AppEvent[] = [];
  const m = new ConnectionManager({
    settings: fileSettings(join(dir, "s.json")),
    channelFor: () => async () => {
      throw new Error("Host key verification failed");
    },
    emit: (e) => events.push(e),
  });
  await m.init();
  await expect(m.connect("local")).rejects.toThrow("Host key verification failed");
  expect(of(events, "location-status").at(-1)).toMatchObject({
    state: "closed",
    error: "Host key verification failed",
  });
  expect((await m.locations()).status[0]?.state).toBe("closed");
});

const far: LocationConfig = {
  id: "far",
  name: "Far",
  kind: "remote",
  transport: { type: "ssh", host: "example" },
};
const connectedStatus = (events: AppEvent[], locationId: string) =>
  events.findLast(
    (e): e is Extract<AppEvent, { type: "location-status" }> =>
      e.type === "location-status" && e.locationId === locationId && e.state === "connected",
  );

const lastStatus = (events: AppEvent[]) =>
  events.findLast(
    (e): e is Extract<AppEvent, { type: "location-status" }> =>
      e.type === "location-status" && e.locationId === "far",
  );

test("a remote host whose daemon is below the least the app works with is told so, with what to run on it", async () => {
  const { manager } = await setup(fakeAgent(), "0.1.0");
  const { m, events } = await manager("app", "9.9.9");
  await m.saveLocation(far);
  await m.connect("far");
  const daemon = connectedStatus(events, "far")?.daemon;
  expect(daemon?.version).toBe("0.1.0");
  expect(daemon?.upgrade?.to).toBe("9.9.9");
  expect(daemon?.upgrade?.command).toContain("releases/download/v9.9.9/install.sh");
  expect(daemon?.upgrade?.command).toContain("sha256sum -c");
  expect(daemon?.upgrade?.command).toContain("install.sh");
});

test("a daemon at or above the least, older than the app or not, or a development build, is not nagged about", async () => {
  for (const version of [MIN_DAEMON_VERSION, "9.0.0", "9.9.9", undefined]) {
    const { manager } = await setup(fakeAgent(), version);
    const { m, events } = await manager("app", "9.9.9");
    await m.saveLocation(far);
    await m.connect("far");
    expect(connectedStatus(events, "far")?.daemon?.upgrade).toBeUndefined();
    await m.close();
    for (const clean of cleanup.splice(0).reverse()) await clean();
  }
});

test("updating a daemon runs its command on that host, says it is running, and is counted", async () => {
  const { manager } = await setup(fakeAgent(), "0.1.0");
  const ran: string[] = [];
  const tracked: unknown[] = [];
  const { m, events } = await manager(
    "app",
    "9.9.9",
    undefined,
    (name, props) => tracked.push([name, props]),
    {
      runOnHost: async (location, command) => {
        ran.push(`${location.id}: ${command}`);
        expect(lastStatus(events)?.daemon?.upgrade?.running).toBe(true);
      },
      settle: 10,
    },
  );
  await m.saveLocation(far);
  await m.connect("far");
  await m.upgradeDaemon("far");
  expect(ran).toHaveLength(1);
  expect(ran[0]).toContain("far: cd ");
  // Nothing was working there: the plain stop, which refuses rather than interrupt something started since.
  expect(ran[0]).toEndWith('"$HOME/.local/bin/cycle" stop');
  expect(tracked).toContainEqual(["daemon_upgraded", { ok: true, when: "idle" }]);
  // If the connection never drops, the wait ends and the button is back.
  await until(() => lastStatus(events)?.daemon?.upgrade?.running === undefined, "the wait to end");
});

test("a second click while the update runs does not run it again", async () => {
  const { manager } = await setup(fakeAgent(), "0.1.0");
  let runs = 0;
  let finish: () => void = () => {};
  const { m } = await manager("app", "9.9.9", undefined, undefined, {
    runOnHost: () => {
      runs += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    settle: 10,
  });
  await m.saveLocation(far);
  await m.connect("far");
  const first = m.upgradeDaemon("far");
  await m.upgradeDaemon("far");
  expect(runs).toBe(1);
  finish();
  await first;
});

test("a daemon update that fails says why in the status and keeps the command", async () => {
  const { manager } = await setup(fakeAgent(), "0.1.0");
  const tracked: unknown[] = [];
  const { m, events } = await manager(
    "app",
    "9.9.9",
    undefined,
    (name, props) => tracked.push([name, props]),
    {
      runOnHost: async () => {
        throw new Error("Permission denied (publickey).");
      },
    },
  );
  await m.saveLocation(far);
  await m.connect("far");
  await m.upgradeDaemon("far");
  const upgrade = lastStatus(events)?.daemon?.upgrade;
  expect(upgrade?.error).toBe("Permission denied (publickey).");
  expect(upgrade?.running).toBeUndefined();
  expect(upgrade?.command).toContain("install.sh");
  expect(tracked).toContainEqual(["daemon_upgraded", { ok: false, when: "idle" }]);
  // What was said is not what is reported: only that it did not work.
  expect(JSON.stringify(tracked)).not.toContain("publickey");
});

test("with sessions working, updating later installs and leaves the old daemon to stop when they finish", async () => {
  const { manager } = await setup(fakeAgent(), "0.1.0");
  const ran: string[] = [];
  const tracked: unknown[] = [];
  const { m, events } = await manager(
    "app",
    "9.9.9",
    undefined,
    (name, props) => tracked.push([name, props]),
    {
      runOnHost: async (_location, command) => {
        ran.push(command);
      },
      settle: 10,
    },
  );
  await m.saveLocation(far);
  await m.connect("far");
  await m.upgradeDaemon("far", "later");
  expect(ran).toHaveLength(1);
  expect(ran[0]).toContain("stop --wait");
  expect(ran[0]).not.toContain("--force");
  expect(tracked).toContainEqual(["daemon_upgraded", { ok: true, when: "later" }]);
  // Said until the connection comes back to the new daemon, not taken back after a while.
  await Bun.sleep(30);
  const upgrade = lastStatus(events)?.daemon?.upgrade;
  expect(upgrade?.waiting).toBe(true);
  expect(upgrade?.running).toBeUndefined();
  // While it waits, only interrupting is still to choose.
  await m.upgradeDaemon("far");
  await m.upgradeDaemon("far", "later");
  expect(ran).toHaveLength(1);
  await m.upgradeDaemon("far", "now");
  expect(ran).toHaveLength(2);
  expect(ran[1]).toContain("stop --force");
  expect(tracked).toContainEqual(["daemon_upgraded", { ok: true, when: "now" }]);
  expect(lastStatus(events)?.daemon?.upgrade?.waiting).toBeUndefined();
});

test("the page can only ask for the ways to stop there are", async () => {
  const { manager } = await setup(fakeAgent(), "0.1.0");
  const ran: string[] = [];
  const tracked: unknown[] = [];
  const { m } = await manager(
    "app",
    "9.9.9",
    undefined,
    (name, props) => tracked.push([name, props]),
    {
      runOnHost: async (_location, command) => {
        ran.push(command);
      },
      settle: 10,
    },
  );
  await m.saveLocation(far);
  await m.connect("far");
  await m.upgradeDaemon("far", "; rm -rf ~");
  expect(ran[0]).toEndWith('"$HOME/.local/bin/cycle" stop');
  expect(tracked).toContainEqual(["daemon_upgraded", { ok: true, when: "idle" }]);
});

test("after a daemon update failed, trying again runs it again", async () => {
  const { manager } = await setup(fakeAgent(), "0.1.0");
  let runs = 0;
  const { m, events } = await manager("app", "9.9.9", undefined, undefined, {
    runOnHost: async () => {
      runs += 1;
      // The first time, sessions there had started working: the plain stop refused.
      if (runs === 1) throw new Error("Not stopped. 1 session is working.");
    },
    settle: 10,
  });
  await m.saveLocation(far);
  await m.connect("far");
  await m.upgradeDaemon("far");
  expect(lastStatus(events)?.daemon?.upgrade?.error).toContain("Not stopped");
  await m.upgradeDaemon("far", "later");
  expect(runs).toBe(2);
  expect(lastStatus(events)?.daemon?.upgrade?.error).toBeUndefined();
});

test("nothing is run for a daemon that is not too old", async () => {
  const { manager } = await setup(fakeAgent(), "9.9.9");
  let runs = 0;
  const { m } = await manager("app", "9.9.9", undefined, undefined, {
    runOnHost: async () => {
      runs += 1;
    },
  });
  await m.saveLocation(far);
  await m.connect("far");
  await m.upgradeDaemon("far");
  expect(runs).toBe(0);
});

test("the local host is not compared: the app carries it", async () => {
  const { manager } = await setup(fakeAgent(), "0.0.1");
  const { m, events } = await manager("app", "0.1.1");
  await m.connect("local");
  expect(connectedStatus(events, "local")?.daemon).toBeUndefined();
});

test("a message sent while the agent works waits in the conversation, and can be taken back", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { manager, fake } = await setup(fakeAgent({ onPrompt: () => held }));
  const { m } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, "first");
  await m.prompt("local", id, "second");
  await m.prompt("local", id, "third");
  const waiting = async () => (await m.openSession("local", id)).conversation.queue;
  // `until` takes a plain condition: look, and wait for the two to be there.
  let queue = await waiting();
  for (let tries = 0; queue.length < 2 && tries < 400; tries++) {
    await Bun.sleep(5);
    queue = await waiting();
  }
  const [second, third] = queue;
  expect(queue.map((p) => p.prompt)).toEqual([
    [{ type: "text", text: "second" }],
    [{ type: "text", text: "third" }],
  ]);
  expect(second?.prompt).toEqual([{ type: "text", text: "second" }]);
  // The person changes their mind about the second.
  expect(await m.dequeue("local", id, second?.queueId ?? "")).toEqual([
    { type: "text", text: "second" },
  ]);
  release();
  await until(() => fake.log.prompts.length === 2, "the third to be sent");
  expect(fake.log.prompts).toEqual(["first", "third"]);
  expect(third?.queueId).toBeString();
  // The snapshots that say so come after the agent got it.
  queue = await waiting();
  for (let tries = 0; queue.length > 0 && tries < 400; tries++) {
    await Bun.sleep(5);
    queue = await waiting();
  }
  expect(queue).toEqual([]);
});

test("a session that asks and then finishes is reported to the main process, and the first list is not a change", async () => {
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        await ask();
      },
    }),
  );
  const notices: AttentionNotice[] = [];
  const { m, events } = await manager("app", undefined, (n) => notices.push(n));
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  // Reading the list for the first time, and creating a session, tell nothing.
  expect(notices).toEqual([]);
  await m.openSession("local", id);
  await m.prompt("local", id, "ask");
  await until(() => of(events, "permission").length === 1, "the request");
  await until(() => notices.length === 1, "the session to be reported as asking");
  expect(notices[0]).toMatchObject({
    locationId: "local",
    locationName: LOCAL_LOCATION.name,
    kind: "needs-you",
    session: { sessionId: id, state: "requires_action" },
  });
  await m.answerPermission(first(of(events, "permission")).request.key, "allow");
  await until(() => notices.length === 2, "the session to be reported as done");
  expect(notices[1]).toMatchObject({ kind: "finished", session: { sessionId: id, state: "idle" } });
});

test("the first list a manager reads is not a change, even when a session in it is asking", async () => {
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        await ask();
      },
    }),
  );
  const first = await manager("first");
  await first.m.connect("local");
  const id = await first.m.createSession("local", { cwd: "/tmp" });
  await first.m.openSession("local", id);
  await first.m.prompt("local", id, "ask");
  await until(() => of(first.events, "permission").length === 1, "the request");
  // Another app starts while the session is asking: what it is told is the list, not a change in it.
  const notices: AttentionNotice[] = [];
  const second = await manager("second", undefined, (n) => notices.push(n));
  await second.m.connect("local");
  const listed = await second.m.sessions("local");
  expect(listed.map((s) => s.state)).toEqual(["requires_action"]);
  await Bun.sleep(50);
  expect(notices).toEqual([]);
});

test("a session made elsewhere is reported when it finishes, even if it is first listed done", async () => {
  const { manager } = await setup();
  const notices: AttentionNotice[] = [];
  const watcher = await manager("watcher", undefined, (n) => notices.push(n));
  await watcher.m.connect("local");
  expect(await watcher.m.sessions("local")).toEqual([]);
  // Another client starts a session: its first turn may well be over by the time this one reads the list.
  const maker = await manager("maker");
  await maker.m.connect("local");
  const id = await maker.m.createSession("local", { cwd: "/tmp" });
  await maker.m.prompt("local", id, "hi");
  await until(
    () => notices.some((n) => n.kind === "finished" && n.session.sessionId === id),
    "the finished session to be reported",
  );
  expect(notices.filter((n) => n.session.sessionId === id).map((n) => n.kind)).toEqual([
    "finished",
  ]);
});

test("a hook that fails does not stop the list from being read, and a manager without one says nothing", async () => {
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        await ask();
      },
    }),
  );
  const { m, events } = await manager("app", undefined, () => {
    throw new Error("no notification today");
  });
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, "ask");
  // The list still reaches the renderer, with the session asking.
  await until(
    () => of(events, "sessions").some((e) => e.sessions.some((s) => s.state === "requires_action")),
    "the renderer to be told the session is asking",
  );
  const quiet = await manager("quiet");
  await quiet.m.connect("local");
  expect(quiet.events.length).toBeGreaterThan(0);
});

test("a session deleted elsewhere while the connection was away is gone here, and the rest is as before", async () => {
  const { manager, held, drop } = await setup();
  const a = await manager("a");
  await a.m.connect("local");
  const keep = await a.m.createSession("local", { cwd: "/tmp" });
  const doomed = await a.m.createSession("local", { cwd: "/tmp" });
  await a.m.openSession("local", keep);
  await a.m.openSession("local", doomed);
  await said(a.m, keep);
  await said(a.m, doomed);
  const b = await manager("b");
  await b.m.connect("local");

  held.add("a");
  drop();
  await until(
    () => of(a.events, "location-status").some((e) => e.state === "reconnecting"),
    "the loss",
  );
  await until(() => of(b.events, "location-status").at(-1)?.state === "connected", "b to be back");
  await b.m.deleteSession("local", doomed);
  held.delete("a");
  await until(
    () => of(a.events, "location-status").at(-1)?.state === "connected",
    "a to reconnect",
  );

  await until(() => of(a.events, "sessions").at(-1)?.sessions.length === 1, "the list to follow");
  expect(first(of(a.events, "sessions").slice(-1)).sessions.map((s) => s.sessionId)).toEqual([
    keep,
  ]);
  // The renderer is told, so it can drop the view and the dialogs of the session.
  expect(of(a.events, "session-gone")).toEqual([
    { type: "session-gone", locationId: "local", sessionId: doomed },
  ]);
  await expect(a.m.openSession("local", doomed)).rejects.toThrow();
  // The session that is still there goes on being watched.
  const seen = of(a.events, "update").length;
  await a.m.prompt("local", keep, "still here");
  await until(() => of(a.events, "update").length > seen, "the healthy session to go on");
});

test("every host is connected, one that cannot be reached does not hold up the others, and why is kept for a renderer that asks later", async () => {
  const { manager } = await setup();
  const { m, events } = await manager("all");
  await m.saveLocation(far);
  // Same settings file, a manager whose far location cannot be reached.
  const both = new ConnectionManager({
    settings: fileSettings(join(dir, "settings-all.json")),
    channelFor: (location) => async () => {
      if (location.id === "far") throw new Error("Host key verification failed");
      return connectUnix(join(dir, "d.sock"));
    },
    emit: (e) => events.push(e),
  });
  await both.init();
  cleanup.push(() => both.close());
  await both.connectAll();
  const { status } = await both.locations();
  expect(status.find((s) => s.locationId === "local")?.state).toBe("connected");
  expect(status.find((s) => s.locationId === "far")).toMatchObject({
    state: "closed",
    error: "Host key verification failed",
  });
});

test("the last list of a host that goes away is still given, and a host removed has none", async () => {
  const { manager } = await setup();
  const { m } = await manager();
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await said(m, id);
  expect((await m.locations()).sessions.local?.map((s) => s.sessionId)).toEqual([id]);
  await m.disconnect("local");
  const after = await m.locations();
  expect(after.status[0]?.state).toBe("closed");
  expect(after.sessions.local?.map((s) => s.sessionId)).toEqual([id]);
  await m.saveLocation(far);
  await m.removeLocation("far");
  expect((await m.locations()).sessions.far).toBeUndefined();
});

test("a location's folders are listed through its daemon, and a path that is not a folder is refused", async () => {
  const { manager } = await setup();
  const { m, events } = await manager();
  await m.connect("local");
  expect(of(events, "location-status").at(-1)?.capabilities?.folders).toBe(true);
  await mkdir(join(dir, "daemon", "wanted", "inner"), { recursive: true });
  const listed = await m.listFolders("local", join(dir, "daemon", "wanted"));
  expect(listed.folders).toEqual([{ name: "inner" }]);
  await expect(m.listFolders("local", "relative")).rejects.toThrow();
});

test("a session says when it last had something happen", async () => {
  const { manager } = await setup();
  const { m } = await manager();
  await m.connect("local");
  await said(m, await m.createSession("local", { cwd: "/tmp" }));
  const [session] = await m.sessions("local");
  expect(Number.isNaN(Date.parse(session?.updatedAt ?? ""))).toBe(false);
});

// ---- what is reported about use (docs/analytics.md): how it is used, never what is said ----

test("a session of one of our agents is reported under that agent's name, not as other (CYCL-155)", async () => {
  const fake = fakeAgent();
  fake.definition.id = "codex";
  const { manager } = await setup(fake);
  const reported: [string, unknown][] = [];
  const { m } = await manager("app", undefined, undefined, (name, props) =>
    reported.push([name, props]),
  );
  await m.connect("local");
  const id = await m.createSession("local", { cwd: dir, agent: "codex" });
  await m.openSession("local", id);
  await m.prompt("local", id, [{ type: "text", text: "hi" }]);
  const agents = (name: string) =>
    reported.filter(([n]) => n === name).map(([, p]) => (p as { agent?: string }).agent);
  expect(agents("session_created")).toEqual(["codex"]);
  expect(agents("session_opened")).toEqual(["codex"]);
  expect(agents("prompt_sent")).toEqual(["codex"]);
});

test("session/new returning -32000 reports agent_auth_required without leaking error text (CYCL-172)", async () => {
  const secretPath = "/Users/me/super-secret-token-path";
  const fake = fakeAgent({
    onNew: async () => {
      const error = Object.assign(new Error(`Authentication required at ${secretPath}`), {
        code: -32000,
      });
      throw error;
    },
  });
  fake.definition.id = "agy";
  const { manager } = await setup(fake);
  const reported: [string, unknown][] = [];
  const { m } = await manager("app", undefined, undefined, (name, props) =>
    reported.push([name, props]),
  );
  await m.connect("local");
  let caught: unknown;
  try {
    await m.createSession("local", { cwd: dir, agent: "agy" });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as { code?: number }).code).toBe(-32000);
  expect(reported.filter(([n]) => n === "agent_auth_required")).toEqual([
    ["agent_auth_required", { agent: "agy", location: "local" }],
  ]);
  expect(JSON.stringify(reported)).not.toContain(secretPath);
});

test("what a person does is reported as counts and words, and never as what they wrote", async () => {
  const secret = "my password is hunter2 and the repo is /home/me/secret-project";
  const fake = fakeAgent(
    {
      onPrompt: async ({ ask }) => {
        await ask();
      },
    },
    { promptCapabilities: { image: {}, embeddedContext: {} } },
  );
  const { manager } = await setup(fake);
  const reported: [string, unknown][] = [];
  const { m, events } = await manager("app", undefined, undefined, (name, props) =>
    reported.push([name, props]),
  );
  await m.connect("local");
  const cwd = join(dir, "secret-project");
  await mkdir(cwd);
  const id = await m.createSession("local", { cwd, config: { mode: "plan" } });
  await m.openSession("local", id);
  await m.prompt("local", id, [
    { type: "text", text: secret },
    { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    {
      type: "resource",
      resource: { uri: "attachment:///Nightshade.txt", mimeType: "text/plain", text: secret },
    },
    { type: "resource_link", name: "secret.ts", uri: "file:///home/me/secret-project/secret.ts" },
  ]);
  await until(() => of(events, "permission").length === 1, "the request");
  await m.answerPermission(first(of(events, "permission")).request.key, "allow");
  await m.setSessionConfig("local", id, "mode", "default");
  await m.setSessionConfig("local", id, "effort", "high");
  await m.renameSession("local", id, "Project Nightshade", "sidebar");
  await m.archiveSession("local", id, true);
  await m.setAgentDefaults("local", "fake", { mode: "plan" });
  await m.deleteSession("local", id);

  const named = (name: string) => reported.filter(([n]) => n === name).map(([, p]) => p);
  expect(named("location_connection")).toEqual([{ kind: "local", state: "connected" }]);
  expect(named("session_list_loaded")).toEqual([{ pages: 1 }]);
  expect(named("session_created")).toEqual([
    { agent: "other", location: "local", configured: true, worktree: false },
  ]);
  expect(named("session_opened")).toEqual([{ agent: "other", location: "local" }]);
  expect(named("prompt_sent")).toEqual([
    {
      agent: "other",
      location: "local",
      size: "short",
      images: 1,
      files: 1,
      mentions: 1,
      steered: false,
      via: "other",
    },
  ]);
  expect(named("permission_answered")).toEqual([
    { outcome: "allowed", remembered: false, queued: 0 },
  ]);
  expect(named("session_config_changed")).toEqual([{ setting: "mode" }, { setting: "effort" }]);
  expect(named("session_renamed")).toEqual([{ where: "sidebar" }]);
  expect(named("session_archived")).toEqual([{ archived: true }]);
  expect(named("agent_defaults_saved")).toEqual([{ agent: "other" }]);
  expect(named("session_deleted")).toEqual([{}]);

  // Whatever was said, wherever it is: nothing of it is in what was reported.
  const everything = JSON.stringify(reported);
  for (const content of ["hunter2", "secret-project", "secret.ts", "Nightshade", id, "fake"])
    expect(everything).not.toContain(content);
});

test("what sent a message is reported as one of its words, and a word main does not know as other", async () => {
  const { manager } = await setup();
  const reported: [string, unknown][] = [];
  const { m } = await manager("app", undefined, undefined, (name, props) =>
    reported.push([name, props]),
  );
  await m.connect("local");
  const vias: unknown[] = ["enter", "shortcut", "button", "voice"];
  for (const via of vias) {
    // A session each: the fake agent's turn would still be running for a second prompt.
    const id = await m.createSession("local", { cwd: "/tmp" });
    await m.openSession("local", id);
    await m.prompt("local", id, "hello", { via });
  }
  const sent = reported
    .filter(([n]) => n === "prompt_sent")
    .map(([, p]) => (p as { via: string }).via);
  expect(sent).toEqual(["enter", "shortcut", "button", "other"]);
  expect(JSON.stringify(reported)).not.toContain("voice");
});

test("a refused answer or a failing call reports nothing", async () => {
  const { manager } = await setup();
  const reported: string[] = [];
  const { m } = await manager("app", undefined, undefined, (name) => void reported.push(name));
  await m.connect("local");
  await expect(m.renameSession("local", "no-such-session", "x")).rejects.toThrow();
  await expect(
    m.saveLocation({
      id: "x",
      name: "x",
      kind: "remote",
      transport: { type: "ssh", host: "-oProxyCommand=x" },
    }),
  ).rejects.toThrow();
  expect(reported).toEqual(["location_connection", "session_list_loaded"]);
});

test("a host that cannot be reached is reported as closed, and a removed one by its kind", async () => {
  const { manager, held } = await setup();
  const reported: [string, unknown][] = [];
  const { m } = await manager("away", undefined, undefined, (name, props) =>
    reported.push([name, props]),
  );
  held.add("away");
  await expect(m.connect("local")).rejects.toThrow();
  expect(reported).toEqual([["location_connection", { kind: "local", state: "closed" }]]);
  const far: LocationConfig = {
    id: "far",
    name: "Far",
    kind: "remote",
    transport: { type: "ssh", host: "far" },
  };
  await m.saveLocation(far);
  await m.removeLocation("far");
  expect(reported.slice(1)).toEqual([
    ["location_saved", { transport: "ssh" }],
    ["location_removed", { kind: "remote" }],
  ]);
});

test("what wants the person is reported even when nothing shows a notification", async () => {
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        await ask();
      },
    }),
  );
  const reported: [string, unknown][] = [];
  const { m, events } = await manager("app", undefined, undefined, (name, props) =>
    reported.push([name, props]),
  );
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, "ask");
  await until(() => of(events, "permission").length === 1, "the request");
  await m.answerPermission(first(of(events, "permission")).request.key, "allow");
  await until(
    () => reported.filter(([n]) => n === "session_attention").length === 2,
    "both reports",
  );
  expect(reported.filter(([n]) => n === "session_attention").map(([, p]) => p)).toEqual([
    { kind: "needs-you" },
    { kind: "finished" },
  ]);
});

test("an answer that is not one of the offered options is not counted as another kind", async () => {
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        await ask();
      },
    }),
  );
  const reported: [string, unknown][] = [];
  const { m, events } = await manager("app", undefined, undefined, (name, props) =>
    reported.push([name, props]),
  );
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, "ask");
  await until(() => of(events, "permission").length === 1, "the request");
  await m.answerPermission(first(of(events, "permission")).request.key, "not-an-option");
  expect(reported.filter(([n]) => n === "permission_answered")).toEqual([]);
});

test("two locations saved at once are both kept, and a save and a removal that overlap each take effect", async () => {
  const { manager } = await setup();
  const { m } = await manager("race");
  const remote = (id: string): LocationConfig => ({
    id,
    name: id,
    kind: "remote",
    transport: { type: "ssh", host: `me@${id}` },
  });
  await Promise.all([m.saveLocation(remote("a")), m.saveLocation(remote("b"))]);
  const ids = async () => (await m.locations()).locations.map((e) => e.id);
  expect(await ids()).toEqual(["local", "a", "b"]);
  await Promise.all([m.removeLocation("a"), m.saveLocation(remote("c"))]);
  expect(await ids()).toEqual(["local", "b", "c"]);
  // What is on disk is what is in memory.
  const again = new ConnectionManager({
    settings: fileSettings(join(dir, "settings-race.json")),
    channelFor: () => async () => {
      throw new Error("no");
    },
    emit: () => {},
  });
  await again.init();
  expect((await again.locations()).locations.map((e) => e.id)).toEqual(["local", "b", "c"]);
});

test("a request answered by another client while this one was offline is closed when it is back", async () => {
  const outcomes: unknown[] = [];
  const { manager, held, drop } = await setup(
    fakeAgent({
      onPrompt: async ({ ask }) => {
        outcomes.push(await ask());
      },
    }),
  );
  const mine = await manager("mine");
  const theirs = await manager("theirs");
  await mine.m.connect("local");
  await theirs.m.connect("local");
  const id = await mine.m.createSession("local", { cwd: "/tmp" });
  await mine.m.openSession("local", id);
  await mine.m.prompt("local", id, "ask");
  await until(() => of(mine.events, "permission").length === 1, "the request");
  const started = Date.now();
  while (!(await theirs.m.sessions("local")).some((s) => s.sessionId === id)) {
    if (Date.now() - started > 3_000) throw new Error("timed out waiting for the list");
    await Bun.sleep(10);
  }
  await theirs.m.openSession("local", id);
  await until(() => of(theirs.events, "permission").length === 1, "the other client to be asked");

  // This one cannot get back for now; the other one does, and is asked again, and answers.
  held.add("mine");
  drop();
  await until(
    () => of(mine.events, "location-status").some((e) => e.state === "reconnecting"),
    "the loss to be noticed",
  );
  await until(
    () => of(theirs.events, "location-status").at(-1)?.state === "connected",
    "the other client to be back",
  );
  const asked = of(theirs.events, "permission").at(-1)?.request;
  if (asked === undefined) throw new Error("the other client was not asked");
  await theirs.m.answerPermission(asked.key, "deny");
  await until(() => outcomes.length === 1, "the answer to reach the agent");

  held.delete("mine");
  await until(
    () => of(mine.events, "permission-closed").length === 1,
    "the card to be closed here",
    5_000,
  );
  expect((await mine.m.openSession("local", id)).permissions).toEqual([]);
});

test("a daemon that speaks another major version of the protocol is refused with which side has to change, and the refusal clears when it connects", async () => {
  const { manager } = await setup();
  const box: LocationConfig = {
    id: "box",
    name: "Box",
    kind: "remote",
    transport: { type: "ssh", host: "me@box" },
  };
  // An app from the future: the daemon is the older one, and it is on another machine, so its update is given.
  const future = await manager("future", "9.9.9", undefined, undefined, { protocolVersion: "1.0" });
  await future.m.saveLocation(box);
  await expect(future.m.connect("box")).rejects.toThrow(/protocol/);
  const refused = of(future.events, "location-status").at(-1);
  expect(refused).toMatchObject({
    locationId: "box",
    state: "closed",
    incompatible: { with: "daemon", supported: ["0.2"], requested: "1.0" },
  });
  expect(refused?.incompatible?.command).toContain("9.9.9");
  // A renderer that asks later is told the same.
  expect((await future.m.locations()).status.find((s) => s.locationId === "box")).toMatchObject({
    incompatible: { with: "daemon" },
  });

  // An app from the past, which a daemon that speaks a newer protocol refuses: the app is what to update, and the
  // daemon is not offered a downgrade.
  const past = await manager("past", "0.0.1", undefined, undefined, { protocolVersion: "-1.0" });
  await past.m.saveLocation(box);
  await expect(past.m.connect("box")).rejects.toThrow();
  const newer = of(past.events, "location-status").at(-1);
  expect(newer?.incompatible).toEqual({ with: "app", supported: ["0.2"], requested: "-1.0" });

  // The local daemon is not one the app can update by command.
  await expect(future.m.connect("local")).rejects.toThrow();
  expect(of(future.events, "location-status").at(-1)?.incompatible).toEqual({
    with: "daemon",
    supported: ["0.2"],
    requested: "1.0",
  });

  // Right again: it connects, and nothing is said of the old refusal.
  const fixed = await manager("fixed", "9.9.9");
  await fixed.m.saveLocation(box);
  await fixed.m.connect("box");
  const status = (await fixed.m.locations()).status.find((s) => s.locationId === "box");
  expect(status?.state).toBe("connected");
  expect(status?.incompatible).toBeUndefined();
});

test("an agent's form reaches the page, the answer goes back checked, and only what was done with it is reported", async () => {
  let answered: unknown;
  const fake = fakeAgent({
    onPrompt: async ({ elicit }) => {
      answered = await elicit();
    },
  });
  const { manager } = await setup(fake);
  const reported: [string, unknown][] = [];
  const { m, events } = await manager("app", undefined, undefined, (name, props) =>
    reported.push([name, props]),
  );
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await m.openSession("local", id);
  await m.prompt("local", id, [{ type: "text", text: "go" }]);
  await until(() => of(events, "permission").length === 1, "the form");
  const { request } = first(of(events, "permission"));
  expect(request.form).toEqual({
    message: "Which one?",
    schema: { type: "object", properties: { pick: { type: "string" } } },
  });
  // What the page sends is checked: only text, numbers, yes/no and lists of text go on.
  await m.answerForm(request.key, {
    action: "accept",
    content: { pick: "secret choice", sneaky: { nested: true } },
  });
  await until(() => answered !== undefined, "the agent's answer");
  expect(answered).toMatchObject({ action: "accept", content: { pick: "secret choice" } });
  expect(JSON.stringify(answered)).not.toContain("nested");
  expect(of(events, "permission-closed").map((e) => e.key)).toEqual([request.key]);
  expect(reported.filter(([n]) => n === "form_answered")).toEqual([
    ["form_answered", { outcome: "answered" }],
  ]);
  expect(JSON.stringify(reported)).not.toContain("secret choice");
});

test("a form's answer that is not one is a dismissal", () => {
  expect(formAnswerOf(undefined)).toEqual({ action: "cancel" });
  expect(formAnswerOf({ action: "decline", content: { a: "b" } })).toEqual({ action: "decline" });
  expect(formAnswerOf({ action: "accept", content: { n: Number.NaN, list: ["a", 1] } })).toEqual({
    action: "accept",
    content: {},
  });
  // Only the fields the form asked for.
  expect(
    formAnswerOf({ action: "accept", content: { pick: "a", injected: "b" } }, new Set(["pick"])),
  ).toEqual({ action: "accept", content: { pick: "a" } });
});

test("two attached desktop windows restore one draft, and an unacknowledged return survives the recipient disconnecting", async () => {
  const { manager } = await setup(fakeAgent({ onPrompt: ({ cancelled }) => cancelled }));
  const window = async (name: string) => {
    const ipc = fakeBridge();
    const receipts: unknown[] = [];
    const { m } = await manager(
      name,
      undefined,
      undefined,
      (event, props) => {
        if (event === "queue_return_restored") receipts.push(props);
      },
      { emit: ipc.emit },
    );
    await m.connect("local");
    const acknowledged: string[] = [];
    const store = new AppStore({
      ...ipc.bridge,
      locations: () => m.locations(),
      openSession: (env, id) => m.openSession(env, id),
      ackReturn: async (env, id, batch) => {
        await m.ackReturn(env, id, batch);
        acknowledged.push(batch);
      },
    });
    await store.start();
    return { m, store, acknowledged, receipts };
  };
  const a = await window("first");
  const id = await a.m.createSession("local", { cwd: dir });
  await a.store.selectSession("local", id);
  await said(a.m, id, "working");
  const b = await window("second");
  await b.store.selectSession("local", id);
  await b.m.prompt("local", id, "from second");
  await a.m.cancel("local", id);
  await until(() => a.acknowledged.length === 1, "the first window to save its draft");
  const key = viewKey("local", id);
  expect(a.store.drafts.get(key).text).toBe("from second");
  expect(b.store.drafts.get(key).text).toBe("");

  // The first renderer disappears while its main process is still attached.
  a.store.stop();
  await b.m.prompt("local", id, "working again");
  await b.m.prompt("local", id, "recover this");
  await b.m.cancel("local", id);
  const deadline = Date.now() + 3000;
  while (
    (await a.m.openSession("local", id)).conversation.returned?.prompts[0]?.prompt[0]?.text !==
    "recover this"
  ) {
    if (Date.now() > deadline) throw new Error("the return never reached the first main process");
    await Bun.sleep(5);
  }
  expect(b.store.drafts.get(key).text).toBe("");
  await a.m.close();
  await until(() => b.acknowledged.length === 1, "the surviving renderer to acknowledge");
  expect(b.store.drafts.get(key).text).toBe("recover this");
  expect(a.store.drafts.get(key).text).toBe("from second");
  expect(a.receipts).toEqual([{}]);
  expect(b.receipts).toEqual([{}]);
  b.store.stop();
});

test("marking unknown background tasks as ended reports only the count and preserves running tasks", async () => {
  const { manager } = await setup(
    fakeAgent({
      onPrompt: async ({ say }) => {
        for (const id of ["private-task", "still-working"])
          await say({
            sessionUpdate: "subagent_update",
            sessionId: id,
            state: { state: "running" },
            _meta: { "cycle/subagent": { background: true, toolCallId: id } },
          });
        await say({
          sessionUpdate: "subagent_update",
          sessionId: "private-task",
          _meta: { "cycle/subagent": { status: "unknown", toolCallId: "private-task" } },
        });
      },
    }),
  );
  const reported: unknown[] = [];
  const { m } = await manager("app", undefined, undefined, (name, props) => {
    if (name === "background_dismissed") reported.push(props);
  });
  await m.connect("local");
  const id = await m.createSession("local", { cwd: dir });
  await said(m, id);
  const deadline = Date.now() + 2000;
  while (!first(await m.sessions("local")).unknownBackground) {
    if (Date.now() > deadline) throw new Error("the missing background task was never reconciled");
    await Bun.sleep(5);
  }
  const before = first(await m.sessions("local"));
  expect(before.unknownBackground).toEqual(["private-task"]);
  expect(before.background).toBe(1);
  await m.dismissBackground("local", id, ["private-task", "still-working"]);
  await m.dismissBackground("local", id, ["private-task"]);
  expect(first(await m.sessions("local")).unknownBackground).toBeUndefined();
  expect(first(await m.sessions("local")).background).toBe(1);
  expect(reported).toEqual([{ count: 1 }]);
});

test("stopping one sub-agent is counted when the daemon takes it, with whether it ran in the background and nothing of it", async () => {
  const { manager, fake } = await setup(
    fakeAgent({
      onPrompt: async ({ say }) => {
        await say({
          sessionUpdate: "subagent_update",
          sessionId: "task-private",
          state: { state: "running" },
          capabilities: { cancel: {} },
          _meta: { "cycle/subagent": { toolCallId: "call-private", background: true } },
        });
      },
    }),
  );
  const tracked: [string, unknown][] = [];
  const { m } = await manager("app", undefined, undefined, (name, props) => {
    if (name === "subagent_stopped") tracked.push([name, props]);
  });
  await m.connect("local");
  const id = await m.createSession("local", { cwd: "/tmp" });
  await said(m, id);
  expect(await m.stopSubagent("local", id, "task-private", true)).toBe(true);
  // One that is not there: nothing is stopped, nothing counted, and the page is told so.
  expect(await m.stopSubagent("local", id, "task-gone", false)).toBe(false);
  expect(tracked).toEqual([["subagent_stopped", { background: true }]]);
  expect(JSON.stringify(tracked)).not.toContain("private");
  await until(() => fake.log.childCancels.length > 0, "the agent to be told");
  expect(fake.log.childCancels).toEqual(["task-private"]);
});

test("saving runtime settings reports behavioral analytics without config values, handles conflicts, and forwards setup-changed events", async () => {
  const fake = fakeAgent();
  const runtimeSchema = {
    warmStart: { type: "boolean" as const, title: "Warm start", default: true },
    skipPermissions: {
      type: "boolean" as const,
      title: "Skip all permission prompts",
      default: false,
    },
    secretLabel: {
      type: "string" as const,
      title: "Mode",
      oneOf: [
        { const: "alpha-secret-val", title: "Alpha" },
        { const: "beta-secret-val", title: "Beta" },
      ],
      default: "alpha-secret-val",
    },
  };
  const agent: Parameters<typeof Daemon.start>[0]["agents"][number] = {
    ...fake.definition,
    id: "claude",
    name: "Claude",
    setup: {
      probeBinary: async () => ({
        source: "path" as const,
        path: "/usr/bin/claude",
        version: "2.1.0",
      }),
      readAuth: async () => ({ state: "signed_in" as const, method: "subscription" as const }),
      signInModes: () => [],
      canSignOut: () => false,
      canRefreshUsage: false,
      loginCommand: "cycle login claude",
      diagnostics: () => ({
        dataDir: join(dir, "claude"),
        customDataDir: false,
        allowEnv: [],
        envNames: [],
      }),
      runtimeSchema,
      runtimeSnapshot: (settings) => {
        const defaults = {
          warmStart: true,
          skipPermissions: false,
          secretLabel: "alpha-secret-val",
        };
        const eff = settings?.effective("claude", defaults, {}) ?? {
          values: defaults,
          overrides: [],
          revision: 0,
        };
        return {
          schemaVersion: 1 as const,
          schema: { type: "object" as const, properties: runtimeSchema },
          ...eff,
        };
      },
    },
  };
  const daemon = await Daemon.start({
    dataDir: join(dir, "daemon"),
    agents: [agent],
  });
  const socket = join(dir, "rt.sock");
  const server = await listenUnix({
    path: socket,
    onConnection: ({ stream }) => void daemon.accept(stream),
  });
  cleanup.push(async () => {
    server.close();
    await daemon.close();
  });

  const tracked: [string, unknown][] = [];
  const eventsA: AppEvent[] = [];
  const eventsB: AppEvent[] = [];
  const makeManager = async (name: string, bucket: AppEvent[], track?: Tracker) => {
    const m = new ConnectionManager({
      settings: fileSettings(join(dir, `settings-${name}.json`)),
      channelFor: () => async () => connectUnix(socket),
      emit: (event) => bucket.push(event),
      backoff: { first: 10, max: 50 },
      ...(track !== undefined ? { track } : {}),
    });
    await m.init();
    cleanup.push(() => m.close());
    await m.connect("local");
    return m;
  };

  const mA = await makeManager("a", eventsA, (name, props) => {
    if (name === "agent_runtime_settings_saved") tracked.push([name, props]);
  });
  const mB = await makeManager("b", eventsB);

  const initial = await mA.readAgentSetup("local", "claude");
  expect(initial.runtime.revision).toBe(0);

  const saved = await mA.setAgentRuntimeSettings(
    "local",
    "claude",
    { warmStart: false, secretLabel: "beta-secret-val" },
    0,
  );
  expect(saved).toEqual({
    saved: true,
    values: { warmStart: false, skipPermissions: false, secretLabel: "beta-secret-val" },
    overrides: ["secretLabel", "warmStart"],
    revision: 1,
  });

  // Other connected manager receives `_cycle/agent_setup_changed`.
  await until(
    () => of(eventsB, "agent-setup-changed").some((e) => e.agent === "claude" && e.revision === 1),
    "agent-setup-changed event on peer manager",
  );

  // Stale expectedRevision returns structured revision_conflict without emitting analytics.
  const conflict = await mB.setAgentRuntimeSettings("local", "claude", { warmStart: true }, 0);
  expect(conflict).toMatchObject({
    saved: false,
    problem: "revision_conflict",
    currentRevision: 1,
  });

  // The one switch that is counted: whether the save turned skipping every permission prompt on or off.
  const skipping = await mA.setAgentRuntimeSettings(
    "local",
    "claude",
    { skipPermissions: true },
    1,
  );
  expect(skipping).toMatchObject({ saved: true });

  // Behavioral analytics only: agent + location kind, zero field names or values but that one.
  expect(tracked).toEqual([
    [
      "agent_runtime_settings_saved",
      { agent: "claude", location: "local", skip_permissions: false },
    ],
    [
      "agent_runtime_settings_saved",
      { agent: "claude", location: "local", skip_permissions: true },
    ],
  ]);
  expect(JSON.stringify(tracked)).not.toContain("secret");
  expect(JSON.stringify(tracked)).not.toContain("warmStart");
  expect(JSON.stringify(tracked)).not.toContain("beta");
});

test("ConnectionManager validates auth URLs against hardcoded allowlist, never silently opens browser, handles disconnect, and tracks behavioral-only analytics", async () => {
  const fake = fakeAgent();
  let nextUrl = "https://evil.phishing.test/oauth?secret=bad";
  let nextVerifyUrl: string | undefined;
  let cancels = 0;
  let finishFlow: ((outcome: { ok: true } | { ok: false; reason: "expired" }) => void) | undefined;

  const agent: Parameters<typeof Daemon.start>[0]["agents"][number] = {
    ...fake.definition,
    id: "claude",
    name: "Claude",
    setup: {
      probeBinary: () => ({ source: "path", path: "/usr/bin/claude", version: "2.1.0" }),
      readAuth: async () => ({ state: "signed_out", method: "none" }),
      signInModes: () => [{ mode: "code", requiresLocalLoopback: false }],
      canSignOut: () => true,
      canRefreshUsage: false,
      loginCommand: "cycle login claude",
      diagnostics: () => ({
        dataDir: join(dir, "claude"),
        customDataDir: false,
        allowEnv: [],
        envNames: [],
      }),
      runtimeSnapshot: () => ({
        schemaVersion: 1,
        schema: { type: "object", properties: {} },
        values: {},
        overrides: [],
        revision: 0,
      }),
      authDriver: {
        start: async () => {
          const completed = new Promise<{ ok: true } | { ok: false; reason: "expired" }>(
            (resolve) => {
              finishFlow = resolve;
            },
          );
          return {
            authorizationUrl: nextUrl,
            ...(nextVerifyUrl !== undefined ? { verificationUrl: nextVerifyUrl } : {}),
            completed,
            submit: async () => ({ ok: true }),
            cancel: () => {
              cancels++;
            },
          };
        },
        logout: async () => {},
      },
    },
  };

  const daemon = await Daemon.start({ dataDir: join(dir, "daemon-auth"), agents: [agent] });
  const socket = join(dir, "auth.sock");
  const server = await listenUnix({
    path: socket,
    onConnection: ({ stream }) => void daemon.accept(stream),
  });
  cleanup.push(async () => {
    server.close();
    await daemon.close();
  });

  const openedUrls: string[] = [];
  const tracked: [string, unknown][] = [];
  const events: AppEvent[] = [];
  const channels: Channel[] = [];
  const m = new ConnectionManager({
    settings: fileSettings(join(dir, "settings-auth.json")),
    channelFor: () => async () => {
      const ch = await connectUnix(socket);
      channels.push(ch);
      return ch;
    },
    emit: (event) => events.push(event),
    openBrowser: async (url) => {
      openedUrls.push(url);
    },
    track: (name, props) => {
      if (
        name === "agent_auth_started" ||
        name === "agent_auth_completed" ||
        name === "agent_signed_out"
      ) {
        tracked.push([name, props]);
      }
    },
    backoff: { first: 10, max: 50 },
  });
  await m.init();
  cleanup.push(() => m.close());
  await m.connect("local");

  // 1. Untrusted authorizationUrl is blocked, daemon flow cancelled, openBrowser never called.
  const blocked = await m.startAgentAuth("local", "claude");
  expect(blocked).toEqual({ started: false, reason: "untrusted_url" });
  await until(() => cancels === 1, "untrusted flow cancelled on daemon");
  expect(openedUrls).toEqual([]);

  // 2. Valid authorizationUrl + untrusted verificationUrl is ALSO blocked!
  nextUrl = "https://claude.ai/oauth/authorize?state=ok";
  nextVerifyUrl = "https://evil.example/device";
  const blockedVerify = await m.startAgentAuth("local", "claude");
  expect(blockedVerify).toEqual({ started: false, reason: "untrusted_url" });
  await until(() => cancels === 2, "untrusted verificationUrl flow cancelled");
  expect(openedUrls).toEqual([]);

  // 3. Trusted URL starts cleanly WITHOUT silently calling openBrowser; explicit click opens it.
  nextVerifyUrl = undefined;
  const started = await m.startAgentAuth("local", "claude");
  expect(started).toMatchObject({
    started: true,
    mode: "code",
    host: "claude.ai",
    hasUrl: true,
  });
  expect(openedUrls).toEqual([]);
  if (!started.started) throw new Error("expected started");

  expect(await m.openAgentAuthUrl("local", started.flowId)).toBe(true);
  expect(openedUrls).toEqual(["https://claude.ai/oauth/authorize?state=ok"]);

  const secretCode = "SUPER-SECRET-AUTH-CODE-777";
  expect(await m.submitAgentAuth("local", started.flowId, secretCode)).toEqual({ ok: true });
  finishFlow?.({ ok: true });
  await until(
    () => of(events, "agent-auth-completed").some((e) => e.flowId === started.flowId && e.ok),
    "agent-auth-completed event",
  );

  // 4. Disconnect mid-flow emits disconnected completion event + analytics.
  const started2 = await m.startAgentAuth("local", "claude");
  if (!started2.started) throw new Error("expected started2");
  for (const ch of channels.splice(0)) ch.close();
  await until(
    () =>
      of(events, "agent-auth-completed").some(
        (e) => e.flowId === started2.flowId && e.reason === "disconnected",
      ),
    "disconnected auth event",
  );

  // Wait for reconnect and test Sign out analytics.
  await until(
    () => of(events, "location-status").at(-1)?.state === "connected",
    "manager reconnected",
  );
  expect(await m.logoutAgent("local", "claude")).toEqual({ ok: true });

  // Verify behavioral-only analytics: zero codes, URLs, accounts, or error strings.
  // A start the desktop refused (an untrusted URL) is still a start: every completion has one before it.
  expect(tracked).toEqual([
    ["agent_auth_started", { agent: "claude", location: "local", mode: "code" }],
    ["agent_auth_completed", { agent: "claude", location: "local", result: "failed" }],
    ["agent_auth_started", { agent: "claude", location: "local", mode: "code" }],
    ["agent_auth_completed", { agent: "claude", location: "local", result: "failed" }],
    ["agent_auth_started", { agent: "claude", location: "local", mode: "code" }],
    ["agent_auth_completed", { agent: "claude", location: "local", result: "ok" }],
    ["agent_auth_started", { agent: "claude", location: "local", mode: "code" }],
    ["agent_auth_completed", { agent: "claude", location: "local", result: "disconnected" }],
    ["agent_signed_out", { agent: "claude", location: "local", ok: true }],
  ]);
  const serialized = JSON.stringify(tracked);
  expect(serialized).not.toContain(secretCode);
  expect(serialized).not.toContain("claude.ai");
  expect(serialized).not.toContain("phishing");
});

// ---- environments (docs/desktop.md "环境") ----

test("a session made with an environment is sent it whole, lists it by names only, and runs its actions", async () => {
  const { manager } = await setup();
  const reports: [string, unknown][] = [];
  const { m } = await manager("env", undefined, undefined, (name, props) => {
    reports.push([name, props]);
  });
  await m.connect("local");
  const saved = await m.saveEnvironment({
    id: "env-node",
    name: "Node",
    variables: [{ name: "DATABASE_URL", value: "postgres://secret@db/dev" }],
    actions: [{ id: "hello", name: "Say hello", command: { default: "echo hello" } }],
  });
  expect("state" in saved).toBe(true);
  expect(await m.createSession("local", { cwd: "/tmp", environmentId: "env-gone" })).toEqual({
    problem: { reason: "missing" },
  });
  const made = await m.createSession("local", { cwd: "/tmp", environmentId: "env-node" });
  if (typeof made !== "string") throw new Error("the session was not made");
  const id = made;
  await said(m, id);
  const row = (await m.sessions("local")).find((s) => s.sessionId === id);
  expect(row?.environment).toEqual({
    id: "env-node",
    name: "Node",
    variableNames: ["DATABASE_URL"],
    actions: [{ id: "hello", name: "Say hello" }],
  });
  expect(JSON.stringify(row)).not.toContain("secret");

  const unknown = await m.createTerminal("local", id, 80, 24, "nope");
  expect(unknown).toEqual({ problem: "unknown_action" });
  expect(reports.some(([name]) => name === "environment_action_run")).toBe(false);
  const ran = await m.createTerminal("local", id, 80, 24, "hello");
  expect("terminal" in ran).toBe(true);
  if ("terminal" in ran) await m.closeTerminal("local", ran.terminal.terminalId);
  expect(reports.filter(([name]) => name === "environment_action_run")).toEqual([
    ["environment_action_run", {}],
  ]);
  // Nothing of what the environment holds is in any report.
  const reported = JSON.stringify(reports);
  for (const text of ["Node", "DATABASE_URL", "secret", "echo", "hello"])
    expect(reported).not.toContain(text);
});

test("the daemon's refusal of an environment reaches the page as its reason and the variable's name", () => {
  const refusal = (data: object) =>
    environmentRefusalOf(Object.assign(new Error("refused"), { code: -32602, data }));
  expect(refusal({ reason: "reserved_variable", name: "PATH" })).toEqual({
    reason: "reserved_variable",
    name: "PATH",
  });
  expect(refusal({ reason: "too_large", limit: 65536 })).toEqual({ reason: "too_large" });
  expect(refusal({ reason: "something" })).toBeUndefined();
  // Only main says an environment is missing: a daemon that said so would be saying something else.
  expect(refusal({ reason: "missing" })).toBeUndefined();
  expect(
    environmentRefusalOf(
      Object.assign(new Error("x"), { code: -32000, data: { reason: "too_large" } }),
    ),
  ).toBeUndefined();
});

test("an environment in the file that the daemon would refuse is not sent: main says it is to fix", async () => {
  const { manager } = await setup();
  const environments = memoryEnvironments({
    environments: [
      {
        id: "env-twice",
        name: "Twice",
        variables: [],
        actions: [
          { id: "a", name: "One", command: { default: "true" } },
          { id: "a", name: "Two", command: { default: "true" } },
        ],
      },
    ],
    defaults: {},
  });
  const { m } = await manager("broken", undefined, undefined, undefined, { environments });
  await m.connect("local");
  expect(await m.createSession("local", { cwd: "/tmp", environmentId: "env-twice" })).toEqual({
    problem: { reason: "needs_fix", name: "Twice" },
  });
});

test("a session is made in a worktree from the chosen branch, listed under its main checkout, and deleting it asks before dropping unsaved work", async () => {
  const { manager } = await setup();
  const { m } = await manager();
  await m.connect("local");
  // Git names folders by their real path (/tmp is /private/tmp on macOS).
  const repo = join(await realpath(dir), "repo");
  await mkdir(repo);
  const git = async (cwd: string, ...args: string[]) => {
    const child = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "ignore",
      stderr: "ignore",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    await child.exited;
  };
  await git(repo, "init", "-q", "-b", "main");
  await Bun.write(join(repo, "a.txt"), "a");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "first");
  await git(repo, "branch", "topic");

  // No repository: no branches to offer.
  expect(await m.gitBranches("local", dir)).toBeNull();
  const found = await m.gitBranches("local", repo);
  expect(found?.branches.sort()).toEqual(["main", "topic"]);

  const made = await m.createSession("local", { cwd: repo, worktree: { base: "topic" } });
  if (typeof made !== "string") throw new Error("the session was not made");
  await said(m, made);
  const listed = (await m.sessions("local")).find((s) => s.sessionId === made);
  expect(listed?.worktree).toMatchObject({ root: repo, managed: true });
  expect(listed?.cwd).toBe(listed?.worktree?.path);
  const tree = listed?.worktree?.path ?? "";
  await Bun.write(join(tree, "unsaved.txt"), "x");

  // Refused, with what would be lost; nothing is deleted.
  const refused = await m.deleteSession("local", made);
  expect(refused?.unsaved.files).toEqual(["unsaved.txt"]);
  expect((await m.sessions("local")).some((s) => s.sessionId === made)).toBe(true);
  // Said to discard: both go.
  expect(await m.deleteSession("local", made, true)).toBeUndefined();
  expect(await Bun.file(join(tree, "unsaved.txt")).exists()).toBe(false);

  // Not in a repository: the daemon refuses, as a word the page has a sentence for.
  const outside: unknown = await m.createSession("local", { cwd: dir, worktree: {} });
  expect(outside).toEqual({ problem: { reason: "not_a_repository" } });
});

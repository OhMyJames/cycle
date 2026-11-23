import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectUnix } from "@cycle/client";
import { Daemon, listenUnix, type PluginProvider, type ProviderPlugin } from "@cycle/daemon";
import type { AppEvent } from "@cycle/ui";
import { fakeAgent } from "../../daemon/test/fake-agent.ts";
import { ConnectionManager } from "../src/main/manager.ts";
import { fileSettings } from "../src/main/settings.ts";

/**
 * Plugins as the page reaches them (docs/protocol.md §15, CYCL-84): through main, against a real daemon whose agent's
 * plugin machinery is a list in memory. What is reported is the action and how it ended, never a plugin's name.
 */

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

const until = async (condition: () => boolean, what: string, ms = 2_000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

const DIRECTORY: ProviderPlugin[] = [
  {
    id: "secret-tracker@house",
    name: "secret-tracker",
    description: "Issues",
    sourceId: "house",
    installed: false,
    servers: [{ name: "api", agentName: "plugin:secret-tracker:api" }],
  },
];

const provider = () => {
  const installed = new Map<string, ProviderPlugin>();
  const control = { fail: undefined as { reason: string; detail: string } | undefined };
  const act = () => {
    if (control.fail !== undefined) throw Object.assign(new Error("no"), control.fail);
  };
  const sources = [{ id: "house", name: "house", kind: "builtin" as const, removable: false }];
  const plugins: PluginProvider = {
    snapshot: async () => ({
      sources: [...sources],
      installed: [...installed.values()],
      available: DIRECTORY.map((p) => installed.get(p.id) ?? p),
    }),
    install: async (id) => {
      act();
      const plugin = DIRECTORY.find((p) => p.id === id);
      if (plugin === undefined) throw Object.assign(new Error("no"), { reason: "not_found" });
      installed.set(id, { ...plugin, installed: true, enabled: true, scope: "user" });
    },
    uninstall: async (id) => {
      act();
      installed.delete(id);
    },
    update: async () => {
      act();
      return { updated: true };
    },
    setEnabled: async (id, enabled) => {
      act();
      const plugin = installed.get(id);
      if (plugin !== undefined) installed.set(id, { ...plugin, enabled });
    },
    addSource: async () => {
      act();
      sources.push({ id: "team", name: "team", kind: "git" as never, removable: true as never });
      return "team";
    },
    removeSource: async () => act(),
    refreshSource: async () => act(),
  };
  return { plugins, control };
};

const setup = async () => {
  const fake = fakeAgent();
  const { plugins, control } = provider();
  const daemon = await Daemon.start({
    dataDir: join(dir, "daemon"),
    agents: [{ ...fake.definition, plugins }],
  });
  const socket = join(dir, "d.sock");
  const server = await listenUnix({
    path: socket,
    onConnection: ({ stream }) => void daemon.accept(stream),
  });
  const events: AppEvent[] = [];
  const tracked: [string, object][] = [];
  const m = new ConnectionManager({
    settings: fileSettings(join(dir, "settings.json")),
    channelFor: () => () => connectUnix(socket),
    emit: (event) => events.push(event),
    track: (name, props) => {
      if (name.startsWith("plugin_")) tracked.push([name, props]);
    },
  });
  await m.init();
  cleanup.push(async () => {
    await m.close();
    server.close();
    await daemon.close();
  });
  await m.connect("local");
  return { m, events, tracked, control };
};

test("the agents with plugins reach the page, and a change becomes an event", async () => {
  const { m, events } = await setup();
  const status = events.filter((e) => e.type === "environment-status").at(-1);
  expect(status).toMatchObject({ state: "connected", capabilities: { plugins: ["fake"] } });

  const listed = await m.listPlugins("local", "fake");
  expect(listed.plugins).toEqual([]);
  expect(listed.sources.map((s) => s.id)).toEqual(["house"]);
  const available = await m.availablePlugins("local", { agentId: "fake", query: "issues" });
  expect(available).toMatchObject({ total: 1, plugins: [{ id: "secret-tracker@house" }] });

  await m.installPlugin("local", "fake", "secret-tracker@house");
  await until(() => events.some((e) => e.type === "plugins"), "the change to reach the page");
  expect(events.find((e) => e.type === "plugins")).toEqual({
    type: "plugins",
    environmentId: "local",
    agentId: "fake",
  });
});

test("each action is reported by what it was and how it ended, never by a name, a source or what the agent said", async () => {
  const { m, tracked, control } = await setup();
  const id = "secret-tracker@house";
  expect(await m.installPlugin("local", "fake", id)).toMatchObject({ plugin: { installed: true } });
  expect(await m.setPluginEnabled("local", "fake", id, false)).toMatchObject({
    plugin: { enabled: false },
  });
  expect(await m.updatePlugin("local", "fake", id)).toMatchObject({ updated: true });
  expect(await m.addPluginSource("local", "fake", "secret-owner/secret-repo")).toMatchObject({
    source: { id: "team" },
  });
  expect(await m.refreshPluginSources("local", "fake")).toEqual({ refreshed: true });
  expect(await m.removePluginSource("local", "fake", "team")).toEqual({ removed: true });
  expect(await m.uninstallPlugin("local", "fake", id)).toEqual({ removed: true });

  // What the agent's machinery refuses comes back as a word, with what it said for the person only.
  control.fail = { reason: "needs_command", detail: "secret-detail: run /opt/secret first" };
  expect(await m.installPlugin("local", "fake", id)).toEqual({
    problem: "needs_command",
    message: "secret-detail: run /opt/secret first",
  });
  // An agent that has none.
  expect(await m.installPlugin("local", "nobody", id)).toEqual({ problem: "unsupported" });

  expect(tracked).toEqual([
    ["plugin_installed", { agent: "other", result: "ok", servers: 1 }],
    ["plugin_toggled", { agent: "other", enabled: false, result: "ok" }],
    ["plugin_updated", { agent: "other", result: "ok", updated: true }],
    ["plugin_source_added", { agent: "other", result: "ok", kind: "git" }],
    ["plugin_sources_refreshed", { agent: "other", result: "ok" }],
    ["plugin_source_removed", { agent: "other", result: "ok" }],
    ["plugin_removed", { agent: "other", result: "ok" }],
    ["plugin_installed", { agent: "other", result: "needs_command", servers: 0 }],
    ["plugin_installed", { agent: "other", result: "unsupported", servers: 0 }],
  ]);
  expect(JSON.stringify(tracked)).not.toContain("secret");
});

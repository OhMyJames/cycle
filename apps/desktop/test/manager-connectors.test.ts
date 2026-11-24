import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectUnix } from "@cycle/client";
import type { AppEvent } from "@cycle/ui";
import { connectorsDaemon } from "../../../packages/client/test/fake-connectors-daemon.ts";
import { ConnectionManager } from "../src/main/manager.ts";
import { fileSettings } from "../src/main/settings.ts";

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

/** A browser that signs in at once: back to the callback with a code and the state the page was opened with. */
const signsIn = (answer: Record<string, string> = {}) => {
  const opened: string[] = [];
  return {
    opened,
    open: async (url: string) => {
      opened.push(url);
      const page = new URL(url);
      const back = new URL(page.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("state", page.searchParams.get("state") ?? "");
      if (answer.error === undefined) back.searchParams.set("code", "code-from-browser");
      for (const [key, value] of Object.entries(answer)) back.searchParams.set(key, value);
      await fetch(back);
    },
  };
};

const setup = async (open: (url: string) => Promise<void> = async () => {}) => {
  const daemon = await connectorsDaemon(dir);
  const events: AppEvent[] = [];
  const tracked: [string, object][] = [];
  const m = new ConnectionManager({
    settings: fileSettings(join(dir, "settings.json")),
    channelFor: () => () => connectUnix(daemon.socket),
    emit: (event) => events.push(event),
    // Only this feature's: the connection's own are another test's.
    track: (name, props) => {
      if (name.startsWith("connector_")) tracked.push([name, props]);
    },
    openBrowser: open,
    authTimeoutMs: 2_000,
  });
  await m.init();
  cleanup.push(async () => {
    await m.close();
    daemon.close();
  });
  await m.connect("local");
  return { daemon, m, events, tracked };
};

/** Nothing the person wrote (a name, a URL, a command, a secret) is in what is reported. */
const noContent = (tracked: [string, object][], words: string[]) => {
  const said = JSON.stringify(tracked);
  for (const word of words) expect(said).not.toContain(word);
};

test("the daemon's capability reaches the page, and its changes become events", async () => {
  const { m, events } = await setup();
  const status = events.filter((e) => e.type === "location-status").at(-1);
  expect(status).toMatchObject({ state: "connected", capabilities: { connectors: true } });
  await m.addConnector("local", {
    name: "docs",
    transport: { type: "http", url: "https://docs.example/mcp" },
    auth: { type: "none" },
  });
  await until(
    () => events.some((e) => e.type === "connectors" && e.locationId === "local"),
    "the connectors event",
  );
});

test("adding, changing and removing are reported as words and counts, never what was written", async () => {
  const { m, tracked, daemon } = await setup();
  const added = await m.addConnector("local", {
    name: "secret-name",
    transport: { type: "stdio", command: "/opt/secret-command", args: ["--secret-arg"] },
    auth: { type: "none" },
    secrets: { env: { SECRET_TOKEN: "sk-very-secret" } },
  });
  if (!("connector" in added)) throw new Error(`not added: ${JSON.stringify(added)}`);
  expect(daemon.secrets.get(added.connector.id)).toEqual({ SECRET_TOKEN: "sk-very-secret" });
  await m.updateConnector("local", added.connector.id, { enabled: false });
  await m.updateConnector("local", added.connector.id, { name: "renamed-secret" });
  expect(await m.removeConnector("local", added.connector.id)).toEqual({ removed: true });
  expect(tracked).toEqual([
    ["connector_added", { transport: "stdio", auth: "none", secrets: 1 }],
    ["connector_changed", { change: "disabled" }],
    ["connector_changed", { change: "edited" }],
    ["connector_removed", { transport: "stdio" }],
  ]);
  noContent(tracked, ["secret-name", "SECRET_TOKEN", "sk-very-secret", "/opt", "renamed"]);
});

test("what the daemon refuses comes back as a word, and is not reported as done", async () => {
  const { m, tracked } = await setup();
  const draft = {
    name: "twice",
    transport: { type: "http" as const, url: "https://x.example/mcp" },
    auth: { type: "none" as const },
  };
  await m.addConnector("local", draft);
  expect(await m.addConnector("local", draft)).toEqual({ problem: "name_taken" });
  expect(await m.removeConnector("local", "nope")).toEqual({ problem: "not_found" });
  expect(tracked.map(([name]) => name)).toEqual(["connector_added"]);
});

test("signing in goes through the browser and the callback here; the code never reaches the page", async () => {
  const browser = signsIn();
  const { m, events, tracked, daemon } = await setup(browser.open);
  const added = await m.addConnector("local", {
    name: "notion",
    transport: { type: "http", url: "https://mcp.notion.example/mcp" },
    auth: { type: "oauth" },
  });
  if (!("connector" in added)) throw new Error("not added");
  const answer = await m.authorizeConnector("local", added.connector.id);
  expect(answer).toMatchObject({ connector: { authorized: true, status: { state: "ready" } } });
  expect(browser.opened).toHaveLength(1);
  expect(daemon.finished).toEqual([{ flowId: "f1", code: "code-from-browser", state: "s1" }]);
  expect(JSON.stringify(events)).not.toContain("code-from-browser");
  expect(JSON.stringify(answer)).not.toContain("code-from-browser");
  expect(tracked.at(-1)).toEqual(["connector_authorized", { result: "ok" }]);

  expect(await m.signOutConnector("local", added.connector.id)).toMatchObject({
    connector: { authorized: false },
  });
  expect(tracked.at(-1)).toEqual(["connector_signed_out", {}]);
  noContent(tracked, ["notion", "code-from-browser"]);
});

test("a sign-in the server refuses is a problem; one stopped here is a cancel", async () => {
  const refusing = signsIn({ error: "server_error" });
  const { m, tracked } = await setup(refusing.open);
  const added = await m.addConnector("local", {
    name: "refuses",
    transport: { type: "http", url: "https://r.example/mcp" },
    auth: { type: "oauth" },
  });
  if (!("connector" in added)) throw new Error("not added");
  expect(await m.authorizeConnector("local", added.connector.id)).toEqual({
    problem: "auth_rejected",
  });
  expect(tracked.at(-1)).toEqual(["connector_authorized", { result: "failed" }]);
});

test("stopping a sign-in that waits for the browser, or starting another, cancels it", async () => {
  const { m, tracked } = await setup(async () => {});
  const added = await m.addConnector("local", {
    name: "slow",
    transport: { type: "http", url: "https://s.example/mcp" },
    auth: { type: "oauth" },
  });
  if (!("connector" in added)) throw new Error("not added");
  const first = m.authorizeConnector("local", added.connector.id);
  await Bun.sleep(30);
  const second = m.authorizeConnector("local", added.connector.id);
  expect(await first).toEqual({ cancelled: true });
  await Bun.sleep(30);
  await m.cancelConnectorAuth();
  expect(await second).toEqual({ cancelled: true });
  expect(tracked.filter(([name]) => name === "connector_authorized")).toEqual([
    ["connector_authorized", { result: "cancelled" }],
    ["connector_authorized", { result: "cancelled" }],
  ]);
});

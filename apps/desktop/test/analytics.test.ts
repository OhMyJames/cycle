import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sink } from "@cycle/analytics";
import {
  fileAnalyticsStore,
  offAnalytics,
  optedOutByEnvironment,
  projectOf,
  startAnalytics,
} from "../src/main/analytics.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-analytics-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const context = { app_version: "9.9.9", platform: "linux", arch: "x64" };
const recording = () => {
  const sent: { distinctId: string; event: string; properties: Record<string, unknown> }[] = [];
  const sink: Sink = { capture: (m) => void sent.push(m), shutdown: async () => {} };
  return { sent, sink: () => sink };
};
/** An installation whose person has already answered the notice. */
const told = async (enabled = true) => {
  const file = join(dir, "analytics.json");
  await writeFile(file, JSON.stringify({ id: "anon-1", enabled, noticed: true }));
  return file;
};
const start = (sink: (() => Sink) | undefined, file = join(dir, "analytics.json")) =>
  startAnalytics({ store: fileAnalyticsStore(file), sink, context });

test("the first run makes a random id and keeps it; the next run reports under the same one", async () => {
  const file = join(dir, "analytics.json");
  const a = recording();
  const first = await start(a.sink, file);
  expect(first.first).toBe(true);
  const saved = JSON.parse(await readFile(file, "utf8"));
  expect(saved).toMatchObject({ enabled: true, noticed: false });
  // Not told yet: nothing is sent while the notice is up, and "keep on" sends what was waiting.
  first.analytics.track("update_install_started", {});
  expect(a.sent).toEqual([]);
  await first.set(true);
  expect(a.sent.map((e) => [e.distinctId, e.event])).toEqual([
    [saved.id, "update_install_started"],
    [saved.id, "analytics_toggled"],
  ]);

  const b = recording();
  const second = await start(b.sink, file);
  expect(second.first).toBe(false);
  second.analytics.track("update_install_started", {});
  expect(b.sent[0]?.distinctId).toBe(saved.id);
});

test("a person who says no to the notice has had nothing sent, before or after", async () => {
  const file = join(dir, "analytics.json");
  const r = recording();
  const control = await start(r.sink, file);
  control.analytics.track("app_launched", { remote_locations: 0, first_run: true });
  expect(await control.set(false)).toEqual({ available: true, enabled: false, noticed: true });
  control.analytics.track("update_install_started", {});
  expect(r.sent).toEqual([]);
  // And what is waiting is gone, not sent later by a release that never comes.
  await control.analytics.shutdown();
  expect(r.sent).toEqual([]);
});

test("an answer that cannot be kept changes nothing, and the person is told", async () => {
  const r = recording();
  const control = await startAnalytics({
    store: {
      load: async () => ({ first: false, record: { id: "x", enabled: true, noticed: true } }),
      save: async () => {
        throw new Error("disk full");
      },
    },
    sink: r.sink,
    context,
  });
  await expect(control.set(false)).rejects.toThrow("disk full");
  expect(control.status()).toEqual({ available: true, enabled: true, noticed: true });
  control.analytics.track("update_install_started", {});
  expect(r.sent).toHaveLength(1);
});

test("answers given at once are kept one after the other", async () => {
  const file = join(dir, "analytics.json");
  const control = await start(recording().sink, file);
  await Promise.all([control.set(false), control.set(true), control.set(false)]);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ enabled: false, noticed: true });
});

test("what is reported carries the app and nothing of the machine's name or the user's", async () => {
  const r = recording();
  const control = await start(r.sink, await told());
  control.analytics.track("app_launched", { remote_locations: 2, first_run: true });
  const [event] = r.sent;
  expect(event?.properties).toMatchObject({ ...context, remote_locations: 2, first_run: true });
  expect(JSON.stringify(event)).not.toContain(dir);
});

test("a person who turns it off is heard: one last event says so, then nothing more, and it holds on the next run", async () => {
  const file = await told();
  const r = recording();
  const control = await start(r.sink, file);
  expect(control.status()).toEqual({ available: true, enabled: true, noticed: true });
  expect(await control.set(false)).toEqual({ available: true, enabled: false, noticed: true });
  control.analytics.track("update_install_started", {});
  expect(r.sent.map((e) => [e.event, e.properties.enabled])).toEqual([
    ["analytics_toggled", false],
  ]);

  const again = recording();
  const next = await start(again.sink, file);
  expect(next.status()).toEqual({ available: true, enabled: false, noticed: true });
  next.analytics.track("update_install_started", {});
  expect(again.sent).toEqual([]);

  // And back on: it says so first.
  await next.set(true);
  next.analytics.track("update_install_started", {});
  expect(again.sent.map((e) => e.event)).toEqual(["analytics_toggled", "update_install_started"]);
});

test("without a project nothing is made and nothing is sent, and the switch is not offered", async () => {
  const control = await start(undefined);
  control.analytics.track("update_install_started", {});
  expect(control.status()).toEqual({ available: false, enabled: false, noticed: false });
  // An answer is still kept, for when there is a project.
  expect(await control.set(true)).toMatchObject({
    available: false,
    enabled: false,
    noticed: true,
  });
  expect(offAnalytics.status().available).toBe(false);
});

test("a file that is damaged is replaced by a new id, and the app still starts", async () => {
  const file = join(dir, "analytics.json");
  await writeFile(file, "{not json");
  const control = await start(recording().sink, file);
  expect(control.first).toBe(true);
  expect(JSON.parse(await readFile(file, "utf8")).id).toMatch(/[0-9a-f-]{36}/);
});

test("the person's own word outside the app is honoured: DO_NOT_TRACK and CYCLE_ANALYTICS", () => {
  expect(optedOutByEnvironment({})).toBe(false);
  expect(optedOutByEnvironment({ DO_NOT_TRACK: "1" })).toBe(true);
  expect(optedOutByEnvironment({ DO_NOT_TRACK: "true" })).toBe(true);
  expect(optedOutByEnvironment({ DO_NOT_TRACK: "0" })).toBe(false);
  expect(optedOutByEnvironment({ DO_NOT_TRACK: "" })).toBe(false);
  expect(optedOutByEnvironment({ CYCLE_ANALYTICS: "off" })).toBe(true);
  expect(optedOutByEnvironment({ CYCLE_ANALYTICS: "0" })).toBe(true);
  expect(optedOutByEnvironment({ CYCLE_ANALYTICS: "on" })).toBe(false);
});

test("the project is the build's, or the environment's when it names one, or none", () => {
  expect(projectOf(undefined, {})).toBeUndefined();
  // A blank variable is not a choice: it does not switch off an app that has a key, or hide its host.
  expect(
    projectOf(
      { posthogKey: "phc_build", posthogHost: "h" },
      { CYCLE_POSTHOG_KEY: "", CYCLE_POSTHOG_HOST: "" },
    ),
  ).toEqual({ key: "phc_build", host: "h" });
  expect(projectOf({ posthogKey: "" }, {})).toBeUndefined();
  expect(
    projectOf({ posthogKey: "phc_build", posthogHost: "https://eu.i.posthog.com" }, {}),
  ).toEqual({
    key: "phc_build",
    host: "https://eu.i.posthog.com",
  });
  expect(projectOf({ posthogKey: "phc_build" }, { CYCLE_POSTHOG_KEY: "phc_env" })).toEqual({
    key: "phc_env",
  });
  expect(
    projectOf(undefined, {
      CYCLE_POSTHOG_KEY: "phc_env",
      CYCLE_POSTHOG_HOST: "http://localhost:8000",
    }),
  ).toEqual({
    key: "phc_env",
    host: "http://localhost:8000",
  });
});

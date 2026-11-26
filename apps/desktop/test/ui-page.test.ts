import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { InterfaceState } from "@cycle/ui";
import { createPageSwitch } from "../src/main/ui-page.ts";
import { createUiStore } from "../src/main/ui-store.ts";
import { makeBundle, verifyTest } from "./ui-fixture.ts";

const BUNDLED = "file:///app/renderer/index.html";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ui-page-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

/** A page switch over a real store, a window that records what it was told to load, and a clock the test turns. */
const setup = (options: { failLoad?: (url: string) => boolean; bundledVersion?: number } = {}) => {
  const store = createUiStore({
    root: join(dir, "ui"),
    verify: verifyTest,
    bundledVersion: options.bundledVersion ?? 0,
  });
  const loads: string[] = [];
  const emitted: InterfaceState[] = [];
  let installed: number | undefined;
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const pages = createPageSwitch({
    store,
    bundledUrl: BUNDLED,
    bundledVersion: options.bundledVersion ?? 0,
    load: async (url) => {
      loads.push(url);
      if (options.failLoad?.(url)) throw new Error("did not load");
    },
    installed: () => installed,
    emit: (state) => emitted.push(state),
    bootMs: 15_000,
    setTimeout: ((fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    }) as never,
    clearTimeout: ((t: { cleared: boolean }) => {
      t.cleared = true;
    }) as never,
  });
  const take = async (uiVersion: number) => {
    const b = await makeBundle(dir, uiVersion);
    const result = await store.install(b.staging, b.manifest, b.signature);
    expect(result.ok).toBe(true);
    installed = uiVersion;
  };
  const fire = async () => {
    const live = timers.filter((t) => !t.cleared);
    expect(live).toHaveLength(1);
    live[0]?.fn();
    // The fall back is queued behind what is under way.
    await Bun.sleep(20);
  };
  return { store, pages, loads, emitted, timers, take, fire };
};
const urlOf = (version: number) =>
  pathToFileURL(join(dir, "ui", String(version), "index.html")).href;

test("with no bundle the page the app came with is shown, and no timer runs", async () => {
  const s = setup();
  await s.pages.start();
  expect(s.loads).toEqual([BUNDLED]);
  expect(s.pages.url()).toBe(BUNDLED);
  expect(s.timers).toEqual([]);
  expect(s.pages.state()).toEqual({ bundled: 0, running: 0 });
});

test("a bundle taken before is shown at start, and the timer stops when the page says it has drawn itself", async () => {
  const s = setup();
  await s.take(5);
  await s.pages.start();
  expect(s.loads).toEqual([urlOf(5)]);
  expect(s.pages.url()).toBe(urlOf(5));
  expect(s.pages.state()).toEqual({ bundled: 0, running: 5 });
  expect(s.timers.map((t) => t.ms)).toEqual([15_000]);
  s.pages.booted();
  expect(s.timers[0]?.cleared).toBe(true);
});

test("a page that does not say it has drawn itself in time is marked bad and the one before is shown", async () => {
  const s = setup();
  await s.take(5);
  await s.take(7);
  await s.pages.start();
  expect(s.pages.url()).toBe(urlOf(7));
  await s.fire();
  expect(s.pages.url()).toBe(urlOf(5));
  expect(s.loads).toEqual([urlOf(7), urlOf(5)]);
  expect((await s.store.readState()).bad).toEqual([7]);
  // The same happens to that one, and in the end the page the app came with is shown, with no timer.
  await s.fire();
  expect(s.pages.url()).toBe(BUNDLED);
  expect(s.timers.filter((t) => !t.cleared)).toEqual([]);
  expect(s.pages.state()).toEqual({ bundled: 0, running: 0 });
});

test("a page whose process ends before it said it had drawn itself falls back, and is not offered again", async () => {
  const s = setup();
  await s.take(5);
  await s.pages.start();
  await s.pages.broke("crashed");
  expect(s.pages.url()).toBe(BUNDLED);
  expect((await s.store.readState()).bad).toEqual([5]);
  expect(s.pages.state()).toEqual({ bundled: 0, running: 0 });
});

test("after the page said it had drawn itself, its process ending is not held against it", async () => {
  const s = setup();
  await s.take(5);
  await s.pages.start();
  s.pages.booted();
  expect(s.pages.broke("crashed")).toBeUndefined();
  expect(s.pages.url()).toBe(urlOf(5));
  expect((await s.store.readState()).bad).toEqual([]);
});

test("a bundle that cannot be loaded falls back; the page the app came with that cannot is an error", async () => {
  const s = setup({ failLoad: (url) => url === urlOf(5) });
  await s.take(5);
  await s.pages.start();
  expect(s.loads).toEqual([urlOf(5), BUNDLED]);
  expect(s.pages.url()).toBe(BUNDLED);
  const t = setup({ failLoad: () => true });
  await expect(t.pages.start()).rejects.toThrow("did not load");
});

test("a bundle that was changed on disk is not shown", async () => {
  const s = setup();
  await s.take(5);
  await writeFile(join(dir, "ui", "5", "index.html"), "tampered");
  await s.pages.start();
  expect(s.pages.url()).toBe(BUNDLED);
  expect(s.loads).toEqual([BUNDLED]);
});

test("a bundle taken while the app runs waits to be shown: the state says it is ready, and applying shows it", async () => {
  const s = setup();
  await s.pages.start();
  await s.take(9);
  expect(s.pages.state()).toEqual({ bundled: 0, running: 0, ready: 9 });
  await s.pages.apply();
  expect(s.pages.url()).toBe(urlOf(9));
  expect(s.pages.state()).toEqual({ bundled: 0, running: 9 });
  expect(s.emitted.at(-1)).toEqual({ bundled: 0, running: 9 });
  // Nothing newer: applying again changes nothing and loads nothing.
  const n = s.loads.length;
  await s.pages.apply();
  expect(s.loads).toHaveLength(n);
});

test("applying a bundle that then does not draw falls back to the page that was showing", async () => {
  const s = setup();
  await s.take(5);
  await s.pages.start();
  s.pages.booted();
  await s.take(9);
  await s.pages.apply();
  expect(s.pages.url()).toBe(urlOf(9));
  await s.fire();
  expect(s.pages.url()).toBe(urlOf(5));
});

test("without a store only the page the app came with is ever shown", async () => {
  const loads: string[] = [];
  const pages = createPageSwitch({
    bundledUrl: BUNDLED,
    bundledVersion: 3,
    load: async (url) => void loads.push(url),
    installed: () => undefined,
    emit: () => {},
  });
  await pages.start();
  await pages.apply();
  expect(loads).toEqual([BUNDLED]);
  expect(pages.state()).toEqual({ bundled: 3, running: 3 });
});

test("the time to draw is counted from when the page has loaded, and not at all if it already said so", async () => {
  const s = setup();
  await s.take(5);
  let finish = () => {};
  const slow = createPageSwitch({
    store: s.store,
    bundledUrl: BUNDLED,
    bundledVersion: 0,
    load: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    installed: () => undefined,
    emit: () => {},
    setTimeout: ((fn: () => void, ms: number) => {
      s.timers.push({ fn, ms, cleared: false });
      return s.timers.at(-1);
    }) as never,
    clearTimeout: ((t: { cleared: boolean }) => {
      t.cleared = true;
    }) as never,
  });
  const started = slow.start();
  await Bun.sleep(10);
  expect(s.timers).toHaveLength(0);
  slow.booted();
  finish();
  await started;
  expect(s.timers).toHaveLength(0);
});

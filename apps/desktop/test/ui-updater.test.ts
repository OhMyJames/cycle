import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex, verifySignature } from "../src/main/ui-crypto.ts";
import { createUiStore } from "../src/main/ui-store.ts";
import { UiUpdater, type UiUpdateState } from "../src/main/ui-updater.ts";

const CONTRACT = 2;
const BASE = "https://example.test/ui-latest/";
const key = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const spki = (k: typeof key) =>
  k.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const keys = { k1: spki(key) };
const verify = (b: Uint8Array, s: string, id: string) => verifySignature(b, s, id, keys);

let dir: string;
let released: Map<string, { status?: number; body?: string | Uint8Array; etag?: string }>;
let requests: { url: string; ifNoneMatch?: string }[];
let unpacked: Record<string, string>;
let events: UiUpdateState[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ui-updater-"));
  released = new Map();
  requests = [];
  unpacked = {};
  events = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const fetchFake = (async (url: string, init?: RequestInit) => {
  const ifNoneMatch = (init?.headers as Record<string, string> | undefined)?.["If-None-Match"];
  requests.push({ url, ...(ifNoneMatch ? { ifNoneMatch } : {}) });
  const hit = released.get(url);
  if (hit === undefined) return new Response("not found", { status: 404 });
  if (hit.etag !== undefined && hit.etag === ifNoneMatch)
    return new Response(null, { status: 304 });
  return new Response((hit.body ?? "") as BodyInit, {
    status: hit.status ?? 200,
    headers: hit.etag !== undefined ? { etag: hit.etag } : {},
  });
}) as unknown as typeof fetch;

/** Puts a bundle on the fake release: its manifest, signature and archive. */
const publish = (
  uiVersion: number,
  options: {
    contract?: number;
    signer?: typeof key;
    archive?: string;
    files?: Record<string, string>;
    unzip?: Record<string, string>;
    etag?: string;
  } = {},
) => {
  const contract = options.contract ?? CONTRACT;
  const files = options.files ?? {
    "index.html": `<p>${uiVersion}</p>`,
    "renderer.js": `r${uiVersion}`,
  };
  const archive = Buffer.from(options.archive ?? `zip-${uiVersion}`);
  const manifest = Buffer.from(
    JSON.stringify({
      v: 2,
      contract,
      uiVersion,
      keyId: "k1",
      file: `ui-c${contract}-${uiVersion}.zip`,
      size: archive.length,
      sha256: sha256Hex(archive),
      files: Object.fromEntries(
        Object.entries(files).map(([p, t]) => [p, sha256Hex(Buffer.from(t))]),
      ),
    }),
  );
  released.set(`${BASE}ui-c${CONTRACT}.json`, {
    body: manifest,
    ...(options.etag ? { etag: options.etag } : {}),
  });
  released.set(`${BASE}ui-c${CONTRACT}.json.sig`, {
    body: sign(null, manifest, (options.signer ?? key).privateKey).toString("base64"),
  });
  released.set(`${BASE}ui-c${contract}-${uiVersion}.zip`, { body: archive });
  unpacked = options.unzip ?? files;
};

const make = (
  over: { hasKeys?: boolean; bundledVersion?: number; holdOff?: () => boolean } = {},
) => {
  const root = join(dir, "ui");
  const store = createUiStore({
    root,
    verify,
    bundledVersion: over.bundledVersion ?? 0,
    contract: 2,
  });
  const updater = new UiUpdater({
    store,
    contract: CONTRACT,
    hasKeys: over.hasKeys ?? true,
    verify,
    repo: "o/r",
    baseUrl: BASE,
    fetch: fetchFake,
    bundledVersion: over.bundledVersion ?? 0,
    extract: async (_zip, into) => {
      for (const [path, text] of Object.entries(unpacked)) {
        await mkdir(dirname(join(into, path)), { recursive: true });
        await writeFile(join(into, path), text);
      }
    },
    ...(over.holdOff ? { holdOff: over.holdOff } : {}),
    emit: (s) => events.push(s),
  });
  return { updater, store, root };
};

test("with no bundle published, nothing happens", async () => {
  const { updater, store } = make();
  expect(await updater.check()).toEqual({});
  expect(await store.selectPage()).toEqual({ kind: "bundled" });
  expect(requests.map((r) => r.url)).toEqual([`${BASE}ui-c${CONTRACT}.json`]);
});

test("a bundle that checks out is installed, and said to be", async () => {
  publish(12);
  const { updater, store } = make();
  expect(await updater.check()).toEqual({ installed: 12 });
  expect(events).toEqual([{ installed: 12 }]);
  expect(await store.selectPage()).toMatchObject({ kind: "ui", uiVersion: 12 });
});

test("the manifest is asked for again with its tag, and a 304 changes nothing", async () => {
  publish(12, { etag: '"a"' });
  const { updater } = make();
  await updater.check();
  const n = requests.length;
  expect(await updater.check()).toEqual({ installed: 12 });
  expect(requests.slice(n)).toEqual([{ url: `${BASE}ui-c${CONTRACT}.json`, ifNoneMatch: '"a"' }]);
});

test("a bundle with another key's signature, for another contract major, or not newer is not installed", async () => {
  const { updater, store } = make({ bundledVersion: 10 });
  publish(12, { signer: other });
  expect((await updater.check()).installed).toBeUndefined();
  publish(12, { contract: 3 });
  expect((await updater.check()).installed).toBeUndefined();
  publish(10);
  expect((await updater.check()).installed).toBeUndefined();
  expect(requests.some((r) => r.url.endsWith(".zip"))).toBe(false);
  expect(await store.selectPage()).toEqual({ kind: "bundled" });
});

test("an archive that is not the size or hash the manifest says is not installed, and the next check tries again", async () => {
  publish(12);
  released.set(`${BASE}ui-c${CONTRACT}-12.zip`, { body: "other bytes" });
  const { updater, store } = make();
  const state = await updater.check();
  expect(state.installed).toBeUndefined();
  expect(state.error).toContain("archive");
  released.set(`${BASE}ui-c${CONTRACT}-12.zip`, { body: "zip-12" });
  expect(await updater.check()).toEqual({ installed: 12 });
  expect(await store.selectPage()).toMatchObject({ uiVersion: 12 });
});

test("an archive whose files are not the ones listed is refused and leaves nothing behind", async () => {
  publish(12, { unzip: { "index.html": "<p>12</p>", "renderer.js": "evil" } });
  const { updater, store, root } = make();
  const state = await updater.check();
  expect(state.installed).toBeUndefined();
  expect(await store.selectPage()).toEqual({ kind: "bundled" });
  expect((await readdir(root).catch(() => [])).filter((n) => n !== "state.json")).toEqual([]);
});

test("a manifest that points at an archive not yet uploaded installs nothing and is tried again", async () => {
  publish(12);
  released.delete(`${BASE}ui-c${CONTRACT}-12.zip`);
  const { updater } = make();
  expect((await updater.check()).error).toContain("404");
  released.set(`${BASE}ui-c${CONTRACT}-12.zip`, { body: "zip-12" });
  expect(await updater.check()).toEqual({ installed: 12 });
});

test("without a key, nothing is asked for", async () => {
  publish(12);
  for (const over of [{ hasKeys: false }]) {
    const { updater } = make(over);
    expect((await updater.check()).disabled).toBeString();
    updater.start();
    updater.stop();
  }
  expect(requests).toEqual([]);
});

test("while the app is being replaced, no bundle is taken", async () => {
  publish(12);
  const { updater } = make({ holdOff: () => true });
  expect(await updater.check()).toEqual({});
  expect(requests).toEqual([]);
});

test("a network that is down is an error in words, and nothing else", async () => {
  const { store } = make();
  const failing = new UiUpdater({
    store,
    contract: CONTRACT,
    hasKeys: true,
    verify,
    repo: "o/r",
    baseUrl: BASE,
    fetch: (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch,
    extract: async () => {},
    bundledVersion: 0,
    emit: () => {},
  });
  expect(await failing.check()).toEqual({ error: "offline" });
});

test("a manual check asks the whole-app updater and the interface updater together", async () => {
  const { checkEverything } = await import("../src/main/ui-updater.ts");
  const { updater } = make();
  publish(7);
  const calls: string[] = [];
  const app = {
    check: async (manual: boolean) => {
      calls.push(`app:${manual}`);
      return { current: "0.1.0", kind: "up-to-date" as const, checkedAt: 0 };
    },
  };
  const state = await checkEverything(app, updater);
  expect(calls).toEqual(["app:true"]);
  expect(state.kind).toBe("up-to-date");
  // The page's check is not waited for: its own emit says what it found.
  await Bun.sleep(50);
  expect(requests.length).toBeGreaterThan(0);
  expect(events.some((e) => e.installed === 7)).toBe(true);
  // Without an interface updater only the app is asked.
  expect((await checkEverything(app, undefined)).kind).toBe("up-to-date");
});

test("a slow or failing interface check does not hold back the app's answer", async () => {
  const { checkEverything } = await import("../src/main/ui-updater.ts");
  const never = { check: () => new Promise<never>(() => {}) };
  const failing = { check: () => Promise.reject(new Error("boom")) };
  const app = { check: async () => "done" };
  expect(await checkEverything(app, never)).toBe("done");
  expect(await checkEverything(app, failing)).toBe("done");
});

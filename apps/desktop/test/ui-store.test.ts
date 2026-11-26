import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, verifySignature } from "../src/main/ui-crypto.ts";
import { createUiStore } from "../src/main/ui-store.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const keys = { k1: publicKey.export({ format: "der", type: "spki" }).toString("base64") };
const verify = (bytes: Uint8Array, signature: string, keyId: string) =>
  verifySignature(bytes, signature, keyId, keys);

let dir: string;
let root: string;
let clock = 1_000_000;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ui-store-"));
  root = join(dir, "ui");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const store = (bundledVersion = 0) =>
  createUiStore({ root, verify, bundledVersion, now: () => clock });

/** What the updater would hand over: an unpacked folder, and the manifest and signature that go with it. */
const bundle = async (
  uiVersion: number,
  files: Record<string, string> = {},
  tamper?: { sig?: boolean },
) => {
  const all = { "index.html": `<p>${uiVersion}</p>`, "chunks/a.js": `a${uiVersion}`, ...files };
  const staging = join(dir, `stage-${uiVersion}-${Math.random()}`);
  for (const [path, text] of Object.entries(all)) {
    await mkdir(join(staging, path, ".."), { recursive: true });
    await writeFile(join(staging, path), text);
  }
  const manifest = Buffer.from(
    JSON.stringify({
      v: 1,
      shell: "0".repeat(32),
      uiVersion,
      keyId: "k1",
      file: `ui-${uiVersion}.zip`,
      size: 10,
      sha256: "a".repeat(64),
      files: Object.fromEntries(
        Object.entries(all).map(([p, t]) => [p, sha256Hex(Buffer.from(t))]),
      ),
    }),
  );
  const sig = tamper?.sig ? "AAAA" : sign(null, manifest, privateKey).toString("base64");
  return { staging, manifest, sig };
};

const take = async (
  s: ReturnType<typeof store>,
  uiVersion: number,
  files?: Record<string, string>,
) => {
  const b = await bundle(uiVersion, files);
  return s.install(b.staging, b.manifest, b.sig);
};

test("with nothing installed the page the app was built with is used", async () => {
  expect(await store().selectPage()).toEqual({ kind: "bundled" });
});

test("an installed bundle is chosen, and the next one replaces it with the first as the fallback", async () => {
  const s = store();
  expect(await take(s, 5)).toEqual({ ok: true, uiVersion: 5 });
  expect(await s.selectPage()).toEqual({ kind: "ui", uiVersion: 5, dir: join(root, "5") });
  expect(await take(s, 7)).toEqual({ ok: true, uiVersion: 7 });
  expect(await s.readState()).toEqual({ current: 7, previous: 5, floor: 7, bad: [] });
  expect(await take(s, 9)).toEqual({ ok: true, uiVersion: 9 });
  expect(await s.readState()).toEqual({ current: 9, previous: 7, floor: 9, bad: [] });
  expect((await readdir(root)).sort()).toEqual(["7", "9", "state.json"]);
});

test("a bundle that is not newer than what was seen, or than the built-in page, is refused", async () => {
  const s = store(10);
  expect((await take(s, 10)).ok).toBe(false);
  expect((await take(s, 3)).ok).toBe(false);
  expect(await take(s, 11)).toEqual({ ok: true, uiVersion: 11 });
  expect((await take(s, 11)).ok).toBe(false);
  expect((await take(s, 8)).ok).toBe(false);
  expect(await s.selectPage()).toMatchObject({ kind: "ui", uiVersion: 11 });
});

test("a bundle with a wrong signature, a changed file, an extra file or a missing one is not installed", async () => {
  const s = store();
  const wrongSig = await bundle(5, {}, { sig: true });
  expect((await s.install(wrongSig.staging, wrongSig.manifest, wrongSig.sig)).ok).toBe(false);

  const changed = await bundle(6);
  await writeFile(join(changed.staging, "chunks/a.js"), "evil");
  expect((await s.install(changed.staging, changed.manifest, changed.sig)).ok).toBe(false);

  const extra = await bundle(7);
  await writeFile(join(extra.staging, "extra.js"), "x");
  expect((await s.install(extra.staging, extra.manifest, extra.sig)).ok).toBe(false);

  const missing = await bundle(8);
  await rm(join(missing.staging, "chunks/a.js"));
  expect((await s.install(missing.staging, missing.manifest, missing.sig)).ok).toBe(false);

  const link = await bundle(9);
  await symlink("/etc/passwd", join(link.staging, "chunks/b.js"));
  expect((await s.install(link.staging, link.manifest, link.sig)).ok).toBe(false);

  expect(await s.selectPage()).toEqual({ kind: "bundled" });
  expect((await s.readState()).floor).toBe(0);
});

test("a bundle that was changed on disk after it was installed is skipped, then the one before, then the built-in page", async () => {
  const s = store();
  await take(s, 5);
  await take(s, 7);
  await writeFile(join(root, "7", "index.html"), "tampered");
  expect(await s.selectPage()).toEqual({ kind: "ui", uiVersion: 5, dir: join(root, "5") });
  expect((await s.readState()).bad).toEqual([7]);
  await writeFile(join(root, "5", "extra"), "x");
  expect(await s.selectPage()).toEqual({ kind: "bundled" });
  expect((await s.readState()).bad.sort()).toEqual([5, 7]);
  // What was marked bad is not taken again, even when the same version is offered.
  expect((await s.readState()).floor).toBe(7);
});

test("a bundle marked bad is not chosen, and the fallback takes its place", async () => {
  const s = store();
  await take(s, 5);
  await take(s, 7);
  await s.markBad(7);
  expect(await s.selectPage()).toMatchObject({ kind: "ui", uiVersion: 5 });
  await s.markBad(5);
  expect(await s.selectPage()).toEqual({ kind: "bundled" });
});

test("a state file that is damaged is as good as none", async () => {
  const s = store();
  await take(s, 5);
  await writeFile(join(root, "state.json"), "{not json");
  expect(await s.selectPage()).toEqual({ kind: "bundled" });
  expect(await s.readState()).toEqual({ floor: 0, bad: [] });
  await writeFile(
    join(root, "state.json"),
    JSON.stringify({ current: "x", floor: -1, bad: ["y", 3] }),
  );
  expect(await s.readState()).toEqual({ floor: 0, bad: [3] });
});

test("an install that stopped halfway leaves nothing chosen, and its leftovers are cleaned up later", async () => {
  const s = store();
  await take(s, 5);
  const left = await s.newStaging(6);
  await writeFile(join(left, "partial"), "x");
  expect(await s.selectPage()).toMatchObject({ uiVersion: 5 });
  await s.cleanup();
  expect(await readdir(root)).toContain(left.split("/").pop() as string);
  clock += 11 * 60 * 1000;
  const old = new Date(clock - 20 * 60 * 1000);
  await utimes(left, old, old);
  await s.cleanup();
  expect((await readdir(root)).sort()).toEqual(["5", "state.json"]);
});

test("installing the same version again is harmless", async () => {
  const s = store();
  await take(s, 5);
  expect((await take(s, 5)).ok).toBe(false);
  expect(await s.selectPage()).toMatchObject({ uiVersion: 5 });
  expect(await readFile(join(root, "5", "index.html"), "utf8")).toBe("<p>5</p>");
});

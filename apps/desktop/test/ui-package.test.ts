import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeUiBundle, privateKeyFrom, signatureHolds } from "../scripts/ui-package.ts";
import { verifySignature } from "../src/main/ui-crypto.ts";
import { createUiStore, MANIFEST_FILE, SIGNATURE_FILE } from "../src/main/ui-store.ts";
import { parseManifest } from "../src/shared/ui-bundle.ts";

const CONTRACT = 2;
let dir: string;
let renderer: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ui-package-"));
  renderer = join(dir, "renderer");
  for (const [path, text] of Object.entries({
    "index.html": "<html></html>",
    "renderer.js": "console.log(1)",
    "chunks/a-1.js": "a",
    "fonts/f.woff2": "f",
  })) {
    await mkdir(dirname(join(renderer, path)), { recursive: true });
    await writeFile(join(renderer, path), text);
  }
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const key = generateKeyPairSync("ed25519");
const pem = key.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const spki = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");

const fakeZip = async (_dir: string, archive: string) =>
  void (await writeFile(archive, "zip bytes"));

test("the manifest lists every file of the page with its hash, and names the archive made", async () => {
  const made = await makeUiBundle({
    rendererDir: renderer,
    contract: CONTRACT,
    uiVersion: 321,
    keyId: "k1",
    outDir: join(dir, "out"),
    zip: fakeZip,
  });
  expect(Object.keys(made.manifest.files)).toEqual([
    "chunks/a-1.js",
    "fonts/f.woff2",
    "index.html",
    "renderer.js",
  ]);
  expect(made.manifest).toMatchObject({
    contract: CONTRACT,
    uiVersion: 321,
    file: `ui-c${CONTRACT}-321.zip`,
    size: 9,
  });
  expect(parseManifest(await readFile(made.manifestFile))).toEqual(made.manifest);
  expect(made.signatureFile).toBeUndefined();
  expect((await readdir(join(dir, "out"))).sort()).toEqual([
    `ui-c${CONTRACT}-321.zip`,
    `ui-c${CONTRACT}.json`,
  ]);
});

test("with a key the signature holds for the manifest's bytes, in the PEM form and in the base64 one", async () => {
  for (const text of [
    pem,
    key.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  ]) {
    const made = await makeUiBundle({
      rendererDir: renderer,
      contract: CONTRACT,
      uiVersion: 321,
      keyId: "k1",
      outDir: join(dir, "out"),
      zip: fakeZip,
      signingKey: privateKeyFrom(text),
    });
    const bytes = await readFile(made.manifestFile);
    const sig = await readFile(made.signatureFile as string, "utf8");
    expect(verifySignature(bytes, sig, "k1", { k1: spki })).toBe(true);
  }
});

test("a signature is accepted only for the key built in under the id, not for another key, an unknown id or no keys", async () => {
  const made = await makeUiBundle({
    rendererDir: renderer,
    contract: CONTRACT,
    uiVersion: 321,
    keyId: "k1",
    outDir: join(dir, "out"),
    zip: fakeZip,
    signingKey: key.privateKey,
  });
  const other = generateKeyPairSync("ed25519")
    .publicKey.export({ format: "der", type: "spki" })
    .toString("base64");
  expect(await signatureHolds(made, { k1: spki })).toBe(true);
  expect(await signatureHolds(made, { k1: other })).toBe(false);
  expect(await signatureHolds(made, { k2: spki })).toBe(false);
  expect(await signatureHolds(made, {})).toBe(false);
  const unsigned = await makeUiBundle({
    rendererDir: renderer,
    contract: CONTRACT,
    uiVersion: 321,
    keyId: "k1",
    outDir: join(dir, "out2"),
    zip: fakeZip,
  });
  expect(await signatureHolds(unsigned, { k1: spki })).toBe(false);
});

test.skipIf(process.platform !== "darwin")(
  "a bundle made with ditto is unpacked by ditto into exactly the files listed, and the store takes it",
  async () => {
    const run = (cmd: string[]) => {
      const r = Bun.spawnSync(cmd);
      if (!r.success) throw new Error(r.stderr.toString());
    };
    const made = await makeUiBundle({
      rendererDir: renderer,
      contract: CONTRACT,
      uiVersion: 321,
      keyId: "k1",
      outDir: join(dir, "out"),
      zip: async (from, archive) =>
        run(["/usr/bin/ditto", "-c", "-k", "--norsrc", "--noextattr", from, archive]),
      signingKey: key.privateKey,
    });
    const store = createUiStore({
      root: join(dir, "ui"),
      bundledVersion: 0,
      contract: CONTRACT,
      verify: (b, s, id) => verifySignature(b, s, id, { k1: spki }),
    });
    const staging = await store.newStaging(321);
    run(["/usr/bin/ditto", "-x", "-k", made.archive, staging]);
    const result = await store.install(
      staging,
      await readFile(made.manifestFile),
      await readFile(made.signatureFile as string, "utf8"),
    );
    expect(result).toEqual({ ok: true, uiVersion: 321 });
    expect(await store.selectPage()).toMatchObject({ kind: "ui", uiVersion: 321 });
    expect((await readdir(join(dir, "ui", "321"))).sort()).toEqual(
      ["chunks", "fonts", "index.html", "renderer.js", MANIFEST_FILE, SIGNATURE_FILE].sort(),
    );
  },
);

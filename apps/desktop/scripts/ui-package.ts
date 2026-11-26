// `bun run ui-package`: the page of the built app (`dist/renderer`) as an interface bundle, ready to publish to the
// `ui-latest` release: an archive of the page's files, the manifest that lists them (and which shell they are for),
// and, when UI_SIGNING_KEY is set, the signature of the manifest. Without the key the bundle is unsigned, which is
// for trying the format; no app takes it.
//
//   build/ui/{ui-<shell>-<uiVersion>.zip, ui-<shell>.json, ui-<shell>.json.sig}
//
// UI_SIGNING_KEY is an Ed25519 private key, PKCS#8, as PEM or as base64 of its DER. UI_SIGNING_KEY_ID names its public
// key in the app (default k1).
import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex, shellHash } from "../src/main/ui-crypto.ts";
import {
  parseManifest,
  type UiManifest,
  uiArchiveName,
  uiManifestName,
  uiSignatureName,
} from "../src/shared/ui-bundle.ts";

const DESKTOP = new URL("..", import.meta.url).pathname;
const ROOT = join(DESKTOP, "../..");
export const UI_OUT_DIR = join(DESKTOP, "build/ui");
/** A bundle built from a clone that has lost its history would number itself 1 and be refused by every app. */
const MIN_PLAUSIBLE_VERSION = 100;

/** Every file under `dir`, by path from it, sorted. */
const listFiles = async (dir: string, prefix = ""): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (entry.isFile()) out.push(rel);
    else throw new Error(`${rel} is not a plain file`);
  }
  return out.sort();
};

export const privateKeyFrom = (text: string): KeyObject => {
  const trimmed = text.trim();
  return trimmed.startsWith("-----")
    ? createPrivateKey(trimmed)
    : createPrivateKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "pkcs8" });
};

export type MadeBundle = {
  manifest: UiManifest;
  archive: string;
  manifestFile: string;
  signatureFile?: string;
};

/** Makes the bundle of `rendererDir` in `outDir`. `zip` writes the archive of a folder's contents (at its root). */
export const makeUiBundle = async (options: {
  rendererDir: string;
  shell: string;
  uiVersion: number;
  keyId: string;
  outDir: string;
  zip: (dir: string, archive: string) => Promise<void>;
  signingKey?: KeyObject;
}): Promise<MadeBundle> => {
  const { rendererDir, shell, uiVersion, keyId, outDir } = options;
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const files: Record<string, string> = {};
  for (const path of await listFiles(rendererDir))
    files[path] = sha256Hex(await readFile(join(rendererDir, path)));
  const file = uiArchiveName(shell, uiVersion);
  const archive = join(outDir, file);
  await options.zip(rendererDir, archive);
  const bytes = await readFile(archive);
  const manifest: UiManifest = {
    v: 1,
    shell,
    uiVersion,
    keyId,
    file,
    size: (await stat(archive)).size,
    sha256: sha256Hex(bytes),
    files,
  };
  const text = `${JSON.stringify(manifest)}\n`;
  // What an app reads is checked the way an app checks it, so a bundle that no app would take is not made.
  if (parseManifest(text) === undefined)
    throw new Error("The manifest made is not one an app takes.");
  const manifestFile = join(outDir, uiManifestName(shell));
  await writeFile(manifestFile, text);
  let signatureFile: string | undefined;
  if (options.signingKey !== undefined) {
    signatureFile = join(outDir, uiSignatureName(shell));
    await writeFile(
      signatureFile,
      `${sign(null, Buffer.from(text), options.signingKey).toString("base64")}\n`,
    );
  }
  return {
    manifest,
    archive,
    manifestFile,
    ...(signatureFile !== undefined ? { signatureFile } : {}),
  };
};

const git = (...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd: ROOT })
    .stdout.toString()
    .trim();

/** The number of commits behind this one: it rises with every commit on main. From a full clone only. */
export const commitCount = (): number => {
  if (git("rev-parse", "--is-shallow-repository") === "true")
    throw new Error("This clone has no history (shallow): the number of commits would be wrong.");
  const count = Number(git("rev-list", "--count", "HEAD"));
  if (!Number.isSafeInteger(count) || count < MIN_PLAUSIBLE_VERSION)
    throw new Error(`${count} commits is not a version a bundle can carry.`);
  return count;
};

const ditto = async (dir: string, archive: string) => {
  const result = Bun.spawnSync(
    ["/usr/bin/ditto", "-c", "-k", "--norsrc", "--noextattr", dir, archive],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (!result.success) throw new Error(`Could not archive ${dir}.`);
};

if (import.meta.main) {
  if (process.platform !== "darwin") throw new Error("Interface bundles are made on macOS.");
  const dist = join(DESKTOP, "dist");
  if (!existsSync(join(dist, "renderer/index.html")))
    throw new Error("The app is not built. Run `bun run build` in apps/desktop.");
  const shell = shellHash(
    readFileSync(join(dist, "main.mjs")),
    readFileSync(join(dist, "preload.cjs")),
  );
  const key = process.env.UI_SIGNING_KEY;
  const made = await makeUiBundle({
    rendererDir: join(dist, "renderer"),
    shell,
    uiVersion: commitCount(),
    keyId: process.env.UI_SIGNING_KEY_ID || "k1",
    outDir: UI_OUT_DIR,
    zip: ditto,
    ...(key ? { signingKey: privateKeyFrom(key) } : {}),
  });
  console.log(
    JSON.stringify({ ...made, manifest: undefined, shell, uiVersion: made.manifest.uiVersion }),
  );
}

// A signed interface bundle on disk, for the tests of what takes and shows one.
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex, verifySignature } from "../src/main/ui-crypto.ts";
import { CONTRACT_MAJOR } from "../src/shared/contract.ts";

export const testKey = generateKeyPairSync("ed25519");
export const testKeys = {
  k1: testKey.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
};
export const verifyTest = (bytes: Uint8Array, signature: string, keyId: string) =>
  verifySignature(bytes, signature, keyId, testKeys);

/** An unpacked folder of a bundle in `parent`, with the manifest and signature that go with it. */
export const makeBundle = async (
  parent: string,
  uiVersion: number,
  files: Record<string, string> = {},
  contract = CONTRACT_MAJOR,
) => {
  const all = { "index.html": `<p>${uiVersion}</p>`, "chunks/a.js": `a${uiVersion}`, ...files };
  const staging = join(parent, `stage-${uiVersion}-${Math.random().toString(36).slice(2)}`);
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(staging, path)), { recursive: true });
    await writeFile(join(staging, path), text);
  }
  const manifest = Buffer.from(
    JSON.stringify({
      v: 2,
      contract,
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
  return {
    staging,
    manifest,
    signature: sign(null, manifest, testKey.privateKey).toString("base64"),
  };
};

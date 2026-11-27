// The hashing and signature checks of interface bundles (shared/ui-bundle.ts has the format).
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_REV } from "../shared/contract.ts";
import { shellInput } from "../shared/ui-bundle.ts";

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The shell of a build: the first 32 hex digits of the hash of the preload, the app's API and the contract revision
 * (`shellInput`). The main process is not in it: what is inside it cannot be told by the page. */
export const shellHash = (preload: Uint8Array, contract: string, rev: number): string =>
  sha256Hex(shellInput(preload, contract, rev)).slice(0, 32);

/** The shell of the build in `dir` (dist/, or the app's copy of it): its preload and the contract the build recorded. */
export const shellOfBuild = (dir: string): string =>
  shellHash(
    readFileSync(join(dir, "preload.cjs")),
    readFileSync(join(dir, "contract.txt"), "utf8").trim(),
    CONTRACT_REV,
  );

/** Public keys by id: SPKI, DER, base64. */
export type UiKeys = Readonly<Record<string, string>>;

/** Whether `signature` (base64) is the Ed25519 signature of `bytes` by the key `keyId` names. Never throws. */
export const verifySignature = (
  bytes: Uint8Array,
  signature: string,
  keyId: string,
  keys: UiKeys,
): boolean => {
  const spki = Object.hasOwn(keys, keyId) ? keys[keyId] : undefined;
  if (spki === undefined) return false;
  try {
    const sig = Buffer.from(signature.trim(), "base64");
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
    return verify(null, bytes, key, sig);
  } catch {
    return false;
  }
};

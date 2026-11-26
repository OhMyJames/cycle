// The hashing and signature checks of interface bundles (shared/ui-bundle.ts has the format).
import { createHash, createPublicKey, verify } from "node:crypto";
import { shellInput } from "../shared/ui-bundle.ts";

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The shell of a build: the first 32 hex digits of the hash of main.mjs and preload.cjs. The native module is not in it
 * (signing changes its bytes), and everything else the app runs from is either the page or checked by the signature. */
export const shellHash = (main: Uint8Array, preload: Uint8Array): string =>
  sha256Hex(shellInput(main, preload)).slice(0, 32);

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

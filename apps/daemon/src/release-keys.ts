// The public keys a daemon update's manifest may be signed with, by id (docs/daemon.md "自动更新", CYC-538). The same
// CI key signs interface bundles (apps/desktop/src/main/ui-keys.ts; a test holds the two lists equal); a manifest says
// which kind of thing it is, so a signature on one cannot be taken for the other. Empty means the daemon never updates
// itself. To rotate: add the new key, publish a daemon that has it, sign with it from then on, and later drop the old one.
import { createPublicKey, verify } from "node:crypto";

export type ReleaseKeys = Readonly<Record<string, string>>;

/** SPKI, DER, base64. */
export const RELEASE_KEYS: ReleaseKeys = {
  k1: "MCowBQYDK2VwAyEApj2hKxVjPpg+vPl1qT9VTliz3DpRLzb5sEEt90rWKqQ=",
};

/** Whether `signature` (base64) is the Ed25519 signature of `bytes` by the key `keyId` names. Never throws. */
export const verifySignature = (
  bytes: Uint8Array,
  signature: string,
  keyId: string,
  keys: ReleaseKeys,
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

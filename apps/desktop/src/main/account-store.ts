// Where the login is kept between runs. The installed app seals it with Electron's safeStorage, whose key is in the
// macOS keychain (an item of the app's own, "Cycle Safe Storage", that only an app signed as this one reads without
// asking); a run from source and a test keep it in a file of their own, and never touch the keychain.
//
// The stable app and a run from source are different applications to Electron (another name, another data folder), so
// each has its own login: the refresh token rotates, and two holders of one would end each other's.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AccountStore, SavedAccount } from "./account.ts";

const isSaved = (value: unknown): value is SavedAccount => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.issuer === "string" &&
    typeof v.clientId === "string" &&
    typeof v.sub === "string" &&
    typeof v.name === "string" &&
    typeof v.email === "string" &&
    typeof v.renewedAt === "number" &&
    (v.refreshToken === undefined || typeof v.refreshToken === "string")
  );
};

/** Written whole, readable only by this user, and swapped in at once: a crash leaves the old one or the new one. */
const writePrivate = (path: string, data: string | Buffer) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
};

const parse = (text: string): SavedAccount | undefined => {
  const value: unknown = JSON.parse(text);
  return isSaved(value) ? value : undefined;
};

/** A file of its own (0600). For a test and a run from source. */
export const fileAccountStore = (path: string): AccountStore => ({
  load: async () => (existsSync(path) ? parse(readFileSync(path, "utf8")) : undefined),
  save: async (account) => writePrivate(path, `${JSON.stringify(account)}\n`),
  clear: async () => rmSync(path, { force: true }),
});

/** What Electron's safeStorage does, as much as is used here: a test gives its own. */
export type Sealer = {
  available(): boolean;
  seal(text: string): Buffer;
  open(sealed: Buffer): string;
};

/**
 * Sealed with the keychain's key (safeStorage). Where it cannot seal (no keychain), nothing is kept: the person signs in
 * at every start rather than having the token lie in a file in the clear.
 */
export const sealedAccountStore = (path: string, sealer: Sealer): AccountStore => ({
  load: async () => {
    if (!existsSync(path) || !sealer.available()) return undefined;
    return parse(sealer.open(readFileSync(path)));
  },
  save: async (account) => {
    if (!sealer.available()) throw new Error("The keychain is not available");
    writePrivate(path, sealer.seal(JSON.stringify(account)));
  },
  clear: async () => rmSync(path, { force: true }),
});

/**
 * Which store this run keeps its login in. The installed app: sealed with the keychain. A run from source: a file of its
 * own (another application to Electron, so another data folder, and never the installed app's login). A test that names
 * a stand-in provider: another file, whatever the build, so the person's own login is never read or replaced.
 */
export const accountStoreFor = (options: {
  packaged: boolean;
  test: boolean;
  userData: string;
  sealer: Sealer;
}): { store: AccountStore; path: string; sealed: boolean } => {
  const sealed = options.packaged && !options.test;
  const path = join(
    options.userData,
    sealed ? "account.sealed" : options.test ? "account-test.json" : "account-dev.json",
  );
  return {
    store: sealed ? sealedAccountStore(path, options.sealer) : fileAccountStore(path),
    path,
    sealed,
  };
};

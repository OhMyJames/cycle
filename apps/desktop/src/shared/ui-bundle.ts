// What an interface bundle is: the page of the app, built apart from the shell (main, preload), published on its own and
// loaded from outside the app (docs/desktop.md, "Interface updates"). Shared by the script that makes a bundle and the
// app that takes one, so the format has one definition. Pure: hashing and signatures are in main/ui-crypto.ts.

/** The repository release that holds the bundles. Its tag does not start with `v`, so the app's own updater skips it. */
export const UI_RELEASE_TAG = "ui-latest";

/** `ui-<shell>.json`: what the newest bundle for one shell is. `ui-<shell>.json.sig` is the signature of its bytes. */
export const uiManifestName = (shell: string): string => `ui-${shell}.json`;
export const uiSignatureName = (shell: string): string => `${uiManifestName(shell)}.sig`;
export const uiArchiveName = (shell: string, uiVersion: number): string =>
  `ui-${shell}-${uiVersion}.zip`;

/** Beyond these a manifest is not one this app made. */
const MAX_FILES = 5000;
const MAX_BYTES = 200 * 1024 * 1024;

export type UiManifest = {
  readonly v: 1;
  /** The shell this bundle works with: a hash of the preload and the app's API (`shellHash`). */
  readonly shell: string;
  /** Rises with every commit on main, so a bundle is newer than another by comparing numbers. */
  readonly uiVersion: number;
  /** Which of the app's public keys signed it. */
  readonly keyId: string;
  /** The archive's name in the same release. */
  readonly file: string;
  /** Of the archive, in bytes and in lowercase hex. */
  readonly size: number;
  readonly sha256: string;
  /** Every file of the page, by its path inside the archive, with its hash. Nothing else may be there. */
  readonly files: Readonly<Record<string, string>>;
};

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

/** A relative path of plain names: no `..`, no empty part, not absolute, no backslash or NUL. */
export const isPlainRelativePath = (path: string): boolean =>
  path !== "" &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const isPlainName = (name: string): boolean => isPlainRelativePath(name) && !name.includes("/");

/** The manifest in these bytes, or undefined when it is not exactly one this app can take. */
export const parseManifest = (bytes: Uint8Array | string): UiManifest | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const m = value as Record<string, unknown>;
  if (m.v !== 1) return undefined;
  if (typeof m.shell !== "string" || !HEX32.test(m.shell)) return undefined;
  if (typeof m.uiVersion !== "number" || !Number.isSafeInteger(m.uiVersion) || m.uiVersion < 0)
    return undefined;
  if (typeof m.keyId !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(m.keyId)) return undefined;
  if (typeof m.file !== "string" || !isPlainName(m.file)) return undefined;
  if (typeof m.size !== "number" || !Number.isSafeInteger(m.size) || m.size <= 0) return undefined;
  if (m.size > MAX_BYTES) return undefined;
  if (typeof m.sha256 !== "string" || !HEX64.test(m.sha256)) return undefined;
  if (typeof m.files !== "object" || m.files === null || Array.isArray(m.files)) return undefined;
  const entries = Object.entries(m.files as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_FILES) return undefined;
  const files: Record<string, string> = {};
  for (const [path, hash] of entries) {
    if (!isPlainRelativePath(path)) return undefined;
    if (typeof hash !== "string" || !HEX64.test(hash)) return undefined;
    files[path] = hash;
  }
  // The page itself must be in it.
  if (files["index.html"] === undefined) return undefined;
  return {
    v: 1,
    shell: m.shell,
    uiVersion: m.uiVersion,
    keyId: m.keyId,
    file: m.file,
    size: m.size,
    sha256: m.sha256,
    files,
  };
};

/**
 * What a page may rely on the app to provide, as text: the source of the app's API (packages/ui/src/api.ts) without
 * comments or layout, and the version of the protocol SDK whose types it carries. Something that changes how the page and
 * the main process talk changes this; something inside the main process does not.
 */
export const contractText = (apiSource: string, sdkVersion: string): string => {
  let out = "";
  let i = 0;
  const n = apiSource.length;
  while (i < n) {
    const c = apiSource[i] as string;
    const next = apiSource[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && apiSource[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = apiSource.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
    } else if (c === '"' || c === "'" || c === "`") {
      // A string is copied as it is, with its escapes.
      let j = i + 1;
      while (j < n && apiSource[j] !== c) j += apiSource[j] === "\\" ? 2 : 1;
      out += apiSource.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return `sdk ${sdkVersion}\n${out.replace(/\s+/g, " ").trim()}`;
};

const field = (bytes: Uint8Array, out: number[]) => {
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(bytes.length));
  out.push(...length, ...bytes);
};

/**
 * The bytes the shell's hash is taken over: the preload (what the page can call), the contract (`contractText`) and the
 * revision (CONTRACT_REV), each with its length (8 bytes, big-endian) in front, so that moving the boundary between
 * them changes the hash. The main process is not in it.
 */
export const shellInput = (preload: Uint8Array, contract: string, rev: number): Uint8Array => {
  const out: number[] = [];
  field(preload, out);
  field(new TextEncoder().encode(contract), out);
  field(new TextEncoder().encode(String(rev)), out);
  return Uint8Array.from(out);
};

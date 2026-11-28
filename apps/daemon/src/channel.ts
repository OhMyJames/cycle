// What the daemon's release channel is (docs/daemon.md "自动更新", CYC-538): one rolling GitHub release, `daemon-latest`,
// that holds the newest daemon for each platform. A platform's manifest lists every file of the daemon's folder by its
// hash; the file itself is a gzipped asset named by that hash, so a file that did not change is neither uploaded nor
// downloaded again. The manifest is signed by the CI key whose public half is built into the daemon (release-keys.ts).
// Shared by the daemon that takes an update and the script that publishes one, so the format has one definition. Pure.
import { VERSION_FORMAT } from "./version.ts";

/** The repository release that holds the channel. Its tag does not start with `v`, so the app's own updater skips it. */
export const DAEMON_CHANNEL_TAG = "daemon-latest";

/** The repository the channel is in: the same one the app's releases and `install.sh` use. */
export const DAEMON_CHANNEL_REPO = "OhMyJames/cycle";

export const channelBaseUrl = (repo = DAEMON_CHANNEL_REPO): string =>
  `https://github.com/${repo}/releases/download/${DAEMON_CHANNEL_TAG}/`;

/** `daemon-<platform>-<arch>.json`: the newest daemon for one platform. `.sig` beside it is its signature. */
export const daemonManifestName = (platform: string, arch: string): string =>
  `daemon-${platform}-${arch}.json`;
export const daemonSignatureName = (platform: string, arch: string): string =>
  `${daemonManifestName(platform, arch)}.sig`;
/** One file of a daemon, gzipped, by the SHA-256 of its unpacked bytes. */
export const blobName = (sha256: string): string => `daemon-blob-${sha256}.gz`;

/** Beyond these a manifest is not one CI made. */
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

export type ChannelFile = {
  /** Of the unpacked file, lowercase hex. */
  readonly sha256: string;
  readonly size: number;
  /** 0o755 for a program, 0o644 for anything else. */
  readonly mode: number;
  /**
   * The SHA-256 of the file before it was signed (macOS). Signing puts a time in it, so the signed bytes differ each
   * time; when the unsigned file has not changed, the publisher keeps the earlier signed one and nothing is downloaded.
   */
  readonly source?: string;
};

export type DaemonManifest = {
  readonly v: 1;
  /** Signed by the same key as interface bundles: this says which kind of thing it is, so one cannot pass for the other. */
  readonly kind: "daemon";
  /** `<major>.<minor>.<commits on main>`: rises with every commit, so a newer daemon has a larger number. */
  readonly version: string;
  /** The commit it was built from. */
  readonly commit: string;
  readonly platform: string;
  readonly arch: string;
  /** The Cycle protocol version it speaks (`CYCLE_PROTOCOL_VERSION`). A daemon does not move itself to another major. */
  readonly protocol: string;
  /** A hash of everything the build read: when it is the same as the published one, nothing is published. */
  readonly inputs: string;
  /** Which of the built-in public keys signed it. */
  readonly keyId: string;
  /** Every file of the daemon's folder, by its path in the folder. Nothing else belongs there. */
  readonly files: Readonly<Record<string, ChannelFile>>;
};

const HEX64 = /^[0-9a-f]{64}$/;

/** A relative path of plain names: no `..`, no empty part, not absolute, no backslash or NUL. */
export const isPlainRelativePath = (path: string): boolean =>
  path !== "" &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const word = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

/** The manifest in these bytes, or undefined when it is not exactly one a daemon can take. */
export const parseDaemonManifest = (bytes: Uint8Array | string): DaemonManifest | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const m = value as Record<string, unknown>;
  if (m.v !== 1 || m.kind !== "daemon") return undefined;
  if (!word(m.version, VERSION_FORMAT)) return undefined;
  if (!word(m.commit, /^[0-9a-f]{7,64}$/)) return undefined;
  if (!word(m.platform, /^[a-z0-9]{1,16}$/) || !word(m.arch, /^[a-z0-9]{1,16}$/)) return undefined;
  if (!word(m.protocol, /^\d+\.\d+$/)) return undefined;
  if (!word(m.inputs, HEX64)) return undefined;
  if (!word(m.keyId, /^[A-Za-z0-9_-]{1,32}$/)) return undefined;
  if (typeof m.files !== "object" || m.files === null || Array.isArray(m.files)) return undefined;
  const entries = Object.entries(m.files as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_FILES) return undefined;
  const files: Record<string, ChannelFile> = {};
  for (const [path, raw] of entries) {
    if (!isPlainRelativePath(path)) return undefined;
    if (typeof raw !== "object" || raw === null) return undefined;
    const f = raw as Record<string, unknown>;
    if (!word(f.sha256, HEX64)) return undefined;
    if (typeof f.size !== "number" || !Number.isSafeInteger(f.size) || f.size < 0) return undefined;
    if (f.size > MAX_FILE_BYTES) return undefined;
    if (f.mode !== 0o755 && f.mode !== 0o644) return undefined;
    if (f.source !== undefined && !word(f.source, HEX64)) return undefined;
    files[path] = {
      sha256: f.sha256,
      size: f.size,
      mode: f.mode,
      ...(f.source !== undefined ? { source: f.source as string } : {}),
    };
  }
  // The daemon itself must be in it.
  if (files.cycle === undefined || files.cycle.mode !== 0o755) return undefined;
  // No file may sit where another is a folder ("a" and "a/b").
  const paths = new Set(Object.keys(files));
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      if (paths.has(parts.slice(0, i).join("/"))) return undefined;
  }
  return {
    v: 1,
    kind: "daemon",
    version: m.version,
    commit: m.commit,
    platform: m.platform,
    arch: m.arch,
    protocol: m.protocol,
    inputs: m.inputs,
    keyId: m.keyId,
    files,
  };
};

/** The major of a protocol version "major.minor". */
export const protocolMajor = (version: string): string => version.split(".")[0] ?? "";

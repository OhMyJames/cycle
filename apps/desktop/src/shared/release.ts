// What a release on GitHub holds for one platform, shared by the script that makes it and (later) the
// updater that reads it, so the format has one definition. Pure: nothing here touches Bun or Node.
import { APP_NAME } from "../main/layout.ts";

/** The repository whose releases the app updates from. */
export const RELEASE_REPO = "OhMyJames/cycle";

/** A release's tag for a version, and the only tags the workflow builds. */
export const tagOf = (version: string): string => `v${version}`;

/**
 * One thing in the app bundle, by its path from the bundle's folder (`Contents/MacOS/Electron`). The
 * table of these is what lets an update fetch only the files that changed: whatever is assembled is
 * checked against it, file by file.
 */
export type TreeEntry =
  | { path: string; kind: "dir" }
  | { path: string; kind: "file"; mode: number; size: number; sha256: string }
  | { path: string; kind: "link"; target: string };

/** `latest-<platform>-<arch>.json`, one per platform in a release: the archive, and what it must hash to. */
export type ReleaseManifest = {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  /** The archive's asset name in the same release. */
  readonly file: string;
  /** Of the archive, in lowercase hex. */
  readonly sha256: string;
  /** Of the archive, in bytes. */
  readonly size: number;
  /** What the bundle in the archive holds, for updating by the difference. Absent in older releases. */
  readonly tree?: readonly TreeEntry[];
  /** Why `tree` was left out, when the manifest had one that cannot be used (for the log). */
  readonly treeProblem?: string;
};

export const manifestName = (platform: string, arch: string): string =>
  `latest-${platform}-${arch}.json`;

export const archiveName = (version: string, platform: string, arch: string): string =>
  `${APP_NAME.replaceAll(" ", "-")}-${version}-${platform}-${arch}.zip`;

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** Plain `major.minor.patch`: the only versions a release carries. */
export const parseVersion = (text: string): readonly [number, number, number] | undefined => {
  const match = VERSION.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
};

/** Whether `candidate` is a later version than `current`. False when either is not a version. */
export const isNewer = (candidate: string, current: string): boolean => {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

/**
 * The oldest daemon this app works with. A remote daemon below it is told to update; one at or above it is left alone,
 * even when it is older than the app, because most releases change the page and not what the daemon does.
 *
 * Raise it in the release that needs a newer daemon: the app relies on something (a field, a method, a behaviour) that
 * the older one does not have and that cannot be left off the way a `capabilities` flag can. A feature that can be left
 * off asks for its flag instead and does not move this. See docs/desktop.md "远端 daemon 的升级".
 */
export const MIN_DAEMON_VERSION = "0.2.1";

/** Whether a daemon of `version` is too old for the app. False when either is not a version (a development build). */
export const daemonTooOld = (version: string): boolean => isNewer(MIN_DAEMON_VERSION, version);

/** `text` as one word for a POSIX shell. */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * How the command stops the daemon that is running, once the new one is installed (docs/daemon.md "停止和升级"):
 * - `ask`: `cycle stop`, which does not stop over work in progress without a terminal to ask at (it fails, and says
 *   what is working), and asks at one. For a daemon nothing was working on, and for the command run by hand.
 * - `now`: `cycle stop --force`: the person chose to interrupt what is working.
 * - `later`: `cycle stop --wait`, left running on that machine after ssh is done: the daemon stops (and the next
 *   connection starts the new one) when nothing is working.
 */
export type DaemonStop = "ask" | "now" | "later";

const STOPS: Record<DaemonStop, string> = {
  ask: '"$HOME/.local/bin/cycle" stop',
  now: '"$HOME/.local/bin/cycle" stop --force',
  // In braces, so that only the stop goes to the background and not the steps before it; its output goes nowhere,
  // so the ssh session can end while it waits.
  later: '{ nohup "$HOME/.local/bin/cycle" stop --wait >/dev/null 2>&1 </dev/null & }',
};

/** Runs on the remote machine, whose installer selects and verifies the native archive. */
export const daemonUpgradeCommand = (version: string, stop: DaemonStop = "ask"): string => {
  const tag = tagOf(version);
  const url = `https://github.com/${RELEASE_REPO}/releases/download/${tag}/install.sh`;
  return [
    'cd "$(mktemp -d)"',
    `curl -fsSLO ${shellQuote(url)}`,
    `curl -fsSLO ${shellQuote(`${url}.sha256`)}`,
    "sha256sum -c install.sh.sha256",
    `sh install.sh ${shellQuote(tag)}`,
    STOPS[stop],
  ].join(" && ");
};

export const manifestFor = (
  build: { version: string; platform: string; arch: string },
  archive: { sha256: string; size: number },
  tree?: readonly TreeEntry[],
): ReleaseManifest => ({
  version: build.version,
  platform: build.platform,
  arch: build.arch,
  file: archiveName(build.version, build.platform, build.arch),
  sha256: archive.sha256,
  size: archive.size,
  ...(tree !== undefined ? { tree } : {}),
});

const HEX = /^[0-9a-f]{64}$/;

/** Where a link at `base` that points at `target` lands, or undefined when that is outside the bundle. */
const resolveInside = (base: string, target: string): string | undefined => {
  const parts = base.split("/").slice(0, -1);
  let named = false;
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // Only at the start: after a name, it would go up from wherever that name leads, and that may be
      // another link, which this table cannot see through without walking the bundle.
      if (named || parts.length === 0) return undefined;
      parts.pop();
    } else {
      named = true;
      parts.push(part);
    }
  }
  return parts.join("/");
};

/**
 * Reads the table of a bundle, and throws unless every path in it stays inside the bundle: relative,
 * without `..`, listed once, under a folder that is itself listed (as a folder, never a link), and
 * links that point at something inside. Modes are plain permission bits. What it lets through is
 * what the updater will create on disk, so nothing here may name a place outside the bundle.
 */
export const parseTree = (value: unknown): TreeEntry[] => {
  if (!Array.isArray(value) || value.length === 0) throw new Error("the file table is empty");
  const seen = new Map<string, TreeEntry["kind"]>();
  const tree: TreeEntry[] = [];
  for (const raw of value as Record<string, unknown>[]) {
    if (typeof raw !== "object" || raw === null)
      throw new Error("a file table entry is not an object");
    const { path, kind } = raw;
    if (typeof path !== "string" || path === "" || path.includes("\0") || path.startsWith("/"))
      throw new Error("a file table path is not a relative path");
    if (path.split("/").some((part) => part === "" || part === "." || part === ".."))
      throw new Error(`the file table path ${path} is not plain`);
    if (seen.has(path)) throw new Error(`the file table lists ${path} twice`);
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined;
    if (parent !== undefined && seen.get(parent) !== "dir")
      throw new Error(`the file table has ${path} before its folder`);
    if (kind === "dir") {
      tree.push({ path, kind });
    } else if (kind === "file") {
      const { mode, size, sha256 } = raw;
      if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o777)
        throw new Error(`the file table gives ${path} a mode that is not plain permission bits`);
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
        throw new Error(`the file table gives ${path} no size`);
      if (typeof sha256 !== "string" || !HEX.test(sha256))
        throw new Error(`the file table gives ${path} no SHA-256`);
      tree.push({ path, kind, mode, size, sha256 });
    } else if (kind === "link") {
      const { target } = raw;
      if (
        typeof target !== "string" ||
        target === "" ||
        target.includes("\0") ||
        target.startsWith("/")
      )
        throw new Error(`the file table links ${path} to something that is not relative`);
      if (resolveInside(path, target) === undefined)
        throw new Error(`the file table links ${path} to something outside the bundle`);
      tree.push({ path, kind, target });
    } else throw new Error(`the file table has a ${String(kind)} at ${path}`);
    seen.set(path, kind);
  }
  return tree;
};

/**
 * Reads a manifest, and throws unless it is whole. The archive's name must be the one a build of that
 * version has, so a manifest cannot point the updater at some other file.
 */
export const parseManifest = (text: string): ReleaseManifest => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The release's manifest is not JSON.");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("The release's manifest is not an object.");
  }
  const { version, platform, arch, file, sha256, size } = value as Record<string, unknown>;
  if (typeof version !== "string" || !parseVersion(version))
    throw new Error("The release's manifest has no version.");
  if (typeof platform !== "string" || typeof arch !== "string")
    throw new Error("The release's manifest names no platform.");
  if (file !== archiveName(version, platform, arch))
    throw new Error("The release's manifest names an unexpected archive.");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))
    throw new Error("The release's manifest has no SHA-256.");
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0)
    throw new Error("The release's manifest has no size.");
  const manifest = { version, platform, arch, file, sha256, size };
  // A table that cannot be used costs the saving, not the update: the whole archive is still there.
  const table = (value as Record<string, unknown>).tree;
  if (table === undefined) return manifest;
  try {
    return { ...manifest, tree: parseTree(table) };
  } catch (error) {
    return { ...manifest, treeProblem: error instanceof Error ? error.message : String(error) };
  }
};

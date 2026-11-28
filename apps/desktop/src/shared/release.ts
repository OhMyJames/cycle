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
  /** Where the big files' blocks are, for fetching only the blocks of a file that changed. Absent in older releases. */
  readonly pack?: BlockPack;
  /** Why `pack` was left out, when the manifest had one that cannot be used (for the log). */
  readonly packProblem?: string;
};

/**
 * One block of a file: `blockSize` bytes of it (the last one may be shorter), deflated on its own (raw deflate) so it
 * can be fetched and unpacked alone. `offset` and `csize` are where its deflated bytes are in the pack.
 */
export type Block = { readonly sha256: string; readonly offset: number; readonly csize: number };

/**
 * The release's block pack (`<archive name>.blocks`): the files larger than one block, cut into blocks, each deflated
 * on its own. A signed binary changes at its end (its signature) on every release even when its code does not, so a
 * whole-file difference fetches all of it; by its blocks, only the few at its end.
 */
export type BlockPack = {
  /** The pack's asset name in the same release. */
  readonly file: string;
  /** Of the pack, in bytes. */
  readonly size: number;
  readonly blockSize: number;
  /** By the file's path in the bundle (`tree`), its blocks in order. */
  readonly files: Readonly<Record<string, readonly Block[]>>;
};

/** The size of a block: big enough that a few hundred requests at most cover a bundle, small enough to save. */
export const BLOCK_SIZE = 1 << 20;

export const manifestName = (platform: string, arch: string): string =>
  `latest-${platform}-${arch}.json`;

export const archiveName = (version: string, platform: string, arch: string): string =>
  `${APP_NAME.replaceAll(" ", "-")}-${version}-${platform}-${arch}.zip`;

export const packName = (version: string, platform: string, arch: string): string =>
  `${APP_NAME.replaceAll(" ", "-")}-${version}-${platform}-${arch}.blocks`;

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?(?:\+([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

export type ParsedVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** N of `-alpha.N`; absent for a release. */
  readonly alpha?: number;
  /** What follows `+` (the short commit, maybe `.dirty`); never part of the order. */
  readonly meta?: string;
};

/**
 * `X.Y.Z[-alpha.N][+meta]`: a release, or an alpha build. `alpha` is the only pre-release identifier there is, so
 * `-beta` and `-rc` are not versions.
 */
export const parseVersion = (text: string): ParsedVersion | undefined => {
  const match = VERSION.exec(text);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] !== undefined ? { alpha: Number(match[4]) } : {}),
    ...(match[5] !== undefined ? { meta: match[5] } : {}),
  };
};

/** -1, 0 or 1 by semver: an alpha is older than the release of the same X.Y.Z; `+meta` is ignored. */
const compare = (a: ParsedVersion, b: ParsedVersion): number => {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.alpha === b.alpha) return 0;
  if (a.alpha === undefined) return 1;
  if (b.alpha === undefined) return -1;
  return a.alpha > b.alpha ? 1 : -1;
};

/** Whether `candidate` is a later version than `current`. False when either is not a version. */
export const isNewer = (candidate: string, current: string): boolean => {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  return a !== undefined && b !== undefined && compare(a, b) > 0;
};

/** Whether the two are the same version: they may differ only in `+meta`. False when either is not a version. */
export const sameVersion = (a: string, b: string): boolean => {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x !== undefined && y !== undefined && compare(x, y) === 0;
};

/** `X.Y.Z` of a version, without its alpha and `+meta`. Undefined when it is not a version. */
export const baseRelease = (text: string): string | undefined => {
  const v = parseVersion(text);
  return v && `${v.major}.${v.minor}.${v.patch}`;
};

/**
 * The two `Info.plist` numbers for a version, which can only be numeric: `CFBundleShortVersionString` is `X.Y.Z`;
 * `CFBundleVersion` is N for an alpha (so it still rises between alphas) and `X.Y.Z` for a release.
 */
export const plistVersions = (
  text: string,
): { CFBundleShortVersionString: string; CFBundleVersion: string } | undefined => {
  const v = parseVersion(text);
  const base = baseRelease(text);
  if (!v || base === undefined) return undefined;
  return {
    CFBundleShortVersionString: base,
    CFBundleVersion: v.alpha === undefined ? base : String(v.alpha),
  };
};

/**
 * The oldest daemon this app works with. A remote daemon below it is told to update; one at or above it is left alone,
 * even when it is older than the app, because most releases change the page and not what the daemon does.
 *
 * Raise it in the release that needs a newer daemon: the app relies on something (a field, a method, a behaviour) that
 * the older one does not have and that cannot be left off the way a `capabilities` flag can. A feature that can be left
 * off asks for its flag instead and does not move this. See docs/desktop.md "远端 daemon 的升级". It is a daemon's version,
 * `<major>.<minor>.<commits>` (CYC-538), not the app's: the daemon of the commit that brings what the app needs.
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

/** In the manifest a block is `[sha256, offset, csize]`: there are a thousand of them. */
export const packToJson = (pack: BlockPack) => ({
  ...pack,
  files: Object.fromEntries(
    Object.entries(pack.files).map(([path, blocks]) => [
      path,
      blocks.map((b) => [b.sha256, b.offset, b.csize]),
    ]),
  ),
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
  let tree: TreeEntry[];
  try {
    tree = parseTree(table);
  } catch (error) {
    return { ...manifest, treeProblem: error instanceof Error ? error.message : String(error) };
  }
  // So is a pack that cannot be used: the changed files are then fetched whole from the archive.
  const packed = (value as Record<string, unknown>).pack;
  if (packed === undefined) return { ...manifest, tree };
  try {
    return { ...manifest, tree, pack: parsePack(packed, manifest, tree) };
  } catch (error) {
    return {
      ...manifest,
      tree,
      packProblem: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Reads a block pack, and throws unless it is whole: its name is the one this release's pack has, every file it lists
 * is a file of the table larger than a block, with as many blocks as its size needs, each within the pack and no
 * bigger than a deflated block can be (so a bad pack cannot make the updater hold more than a few blocks at once).
 */
export const parsePack = (
  value: unknown,
  release: { version: string; platform: string; arch: string },
  tree: readonly TreeEntry[],
): BlockPack => {
  if (typeof value !== "object" || value === null)
    throw new Error("the block pack is not an object");
  const { file, size, blockSize, files } = value as Record<string, unknown>;
  if (file !== packName(release.version, release.platform, release.arch))
    throw new Error("the block pack names an unexpected file");
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0)
    throw new Error("the block pack has no size");
  if (
    typeof blockSize !== "number" ||
    !Number.isSafeInteger(blockSize) ||
    blockSize < 1 << 16 ||
    blockSize > 1 << 24
  )
    throw new Error("the block pack's block size is not plain");
  if (typeof files !== "object" || files === null) throw new Error("the block pack lists no files");
  const sizes = new Map(
    tree.flatMap((entry) => (entry.kind === "file" ? [[entry.path, entry.size] as const] : [])),
  );
  // Deflate can make a block a little larger than it was; never this much.
  const most = blockSize + (blockSize >> 4) + 1024;
  const out: Record<string, Block[]> = {};
  for (const [path, raw] of Object.entries(files as Record<string, unknown>)) {
    const fileSize = sizes.get(path);
    if (fileSize === undefined)
      throw new Error(`the block pack lists ${path}, which is not a file of the table`);
    if (!Array.isArray(raw) || raw.length !== Math.ceil(fileSize / blockSize) || raw.length < 2)
      throw new Error(`the block pack gives ${path} another number of blocks than its size needs`);
    out[path] = raw.map((block: unknown) => {
      if (!Array.isArray(block) || block.length !== 3)
        throw new Error(`a block of ${path} is not plain`);
      const [sha256, offset, csize] = block as unknown[];
      if (typeof sha256 !== "string" || !HEX.test(sha256))
        throw new Error(`a block of ${path} has no SHA-256`);
      if (
        typeof offset !== "number" ||
        typeof csize !== "number" ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(csize) ||
        offset < 0 ||
        csize <= 0 ||
        csize > most ||
        offset + csize > size
      )
        throw new Error(`a block of ${path} is not within the pack`);
      return { sha256, offset, csize };
    });
  }
  return { file, size, blockSize, files: out };
};

// What a release on GitHub holds for one platform, shared by the script that makes it and the
// updater that reads it, so the format has one definition.
import { APP_NAME } from "./layout";

/** The repository whose releases the app updates from. */
export const RELEASE_REPO = "OhMyJames/cycle";

/** A release's tag for a version, and the only tags the workflow builds. */
export const tagOf = (version: string): string => `v${version}`;

/**
 * `latest-<platform>-<arch>.json`, one per platform in a release: which archive is this platform's
 * build, and what it must hash to.
 */
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
};

export const manifestName = (platform: string, arch: string): string =>
  `latest-${platform}-${arch}.json`;

export const archiveName = (version: string, platform: string, arch: string): string =>
  `${APP_NAME.replaceAll(" ", "-")}-${version}-${platform}-${arch}.zip`;

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** Plain `major.minor.patch`: the only versions a release carries. */
export function parseVersion(text: string): readonly [number, number, number] | undefined {
  const match = VERSION.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Whether `candidate` is a later version than `current`. False when either is not a version. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export function manifestFor(
  build: { version: string; platform: string; arch: string },
  archive: { sha256: string; size: number },
): ReleaseManifest {
  return {
    version: build.version,
    platform: build.platform,
    arch: build.arch,
    file: archiveName(build.version, build.platform, build.arch),
    sha256: archive.sha256,
    size: archive.size,
  };
}

/**
 * Reads a manifest, and throws unless it is whole. The archive's name must be the one a build of
 * that version has, so a manifest cannot point the updater at some other file.
 */
export function parseManifest(text: string): ReleaseManifest {
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
  if (typeof version !== "string" || !parseVersion(version)) {
    throw new Error("The release's manifest has no version.");
  }
  if (typeof platform !== "string" || typeof arch !== "string") {
    throw new Error("The release's manifest names no platform.");
  }
  if (file !== archiveName(version, platform, arch)) {
    throw new Error("The release's manifest names an unexpected archive.");
  }
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("The release's manifest has no SHA-256.");
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error("The release's manifest has no size.");
  }
  return { version, platform, arch, file, sha256, size };
}

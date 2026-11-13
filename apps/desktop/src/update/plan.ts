// The decisions the updater makes, apart from the network, disk and processes they are about.
import { BUNDLE_ID, MAC_BUNDLE } from "../shared/layout";
import {
  RELEASE_REPO,
  type ReleaseManifest,
  manifestName,
  parseManifest,
  parseVersion,
} from "../shared/release";

export const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

export type Headers = Readonly<Record<string, string>>;

/** The token goes in this one header, and nowhere else: not a URL, not a message, not a file. */
const withToken = (headers: Headers, token: string | undefined): Headers =>
  token ? { ...headers, Authorization: `Bearer ${token}` } : headers;

export const releaseHeaders = (token: string | undefined): Headers =>
  withToken({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, token);

/** An asset's API address answers with the file itself only when asked for it this way. */
export const assetHeaders = (token: string | undefined): Headers =>
  withToken({ Accept: "application/octet-stream", "X-GitHub-Api-Version": "2022-11-28" }, token);

export type ExecResult = { readonly code: number | null; readonly stdout: string };
export type Exec = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
) => Promise<ExecResult>;

/**
 * The owner's GitHub token: what their shell exports, or else what `gh` is signed in with, found on
 * that shell's `PATH`. None is fine for a public repository.
 */
export async function findToken(
  env: Readonly<Record<string, string | undefined>>,
  exec: Exec,
): Promise<string | undefined> {
  const exported = env["GH_TOKEN"]?.trim() || env["GITHUB_TOKEN"]?.trim();
  if (exported) return exported;
  try {
    const { code, stdout } = await exec("gh", ["auth", "token"], env);
    return code === 0 ? stdout.trim() || undefined : undefined;
  } catch {
    // No `gh` on this Mac.
    return undefined;
  }
}

export type ReleaseAsset = { readonly name: string; readonly url: string; readonly size: number };
export type Release = { readonly version: string; readonly assets: readonly ReleaseAsset[] };

/** Reads GitHub's answer for a release. Throws unless its tag is `v<version>`. */
export function parseRelease(text: string): Release {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("GitHub's answer is not JSON.");
  }
  const { tag_name: tag, assets } = (value ?? {}) as Record<string, unknown>;
  const version = typeof tag === "string" ? tag.replace(/^v/, "") : "";
  if (typeof tag !== "string" || !tag.startsWith("v") || !parseVersion(version)) {
    throw new Error("The latest release's tag is not a version.");
  }
  const found: ReleaseAsset[] = [];
  for (const asset of Array.isArray(assets) ? (assets as unknown[]) : []) {
    const { name, url, size } = (asset ?? {}) as Record<string, unknown>;
    if (typeof name === "string" && typeof url === "string" && typeof size === "number") {
      found.push({ name, url, size });
    }
  }
  return { version, assets: found };
}

/** Assets are fetched only from the API of the repository itself, whatever a release's JSON says. */
const isAssetUrl = (url: string): boolean =>
  url.startsWith(`https://api.github.com/repos/${RELEASE_REPO}/releases/assets/`);

/** This platform's manifest in a release, or undefined when the release has no build for it. */
export function manifestAsset(
  release: Release,
  platform: string,
  arch: string,
): ReleaseAsset | undefined {
  const name = manifestName(platform, arch);
  return release.assets.find((asset) => asset.name === name && isAssetUrl(asset.url));
}

/** The archive a manifest names, once the manifest is known to be this release's and this Mac's. */
export function archiveAsset(
  release: Release,
  manifestText: string,
  platform: string,
  arch: string,
): { manifest: ReleaseManifest; asset: ReleaseAsset } {
  const manifest = parseManifest(manifestText);
  if (manifest.version !== release.version) {
    throw new Error(
      `The manifest is for ${manifest.version}, but the release is ${release.version}.`,
    );
  }
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error(`The manifest is for ${manifest.platform} ${manifest.arch}.`);
  }
  const asset = release.assets.find((each) => each.name === manifest.file && isAssetUrl(each.url));
  if (!asset) throw new Error(`Release ${release.version} has no ${manifest.file}.`);
  return { manifest, asset };
}

/** What was downloaded, against what the manifest says it must be. Undefined when they agree. */
export function downloadProblem(
  manifest: ReleaseManifest,
  got: { size: number; sha256: string },
): string | undefined {
  if (got.size !== manifest.size) {
    return `The download is ${got.size} bytes, and the release says ${manifest.size}.`;
  }
  if (got.sha256 !== manifest.sha256) return "The download does not match the release's SHA-256.";
  return undefined;
}

/** What an unpacked bundle says of itself. */
export type BundleFacts = {
  readonly identifier: string | undefined;
  readonly version: string | undefined;
  /** Whether `codesign --verify --deep` passed. */
  readonly signed: boolean;
};

/** Why an unpacked bundle may not replace the app. Undefined when it may. */
export function bundleProblem(facts: BundleFacts, version: string): string | undefined {
  if (facts.identifier !== BUNDLE_ID) {
    return `The update is another app (${facts.identifier ?? "no identifier"}, expected ${BUNDLE_ID}).`;
  }
  if (facts.version !== version) {
    return `The update says it is ${facts.version ?? "no version"}, not ${version}.`;
  }
  if (!facts.signed) return "The update's signature does not verify.";
  return undefined;
}

/** The bundle that holds an app path, when the app path is where a macOS bundle keeps it. */
export function bundleOf(appPath: string): string | undefined {
  const suffix = "/Contents/Resources/app";
  const trimmed = appPath.replace(/\/+$/, "");
  return trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : undefined;
}

/** The running app, as far as replacing it goes. */
export type RunningApp = {
  readonly bundle: string | undefined;
  readonly identifier: string | undefined;
  /** Whether the folder that holds the bundle can be written. */
  readonly folderWritable: boolean;
};

/**
 * Why the running app may not be replaced. Only this app, under its own name, is ever written over:
 * `Cycle.app` is old-cycle's.
 */
export function installRefusal(running: RunningApp): string | undefined {
  const { bundle, identifier, folderWritable } = running;
  if (!bundle) return "This app is not running from a bundle, so it cannot replace itself.";
  if (!bundle.endsWith(`/${MAC_BUNDLE}`)) {
    return `Only ${MAC_BUNDLE} is updated, and this app is at ${bundle}. Install the update by hand.`;
  }
  if (identifier !== BUNDLE_ID) {
    return `${bundle} is another app (${identifier ?? "no identifier"}, expected ${BUNDLE_ID}), so it is not replaced.`;
  }
  if (!folderWritable) {
    const folder = bundle.slice(0, -MAC_BUNDLE.length - 1) || "/";
    return `${folder} cannot be written, so the app cannot replace itself. Move it to a folder of yours.`;
  }
  return undefined;
}

/**
 * Where downloads go: `updates` in Cycle's own home. `~/.cycle` is old-cycle's, so a home that
 * points there is not used.
 */
export function updatesFolder(cycleHome: string | undefined, userHome: string): string {
  const fallback = `${userHome}/.cycle-codex`;
  const home = cycleHome?.replace(/\/+$/, "");
  const usable = home && home.startsWith("/") && home !== `${userHome}/.cycle`;
  return `${usable ? home : fallback}/updates`;
}

/**
 * Runs after the app is told to quit, as a process of its own. It waits for the app to be gone,
 * moves it aside, moves the new bundle to its name, puts the old one back if that fails, and
 * opens whichever is there. Everything it acts on is an argument, never part of this text.
 */
export const SWAP_SCRIPT = `pid="$1"; current="$2"; next="$3"; previous="$4"
tries=0
while /bin/kill -0 "$pid" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 300 ]; then
    echo "The app did not quit, so nothing was replaced."
    /bin/rm -rf "$next"
    exit 1
  fi
  /bin/sleep 0.2
done
if ! /bin/mv "$current" "$previous"; then
  echo "Could not move the app aside, so nothing was replaced."
  /bin/rm -rf "$next"
  /usr/bin/open "$current"
  exit 1
fi
if /bin/mv "$next" "$current"; then
  /bin/rm -rf "$previous"
  echo "Updated."
else
  echo "Could not put the update in place, so the app was put back."
  /bin/mv "$previous" "$current"
  /bin/rm -rf "$next"
fi
/usr/bin/open "$current"
`;

export type Swap = {
  /** The new bundle, moved beside the app before it quits, so each rename stays in one folder. */
  readonly next: string;
  readonly previous: string;
  readonly command: string;
  readonly args: readonly string[];
};

/** How the running bundle is swapped for a new one. Neither hidden name ends in `.app`. */
export function swapPlan(bundle: string, pid: number): Swap {
  const folder = bundle.slice(0, bundle.lastIndexOf("/"));
  const next = `${folder}/.${MAC_BUNDLE}.updating-${pid}`;
  const previous = `${folder}/.${MAC_BUNDLE}.previous-${pid}`;
  return {
    next,
    previous,
    command: "/bin/sh",
    args: ["-c", SWAP_SCRIPT, "cycle-update", String(pid), bundle, next, previous],
  };
}

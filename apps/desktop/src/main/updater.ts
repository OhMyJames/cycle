// The app updating itself: finds a newer release on GitHub, downloads it, checks it, and swaps it in.
//
// Every outside thing is passed in (the network, the unpacking, the clock, the process), so the gate
// tests all of it against a fake release in milliseconds; main.ts passes the real ones.
//
// What it trusts, and why: the release list and the files come over HTTPS from the repository's
// own GitHub releases and from nowhere else; the archive must match the size and SHA-256 its manifest
// gives; and when the running app carries a Developer ID signature, the new one must carry the same
// team's. An app that is only ad hoc signed has no team to compare, so there the checks stop at the
// hash. The swap is made by a small script after this process has exited, because replacing the bundle
// of a running Electron app under its feet can break it.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, constants, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateState } from "@cycle/ui/api";
import {
  isNewer,
  manifestName,
  parseManifest,
  parseVersion,
  type ReleaseManifest,
  sameVersion,
} from "../shared/release.ts";
import { assembleDelta, DeltaDeclined } from "./delta.ts";
import { APP_NAME, BUILD_FILE, MAC_BUNDLE } from "./layout.ts";

export const CHECK_EVERY_MS = 60_000;
const DEADLINE_MS = 30_000;

/** The certificate the local alpha builds are signed with. */
export const ALPHA_SIGNER = "Cycle Alpha (local)";

/** Where an update comes from: a GitHub release, or the alpha repository on this machine. */
export type UpdateSource = "release" | "local";

/**
 * The alpha repository on this machine (`<CYCLE_HOME>/alpha/`): one folder per version (`+` written `_`) holding the
 * zip and a `manifest.json`. Passed in so the tests can give a fake one.
 */
export type LocalAlpha = {
  dir: string;
  /** The names in the repository's folder. */
  list: () => Promise<string[]>;
  /** The text of a file by its path under `dir`, e.g. `0.3.1-alpha.2_abc/manifest.json`. */
  read: (path: string) => Promise<string>;
  /** Copies a file under `dir` to `to`. */
  copy: (path: string, to: string) => Promise<void>;
};

export type UpdaterDeps = {
  /** What is running: its version and where it was built for. */
  current: {
    version: string;
    baseVersion?: string;
    platform: string;
    arch: string;
  };
  /** The installed bundle, `/Applications/Cycle.app`. */
  appPath: string;
  /** `owner/name`. */
  repo: string;
  /** Default `https://api.github.com`. */
  apiBase?: string;
  /** The only place an archive or manifest may be downloaded from. */
  assetPrefix?: string;
  fetch: typeof fetch;
  /** Unpacks a zip made by `ditto -c -k` into a folder. */
  extract: (zip: string, into: string) => Promise<void>;
  /** Throws unless the new bundle may replace this one (the same signing team, when there is one; for a local alpha, the alpha certificate). */
  verifyBundle?: (newApp: string, currentApp: string, source: UpdateSource) => Promise<void>;
  /** The alpha repository on this machine, when there is one. */
  localAlpha?: LocalAlpha | undefined;
  /** Stops the local daemon and starts the script that swaps the bundles once this process has exited. */
  handOff: (swap: Swap) => Promise<void>;
  /** Closes the app. */
  quit: () => void;
  emit: (state: UpdateState) => void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** Why updating is off (not an installed app); there is then nothing to check. */
  disabled?: string | undefined;
  /** How long GitHub may take to answer a request, in ms; for what is small (the list, a manifest), to send all of it. Default 30 s. */
  deadlineMs?: number;
  /** Updating by the difference when the release allows it. On unless this is false. */
  delta?: boolean;
  /** Where the updater says what it did that the user does not need to see (a difference that fell back). */
  log?: (message: string) => void;
};

export type Swap = { appPath: string; newApp: string; oldApp: string; staging: string };

type Pending = {
  version: string;
  source: UpdateSource;
  manifest: ReleaseManifest;
  /** Of a release: where the archive is. */
  archiveUrl?: string | undefined;
  /** Of a local alpha: the zip's path under the repository. */
  archivePath?: string | undefined;
  commit?: string | undefined;
  subject?: string | undefined;
  /** The block pack's address, where the release has one its manifest lists. */
  packUrl?: string | undefined;
};
type Candidate = { tag: string; version: string; assets: Map<string, string> };

class Limited extends Error {}

/** Where the update is unpacked, beside the app so that the swap is a rename on the same volume. */
const stagingOf = (appPath: string, version: string): string =>
  join(dirname(appPath), `.${APP_NAME}-update-${version}`);
const oldOf = (appPath: string): string => join(dirname(appPath), `.${APP_NAME}-old`);

/** The script that puts the new bundle in place once the old app has quit, and opens it. */
export const SWAP_SCRIPT = `
pid=$1; app=$2; new=$3; old=$4; staging=$5; opener=$6
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1)); [ "$n" -gt 150 ] && break
  sleep 0.2
done
rm -rf "$old"
if mv "$app" "$old"; then
  if mv "$new" "$app"; then
    rm -rf "$old" "$staging"
  else
    mv "$old" "$app"
  fi
fi
exec "$opener" -n "$app"
`;

export class Updater {
  readonly #d: UpdaterDeps;
  #state: UpdateState;
  #etag: string | undefined;
  #candidate: Candidate | undefined;
  #pending: Pending | undefined;
  #busy = false;
  #installFailed = false;
  #timer: unknown;

  constructor(deps: UpdaterDeps) {
    this.#d = deps;
    this.#state =
      deps.disabled !== undefined
        ? { current: deps.current.version, kind: "disabled", reason: deps.disabled }
        : { current: deps.current.version, kind: "idle" };
  }

  get state(): UpdateState {
    return this.#state;
  }

  #set(state: UpdateState): void {
    this.#state = state;
    this.#d.emit(state);
  }

  #at = (): number => (this.#d.now ?? Date.now)();

  /** Checks now, and then on a timer. */
  start(everyMs = CHECK_EVERY_MS): void {
    if (this.#d.disabled !== undefined) return;
    void this.check(false);
    this.#timer = (this.#d.setInterval ?? setInterval)(() => void this.check(false), everyMs);
  }

  stop(): void {
    if (this.#timer !== undefined) (this.#d.clearInterval ?? clearInterval)(this.#timer as never);
    this.#timer = undefined;
  }

  /**
   * Asks GitHub. A check the user asked for shows that it is working and what went wrong; one on the
   * timer is quiet about a network that is down or a limit that was reached, since it comes every minute.
   */
  async check(manual: boolean): Promise<UpdateState> {
    if (this.#d.disabled !== undefined || this.#busy) return this.#state;
    if (!manual && this.#installFailed) return this.#state;
    this.#busy = true;
    this.#installFailed = false;
    if (manual) this.#set({ current: this.#d.current.version, kind: "checking" });
    try {
      const found = await this.#find();
      this.#pending = found;
      this.#set(
        found !== undefined
          ? {
              current: this.#d.current.version,
              kind: "available",
              version: found.version,
              source: found.source,
              ...(found.commit !== undefined ? { commit: found.commit } : {}),
              ...(found.subject !== undefined ? { subject: found.subject } : {}),
            }
          : { current: this.#d.current.version, kind: "up-to-date", checkedAt: this.#at() },
      );
    } catch (error) {
      if (manual) {
        this.#set({
          current: this.#d.current.version,
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } else if (this.#state.kind === "checking") {
        this.#set({ current: this.#d.current.version, kind: "idle" });
      }
    } finally {
      this.#busy = false;
    }
    return this.#state;
  }

  /**
   * One request, with a deadline: GitHub not answering ends the check or the install with an error, and does not
   * hold `#busy` for ever. For what is small (`small`: the list, a manifest) the deadline is for all of the answer,
   * which is read here. For an archive, or a range of one, it is for the answer to begin and then for each wait
   * for more of the body: how long it takes in all is the line's, how long it goes quiet is not.
   */
  async #get(
    url: string,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
    small = false,
  ): Promise<Response> {
    const ms = this.#d.deadlineMs ?? DEADLINE_MS;
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => deadline.abort(new Error(`GitHub did not answer in ${ms / 1000} seconds.`)),
        ms,
      );
    };
    arm();
    let handedOver = false;
    try {
      const response = await this.#d.fetch(url, {
        headers: { "user-agent": "Cycle-updater", ...headers },
        redirect: "follow",
        signal: AbortSignal.any(
          signal === undefined ? [deadline.signal] : [deadline.signal, signal],
        ),
      });
      if (response.status === 403 || response.status === 429)
        throw new Limited("GitHub is limiting requests from this network. Try again in a while.");
      if (small) {
        const body = [204, 205, 304].includes(response.status)
          ? null
          : await response.arrayBuffer();
        return new Response(body, { status: response.status, headers: response.headers });
      }
      if (response.body === null) return response;
      // The body is handed on, and goes on being watched: each wait for the next piece has its deadline.
      const reader = response.body.getReader();
      const watched = new ReadableStream<Uint8Array>({
        async pull(controller) {
          arm();
          try {
            const { done, value } = await reader.read();
            if (done) {
              clearTimeout(timer);
              controller.close();
            } else controller.enqueue(value);
          } catch (error) {
            clearTimeout(timer);
            controller.error(deadline.signal.aborted ? deadline.signal.reason : error);
          }
        },
        cancel(reason) {
          clearTimeout(timer);
          return reader.cancel(reason);
        },
      });
      handedOver = true;
      return new Response(watched, { status: response.status, headers: response.headers });
    } catch (error) {
      throw deadline.signal.aborted ? deadline.signal.reason : error;
    } finally {
      if (!handedOver) clearTimeout(timer);
    }
  }

  /**
   * The newest update from GitHub and from the local alpha repository, whichever is newer. One side failing
   * does not hide the other's; when both fail, GitHub's error is the one said.
   */
  async #find(): Promise<Pending | undefined> {
    if (this.#d.localAlpha === undefined) return this.#findRelease();
    const [release, local] = await Promise.allSettled([this.#findRelease(), this.#findLocal()]);
    if (local.status === "rejected")
      this.#d.log?.(`The local alpha repository could not be read (${errorText(local.reason)}).`);
    const alpha = local.status === "fulfilled" ? local.value : undefined;
    if (release.status === "rejected") {
      if (alpha === undefined) throw release.reason;
      return alpha;
    }
    const found = release.value;
    if (found === undefined) return alpha;
    if (alpha === undefined) return found;
    return isNewer(alpha.version, found.version) ? alpha : found;
  }

  /** The newest alpha in the local repository that differs from, and is not older than, this app. */
  async #findLocal(): Promise<Pending | undefined> {
    const local = this.#d.localAlpha;
    if (local === undefined) return undefined;
    const { platform, arch, version: running } = this.#d.current;
    const runningMeta = parseVersion(running)?.meta ?? "";
    let best: { pending: Pending; builtAt: number } | undefined;
    for (const name of await local.list()) {
      // Half-written builds are in `.partial` folders; nothing that starts with a dot or ends in it is read.
      if (name.startsWith(".") || name.endsWith(".partial")) continue;
      try {
        const text = await local.read(`${name}/manifest.json`);
        const manifest = parseManifest(text);
        const extra = JSON.parse(text) as Record<string, unknown>;
        if (manifest.platform !== platform || manifest.arch !== arch) continue;
        if (name !== manifest.version.replaceAll("+", "_")) continue;
        const newer = isNewer(manifest.version, running);
        const builtAt = typeof extra.builtAt === "string" ? Date.parse(extra.builtAt) || 0 : 0;
        // The same version made again (another `+meta`) is offered as a reinstall.
        const reinstall =
          sameVersion(manifest.version, running) &&
          (parseVersion(manifest.version)?.meta ?? "") !== runningMeta;
        if (!newer && !reinstall) continue;
        if (best !== undefined) {
          const b = best.pending.version;
          if (isNewer(b, manifest.version)) continue;
          if (sameVersion(b, manifest.version) && best.builtAt >= builtAt) continue;
        }
        best = {
          builtAt,
          pending: {
            version: manifest.version,
            source: "local",
            manifest,
            archivePath: `${name}/${manifest.file}`,
            commit: typeof extra.commit === "string" ? extra.commit : undefined,
            subject: typeof extra.subject === "string" ? extra.subject : undefined,
          },
        };
      } catch (error) {
        // One bad folder does not hide the others.
        this.#d.log?.(`Skipped ${name} in the local alpha repository (${errorText(error)}).`);
      }
    }
    return best?.pending;
  }

  /** The newest release that is newer than this app and has what this platform needs. */
  async #findRelease(): Promise<Pending | undefined> {
    const api = this.#d.apiBase ?? "https://api.github.com";
    const response = await this.#get(
      `${api}/repos/${this.#d.repo}/releases?per_page=20`,
      {
        accept: "application/vnd.github+json",
        ...(this.#etag !== undefined ? { "if-none-match": this.#etag } : {}),
      },
      undefined,
      true,
    );
    if (response.status !== 304) {
      if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
      this.#etag = response.headers.get("etag") ?? undefined;
      this.#candidate = this.#choose(await response.json());
    }
    const candidate = this.#candidate;
    if (candidate === undefined) return undefined;
    if (this.#pending?.version === candidate.version) return this.#pending;
    return this.#resolve(candidate);
  }

  #choose(releases: unknown): Candidate | undefined {
    if (!Array.isArray(releases)) throw new Error("GitHub's release list is not a list.");
    const wanted = manifestName(this.#d.current.platform, this.#d.current.arch);
    let best: Candidate | undefined;
    for (const release of releases as Record<string, unknown>[]) {
      const tag = release.tag_name;
      if (release.draft === true || typeof tag !== "string" || !tag.startsWith("v")) continue;
      const version = tag.slice(1);
      // Only releases update the app from GitHub; a tag with `-` (a pre-release) is not one.
      if (version.includes("-")) continue;
      if (!parseVersion(version) || !isNewer(version, this.#d.current.version)) continue;
      if (best !== undefined && !isNewer(version, best.version)) continue;
      const assets = new Map<string, string>();
      for (const asset of (release.assets as Record<string, unknown>[] | undefined) ?? []) {
        if (typeof asset.name === "string" && typeof asset.browser_download_url === "string")
          assets.set(asset.name, asset.browser_download_url);
      }
      if (assets.has(wanted)) best = { tag, version, assets };
    }
    return best;
  }

  #allowed(url: string): string {
    const prefix = this.#d.assetPrefix ?? `https://github.com/${this.#d.repo}/releases/download/`;
    if (!url.startsWith(prefix)) throw new Error(`Refused to download from ${url}.`);
    return url;
  }

  async #resolve(candidate: Candidate): Promise<Pending> {
    const { platform, arch } = this.#d.current;
    const manifestUrl = this.#allowed(candidate.assets.get(manifestName(platform, arch)) ?? "");
    const response = await this.#get(manifestUrl, {}, undefined, true);
    if (!response.ok)
      throw new Error(`The release's manifest could not be read (${response.status}).`);
    const manifest = parseManifest(await response.text());
    if (
      manifest.version !== candidate.version ||
      manifest.platform !== platform ||
      manifest.arch !== arch
    )
      throw new Error("The release's manifest is not for this release and platform.");
    const archiveUrl = candidate.assets.get(manifest.file);
    if (archiveUrl === undefined) throw new Error(`The release has no ${manifest.file}.`);
    // A pack the release does not carry, or carries from elsewhere, costs the saving, not the update.
    let packUrl: string | undefined;
    if (manifest.pack !== undefined) {
      const url = candidate.assets.get(manifest.pack.file);
      try {
        if (url === undefined) throw new Error(`The release has no ${manifest.pack.file}.`);
        packUrl = this.#allowed(url);
      } catch (error) {
        this.#d.log?.(
          `The release's block pack is not usable (${(error as Error).message}); changed files are fetched whole.`,
        );
      }
    }
    return {
      version: candidate.version,
      source: "release",
      manifest,
      archiveUrl: this.#allowed(archiveUrl),
      packUrl,
    };
  }

  /** Downloads, checks, unpacks, and hands the swap over; the app closes when this is done. */
  async install(): Promise<void> {
    const pending = this.#pending;
    if (this.#d.disabled !== undefined) throw new Error(this.#d.disabled);
    if (pending === undefined || this.#busy) throw new Error("There is no update to install.");
    this.#busy = true;
    const current = this.#d.current.version;
    const staging = stagingOf(this.#d.appPath, pending.version);
    try {
      await this.#preflight();
      const newApp = await this.#obtain(pending, staging);
      await this.#d.handOff({
        appPath: this.#d.appPath,
        newApp,
        oldApp: oldOf(this.#d.appPath),
        staging,
      });
      this.#d.quit();
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      this.#installFailed = true;
      this.#set({
        current,
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
        version: pending.version,
      });
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  /**
   * The new bundle, checked, in the staging folder. By the difference when the release has a file table
   * (the installed files are reused, only the changed ones are fetched); if that cannot be done, or what
   * it makes does not pass the checks, once more from the whole archive.
   */
  async #obtain(pending: Pending, staging: string): Promise<string> {
    const { manifest } = pending;
    const log = this.#d.log ?? (() => {});
    const fresh = async () => {
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
    };
    const check = async (newApp: string) => {
      await this.#checkBundle(newApp, manifest);
      await this.#d.verifyBundle?.(newApp, this.#d.appPath, pending.source);
      return newApp;
    };
    if (pending.source === "local") {
      await fresh();
      const zip = join(staging, "update.zip");
      await this.#copyLocal(pending, zip);
      this.#set({ current: this.#d.current.version, kind: "installing", version: pending.version });
      const unpacked = join(staging, "unpacked");
      await this.#d.extract(zip, unpacked);
      return check(join(unpacked, MAC_BUNDLE));
    }
    if (manifest.treeProblem !== undefined)
      log(
        `The release's file table is not usable (${manifest.treeProblem}); downloading it whole.`,
      );
    if (manifest.packProblem !== undefined)
      log(
        `The release's block pack is not usable (${manifest.packProblem}); changed files are fetched whole.`,
      );
    if (
      manifest.tree !== undefined &&
      this.#d.delta !== false &&
      pending.archiveUrl !== undefined
    ) {
      await fresh();
      try {
        return await check(
          await this.#byDifference(pending, pending.archiveUrl, manifest.tree, staging),
        );
      } catch (error) {
        // What would stop the whole download as well is not a reason to start it: a limit on requests
        // from this network, or a disk with no room.
        if (error instanceof Limited || (error as NodeJS.ErrnoException)?.code === "ENOSPC")
          throw error;
        const reason = error instanceof Error ? error.message : String(error);
        log(
          error instanceof DeltaDeclined
            ? `Downloading the whole update: ${reason}.`
            : `Updating by the difference failed (${reason}); downloading the whole update.`,
        );
      }
    }
    await fresh();
    const zip = join(staging, "update.zip");
    await this.#download(pending, zip);
    this.#set({ current: this.#d.current.version, kind: "installing", version: pending.version });
    const unpacked = join(staging, "unpacked");
    await this.#d.extract(zip, unpacked);
    return check(join(unpacked, MAC_BUNDLE));
  }

  async #byDifference(
    pending: Pending,
    archiveUrl: string,
    tree: NonNullable<ReleaseManifest["tree"]>,
    staging: string,
  ): Promise<string> {
    const current = this.#d.current.version;
    const { version } = pending;
    const progress = this.#progress(pending, "difference");
    // Comparing the installed files takes some seconds before there is anything to count.
    this.#set({ current, kind: "installing", version });
    const done = await assembleDelta({
      installed: this.#d.appPath,
      into: join(staging, "unpacked"),
      archiveUrl,
      archiveSize: pending.manifest.size,
      tree,
      pack:
        pending.manifest.pack !== undefined && pending.packUrl !== undefined
          ? { ...pending.manifest.pack, url: pending.packUrl }
          : undefined,
      get: (url, headers, signal) => this.#get(url, headers, signal),
      onPlan: (total) => progress(0, total, true),
      onProgress: (received, total) => progress(received, total, false),
      log: this.#d.log,
    });
    this.#set({ current, kind: "installing", version });
    this.#d.log?.(
      `Updated by the difference: fetched ${done.fetched} of ${pending.manifest.size} bytes, ${done.changed} files changed, ${done.reused} reused; ${done.byBlocks} made by their blocks, ${done.blocksReused} blocks reused.`,
    );
    return done.app;
  }

  /** Reports the download's progress, at most four times a second. */
  #progress(pending: Pending, how: "difference" | "whole") {
    const current = this.#d.current.version;
    let announced = 0;
    return (received: number, total: number, force: boolean): void => {
      const now = this.#at();
      if (!force && now - announced < 250) return;
      announced = now;
      this.#set({ current, kind: "downloading", version: pending.version, received, total, how });
    };
  }

  async #preflight(): Promise<void> {
    const { appPath } = this.#d;
    if (appPath.includes("/AppTranslocation/"))
      throw new Error(
        "Cycle is running from a temporary read-only copy, which happens when it is opened straight from a download. Move Cycle.app to Applications, open it from there, and try again.",
      );
    try {
      await access(dirname(appPath), constants.W_OK);
    } catch {
      throw new Error(
        `Cycle cannot replace itself: you cannot write to ${dirname(appPath)}. Move Cycle.app to a folder you own (such as ~/Applications) and try again.`,
      );
    }
  }

  async #download(pending: Pending, to: string): Promise<void> {
    const { manifest } = pending;
    if (pending.archiveUrl === undefined) throw new Error("The update has no address.");
    const response = await this.#get(pending.archiveUrl);
    if (!response.ok || response.body === null)
      throw new Error(`The update could not be downloaded (${response.status}).`);
    const hash = createHash("sha256");
    let received = 0;
    const report = this.#progress(pending, "whole");
    const emit = (force: boolean) => report(received, manifest.size, force);
    emit(true);
    await pipeline(
      Readable.fromWeb(response.body as never),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          received += chunk.length;
          if (received > manifest.size)
            throw new Error("The update is larger than its manifest says.");
          hash.update(chunk);
          emit(false);
          yield chunk;
        }
      },
      createWriteStream(to),
    );
    emit(true);
    if (received !== manifest.size) throw new Error("The update arrived incomplete.");
    if (hash.digest("hex") !== manifest.sha256)
      throw new Error("The update does not match its checksum, so it was not installed.");
  }

  /** Copies the local alpha's zip to staging, and checks its size and SHA-256 against the manifest. */
  async #copyLocal(pending: Pending, to: string): Promise<void> {
    const local = this.#d.localAlpha;
    if (local === undefined || pending.archivePath === undefined)
      throw new Error("There is no local alpha repository.");
    const { manifest } = pending;
    await local.copy(pending.archivePath, to);
    if ((await stat(to)).size !== manifest.size)
      throw new Error(
        "The local alpha's size does not match its manifest, so it was not installed.",
      );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(to)) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== manifest.sha256)
      throw new Error("The local alpha does not match its checksum, so it was not installed.");
  }

  async #checkBundle(newApp: string, manifest: ReleaseManifest): Promise<void> {
    let info: Record<string, unknown>;
    try {
      info = JSON.parse(await readFile(join(newApp, "Contents/Resources/app", BUILD_FILE), "utf8"));
    } catch {
      throw new Error(`The update does not contain ${basename(newApp)} as expected.`);
    }
    if (
      info.version !== manifest.version ||
      info.platform !== manifest.platform ||
      info.arch !== manifest.arch
    )
      throw new Error("The update is not the version and platform its manifest names.");
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The team a `codesign -dv` listing names, or undefined for an ad hoc signature or none. */
export const teamOf = (listing: string): string | undefined => {
  const match = /^TeamIdentifier=(\S+)$/m.exec(listing);
  return match && match[1] !== "not" ? match[1] : undefined;
};

/** The check `verifyBundle` makes, with the way to run `codesign` passed in. */
export const verifySameTeam =
  (codesign: (args: string[]) => Promise<string>) =>
  async (newApp: string, currentApp: string): Promise<void> => {
    const team = teamOf(await codesign(["-dv", "--verbose=4", currentApp]).catch(() => ""));
    if (team === undefined) return;
    await codesign(["--verify", "--deep", "--strict", newApp]).catch(() => {
      throw new Error("The update's signature is not valid, so it was not installed.");
    });
    if (teamOf(await codesign(["-dv", "--verbose=4", newApp]).catch(() => "")) !== team)
      throw new Error(
        "The update is not signed by the same team as this app, so it was not installed.",
      );
  };

/**
 * The check for a local alpha: the signature is valid and the certificate that made it is the alpha one. There is no
 * team to compare, since a self-signed certificate has none.
 */
export const verifyLocalAlpha =
  (codesign: (args: string[]) => Promise<string>) =>
  async (newApp: string): Promise<void> => {
    await codesign(["--verify", "--deep", "--strict", newApp]).catch(() => {
      throw new Error("The update's signature is not valid, so it was not installed.");
    });
    const listing = await codesign(["-dv", "--verbose=4", newApp]).catch(() => "");
    // The first `Authority` is the certificate that signed; the ones after it are what vouches for that.
    if (/^Authority=(.+)$/m.exec(listing)?.[1] !== ALPHA_SIGNER)
      throw new Error(
        `The update is not signed with the "${ALPHA_SIGNER}" certificate, so it was not installed.`,
      );
  };

/** What `verifyBundle` is: by where the update came from. */
export const verifyBySource = (codesign: (args: string[]) => Promise<string>) => {
  const team = verifySameTeam(codesign);
  const alpha = verifyLocalAlpha(codesign);
  return (newApp: string, currentApp: string, source: UpdateSource): Promise<void> =>
    source === "local" ? alpha(newApp) : team(newApp, currentApp);
};

/** Leftovers of an update that was interrupted, removed at the start of the next run. */
export const cleanStale = async (appPath: string): Promise<void> => {
  const parent = dirname(appPath);
  const prefix = `.${APP_NAME}-`;
  for (const name of await readdir(parent).catch(() => [] as string[])) {
    if (name.startsWith(`${prefix}update-`) || name === basename(oldOf(appPath)))
      await rm(join(parent, name), { recursive: true, force: true }).catch(() => {});
  }
};

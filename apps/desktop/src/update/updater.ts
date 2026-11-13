// The app's own updates, from the GitHub releases of its repository: what is checked, in which
// order, and what state the page is shown. Everything it touches comes in as a port.
//
// shortcut: an update is trusted because GitHub served it over TLS and its archive matches the hash
// in the same release's manifest, with no signing key of Cycle's own and no notarization, so whoever
// can publish a release there can replace the app; upgrade when anyone but the owner can publish
// releases, or when the app is given to someone else.
import { isNewer } from "../shared/release";
import type { UpdateState } from "../shared/update-state";
import {
  type BundleFacts,
  type Headers,
  LATEST_RELEASE_URL,
  type Release,
  type RunningApp,
  archiveAsset,
  assetHeaders,
  bundleProblem,
  downloadProblem,
  installRefusal,
  manifestAsset,
  parseRelease,
  releaseHeaders,
} from "./plan";

export type UpdatePorts = {
  /** The running app's version, platform and architecture. */
  readonly current: string;
  readonly platform: string;
  readonly arch: string;
  now(): number;
  /** The owner's GitHub token, if they have one. It is passed on in request headers only. */
  token(): Promise<string | undefined>;
  /** A small answer, whole. */
  get(url: string, headers: Headers): Promise<{ status: number; text: string }>;
  /** Fetches a version's archive into the updates folder, and says what arrived. */
  download(
    version: string,
    url: string,
    headers: Headers,
    onProgress: (received: number) => void,
  ): Promise<{ status: number; size: number; sha256: string }>;
  /** Unpacks a version's archive and says what the bundle in it is. */
  unpack(version: string): Promise<BundleFacts>;
  /** What an already unpacked bundle of a version is, or undefined when there is none. */
  inspect(version: string): Promise<BundleFacts | undefined>;
  /** Removes every download but those of the versions named. */
  clean(keep: readonly string[]): Promise<void>;
  running(): Promise<RunningApp>;
  /** Hands over to the swap helper and quits the app. */
  swap(version: string): Promise<void>;
  onState(state: UpdateState): void;
};

export type Updater = {
  state(): UpdateState;
  /** Looks for a newer release and downloads it. Does nothing while one check is under way. */
  check(): Promise<void>;
  /** Replaces the app with the downloaded update, only ever because the owner asked. */
  install(): Promise<void>;
};

type Status = UpdateState extends infer S
  ? S extends unknown
    ? Omit<S, "current">
    : never
  : never;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createUpdater(ports: UpdatePorts): Updater {
  const { current, platform, arch } = ports;
  let state: UpdateState = { current, status: "idle" };
  let busy = false;

  const set = (next: Status): void => {
    state = { current, ...next } as UpdateState;
    ports.onState(state);
  };

  /** The latest release when it is newer than `than`. */
  async function newerRelease(
    than: string,
    token: string | undefined,
  ): Promise<Release | undefined> {
    const answer = await ports.get(LATEST_RELEASE_URL, releaseHeaders(token));
    if (answer.status === 404) {
      // A repository with no release yet says the same as a private one does to a stranger.
      if (token) return undefined;
      throw new Error(
        "No release was found. While the repository is private, sign in with `gh auth login` or export GH_TOKEN in your shell profile.",
      );
    }
    if (answer.status === 401) throw new Error("GitHub refused the token it was given.");
    if (answer.status !== 200) throw new Error(`GitHub answered ${answer.status}.`);
    const release = parseRelease(answer.text);
    return isNewer(release.version, than) ? release : undefined;
  }

  async function fetchRelease(release: Release, token: string | undefined): Promise<void> {
    const { version } = release;
    const listed = manifestAsset(release, platform, arch);
    if (!listed) throw new Error(`Release ${version} has no build for ${platform} ${arch}.`);
    const answer = await ports.get(listed.url, assetHeaders(token));
    if (answer.status !== 200) {
      throw new Error(`GitHub answered ${answer.status} for the manifest.`);
    }
    const { manifest, asset } = archiveAsset(release, answer.text, platform, arch);

    let lastPercent = -1;
    set({ status: "downloading", version, progress: 0 });
    const got = await ports.download(version, asset.url, assetHeaders(token), (received) => {
      const percent = Math.min(100, Math.floor((received / manifest.size) * 100));
      if (percent === lastPercent) return;
      lastPercent = percent;
      set({ status: "downloading", version, progress: percent / 100 });
    });
    if (got.status !== 200) throw new Error(`GitHub answered ${got.status} for the download.`);
    const problem =
      downloadProblem(manifest, got) ?? bundleProblem(await ports.unpack(version), version);
    if (problem) throw new Error(problem);
  }

  async function check(): Promise<void> {
    if (busy) return;
    busy = true;
    // An update that already waits stays offered, whatever becomes of looking for a newer one.
    const staged = state.status === "ready" ? state.version : undefined;
    const kept = staged ? [staged] : [];
    try {
      if (!staged) set({ status: "checking" });
      const token = await ports.token();
      const release = await newerRelease(staged ?? current, token);
      if (!release) {
        await ports.clean(kept);
        if (!staged) set({ status: "upToDate", checkedAt: ports.now() });
        return;
      }
      const { version } = release;
      // What an earlier run of the app downloaded is used again, if it still holds.
      const earlier = await ports.inspect(version);
      if (!earlier || bundleProblem(earlier, version)) {
        await ports.clean(kept);
        await fetchRelease(release, token);
      }
      await ports.clean([version]);
      set({ status: "ready", version });
    } catch (error) {
      await ports.clean(kept).catch(() => {});
      if (staged) set({ status: "ready", version: staged });
      else set({ status: "error", message: messageOf(error) });
    } finally {
      busy = false;
    }
  }

  async function install(): Promise<void> {
    if (busy || state.status !== "ready") return;
    busy = true;
    const { version } = state;
    try {
      const refusal = installRefusal(await ports.running());
      if (refusal) {
        set({ status: "ready", version, message: refusal });
        return;
      }
      // Looked at again: it has lain on disk since it was downloaded.
      const facts = await ports.inspect(version);
      const problem = facts ? bundleProblem(facts, version) : "The downloaded update is gone.";
      if (problem) {
        await ports.clean([]).catch(() => {});
        set({ status: "error", message: problem });
        return;
      }
      await ports.swap(version);
    } catch (error) {
      set({ status: "ready", version, message: messageOf(error) });
    } finally {
      busy = false;
    }
  }

  return { state: () => state, check, install };
}

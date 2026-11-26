// Takes the newest interface bundle for this shell from the repository's `ui-latest` release: the manifest and its
// signature first, then the archive, and only what checks out at every step is installed (ui-store.ts). Everything that
// goes wrong is quiet: the bundle in use stays, and the next check tries again.
import { rm, writeFile } from "node:fs/promises";
import {
  parseManifest,
  UI_RELEASE_TAG,
  uiManifestName,
  uiSignatureName,
} from "../shared/ui-bundle.ts";
import { sha256Hex } from "./ui-crypto.ts";
import type { UiStore } from "./ui-store.ts";

export const UI_CHECK_EVERY_MS = 5 * 60_000;
const SMALL_DEADLINE_MS = 30_000;
const ARCHIVE_DEADLINE_MS = 300_000;

export type UiUpdateState = {
  /** Why bundles are not taken at all (no key in the app, a run from source), when that is so. */
  disabled?: string;
  /** The newest bundle on this computer: in use after the next start or reload. */
  installed?: number;
  /** What the last check could not do, in words. Cleared by the next one that can. */
  error?: string;
};

export type UiUpdaterDeps = {
  store: UiStore;
  /** This app's shell (build.json), and so which bundles it may take. */
  shell: string | undefined;
  /** Whether any public key is built into the app. */
  hasKeys: boolean;
  verify: (bytes: Uint8Array, signature: string, keyId: string) => boolean;
  repo: string;
  /** Replaces `https://github.com/<repo>/releases/download/ui-latest/`; for the tests, a loopback address. */
  baseUrl?: string;
  fetch: typeof fetch;
  /** Unpacks a zip made by `ditto -c -k` into a folder. */
  extract: (zip: string, into: string) => Promise<void>;
  /** The version of the page the app was built with. */
  bundledVersion: number;
  /** True while a whole-app update is waiting: it carries the newest page, so a bundle is not taken meanwhile. */
  holdOff?: () => boolean;
  emit: (state: UiUpdateState) => void;
  log?: (message: string) => void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export class UiUpdater {
  readonly #d: UiUpdaterDeps;
  #state: UiUpdateState;
  #etag: string | undefined;
  #busy = false;
  #timer: unknown;

  constructor(deps: UiUpdaterDeps) {
    this.#d = deps;
    const disabled = !deps.hasKeys
      ? "This build takes no interface updates."
      : deps.shell === undefined
        ? "This is not an installed app."
        : undefined;
    this.#state = disabled !== undefined ? { disabled } : {};
  }

  get state(): UiUpdateState {
    return this.#state;
  }

  #set(state: UiUpdateState): void {
    const same = JSON.stringify(state) === JSON.stringify(this.#state);
    this.#state = state;
    if (!same) this.#d.emit(state);
  }

  #log = (message: string) => (this.#d.log ?? (() => {}))(message);

  start(everyMs = UI_CHECK_EVERY_MS): void {
    if (this.#state.disabled !== undefined) return;
    void this.check();
    this.#timer = (this.#d.setInterval ?? setInterval)(() => void this.check(), everyMs);
  }

  stop(): void {
    if (this.#timer !== undefined) (this.#d.clearInterval ?? clearInterval)(this.#timer as never);
    this.#timer = undefined;
  }

  /** Records that this version is on disk, whoever put it there (the state of the store, read at start). */
  noteInstalled(uiVersion: number | undefined): void {
    if (this.#state.disabled !== undefined) return;
    this.#set({ ...(uiVersion !== undefined ? { installed: uiVersion } : {}) });
  }

  async #get(url: string, headers: Record<string, string>, ms: number): Promise<Response> {
    return this.#d.fetch(url, { headers, signal: AbortSignal.timeout(ms), redirect: "follow" });
  }

  async check(): Promise<UiUpdateState> {
    const { shell } = this.#d;
    if (this.#state.disabled !== undefined || shell === undefined || this.#busy) return this.#state;
    if (this.#d.holdOff?.() === true) return this.#state;
    this.#busy = true;
    const keep = (error?: string): UiUpdateState => {
      this.#set({
        ...(this.#state.installed !== undefined ? { installed: this.#state.installed } : {}),
        ...(error !== undefined ? { error } : {}),
      });
      return this.#state;
    };
    try {
      const base =
        this.#d.baseUrl ??
        `https://github.com/${this.#d.repo}/releases/download/${UI_RELEASE_TAG}/`;
      const manifestResponse = await this.#get(
        `${base}${uiManifestName(shell)}`,
        this.#etag !== undefined ? { "If-None-Match": this.#etag } : {},
        SMALL_DEADLINE_MS,
      );
      if (manifestResponse.status === 404 || manifestResponse.status === 304) return keep();
      if (!manifestResponse.ok)
        throw new Error(`The interface manifest answered ${manifestResponse.status}.`);
      const etag = manifestResponse.headers.get("etag") ?? undefined;
      const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
      const sigResponse = await this.#get(
        `${base}${uiSignatureName(shell)}`,
        {},
        SMALL_DEADLINE_MS,
      );
      if (!sigResponse.ok)
        throw new Error(`The interface signature answered ${sigResponse.status}.`);
      const signature = await sigResponse.text();

      // What follows does not change by asking again, so the manifest is not fetched again until it changes.
      const settled = (message: string): UiUpdateState => {
        this.#etag = etag;
        this.#log(message);
        return keep();
      };
      const manifest = parseManifest(manifestBytes);
      if (manifest === undefined) return settled("The interface manifest is not valid.");
      if (!this.#d.verify(manifestBytes, signature, manifest.keyId))
        return settled("The interface manifest's signature does not hold.");
      if (manifest.shell !== shell) return settled("The interface bundle is for another shell.");
      const known = await this.#d.store.readState();
      if (manifest.uiVersion <= Math.max(known.floor, this.#d.bundledVersion)) {
        this.#etag = etag;
        return keep();
      }

      const archive = await this.#get(`${base}${manifest.file}`, {}, ARCHIVE_DEADLINE_MS);
      if (!archive.ok) throw new Error(`The interface archive answered ${archive.status}.`);
      const bytes = new Uint8Array(await archive.arrayBuffer());
      if (bytes.length !== manifest.size || sha256Hex(bytes) !== manifest.sha256)
        throw new Error("The interface archive is not what the manifest says.");

      const staging = await this.#d.store.newStaging(manifest.uiVersion);
      const zip = `${staging}.zip`;
      try {
        await writeFile(zip, bytes);
        await this.#d.extract(zip, staging);
        const result = await this.#d.store.install(staging, manifestBytes, signature);
        if (!result.ok) {
          await rm(staging, { recursive: true, force: true });
          const message = `The interface bundle was refused: ${result.reason}`;
          if (result.transient === true) {
            this.#log(message);
            return keep();
          }
          return settled(message);
        }
        this.#etag = etag;
        this.#log(`Interface ${result.uiVersion} is ready.`);
        this.#set({ installed: result.uiVersion });
      } finally {
        await rm(zip, { force: true });
        await rm(staging, { recursive: true, force: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log(`Interface update: ${message}`);
      keep(message);
    } finally {
      this.#busy = false;
    }
    return this.#state;
  }
}

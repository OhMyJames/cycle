// The interface bundles on this computer: `<root>/<uiVersion>/` for each one taken, and `<root>/state.json` for which is
// in use. A bundle is a folder of the page's files and the manifest and signature it came with; it is checked again each
// time it is chosen, so what runs is what was signed, whatever happened to the disk since (shared/ui-bundle.ts).
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest, type UiManifest } from "../shared/ui-bundle.ts";
import { sha256Hex } from "./ui-crypto.ts";

export const MANIFEST_FILE = "manifest.json";
export const SIGNATURE_FILE = "manifest.sig";

export type UiState = {
  /** In use next: the folder `<root>/<current>`. */
  current?: number;
  /** The one before it, to fall back to. */
  previous?: number;
  /** The highest version seen, so an older signed bundle cannot be put back. */
  floor: number;
  /** Bundles that did not start or did not check out; never chosen again. */
  bad: number[];
};

export type Page = { kind: "bundled" } | { kind: "ui"; uiVersion: number; dir: string };

/** `transient`: the disk failed, not the bundle: asking again may work. */
export type InstallResult =
  | { ok: true; uiVersion: number }
  | { ok: false; reason: string; transient?: true };

export type UiStoreDeps = {
  root: string;
  /** Whether this signature of these bytes is by a key the app trusts. */
  verify: (bytes: Uint8Array, signature: string, keyId: string) => boolean;
  /** The version of the page the app was built with: nothing at or below it is taken. */
  bundledVersion: number;
  /** The shell of this app: a bundle made for another shell (an older app's) is not used. Unset: not checked. */
  shell?: string;
  now?: () => number;
  log?: (message: string) => void;
};

const STAGING_PREFIX = ".staging-";
const STAGING_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_BAD = 20;

export const createUiStore = (deps: UiStoreDeps) => {
  const { root, verify } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const statePath = join(root, "state.json");
  // The bundle the window is showing: its folder is not removed under it, whatever is installed meanwhile.
  let inUse: () => number | undefined = () => undefined;

  const readState = async (): Promise<UiState> => {
    try {
      const raw = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
      const version = (x: unknown) =>
        typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : undefined;
      const current = version(raw.current);
      const previous = version(raw.previous);
      return {
        ...(current !== undefined ? { current } : {}),
        ...(previous !== undefined ? { previous } : {}),
        floor: version(raw.floor) ?? 0,
        bad: Array.isArray(raw.bad) ? raw.bad.flatMap((x) => version(x) ?? []) : [],
      };
    } catch {
      return { floor: 0, bad: [] };
    }
  };

  const writeState = async (state: UiState): Promise<void> => {
    await mkdir(root, { recursive: true });
    const tmp = `${statePath}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state)}\n`);
    await rename(tmp, statePath);
  };

  /** Every file under `dir` by relative path; a link or anything else that is not a plain file or folder is an error. */
  const listFiles = async (dir: string, prefix = ""): Promise<string[]> => {
    const out: string[] = [];
    for (const name of await readdir(join(dir, prefix))) {
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const info = await lstat(join(dir, rel));
      if (info.isDirectory()) out.push(...(await listFiles(dir, rel)));
      else if (info.isFile()) out.push(rel);
      else throw new Error(`${rel} is not a plain file`);
    }
    return out;
  };

  /** The manifest of the bundle in `dir` when its signature holds and its files are exactly the ones it lists. */
  const verifyDir = async (dir: string): Promise<{ manifest: UiManifest } | { reason: string }> => {
    try {
      const bytes = await readFile(join(dir, MANIFEST_FILE));
      const signature = await readFile(join(dir, SIGNATURE_FILE), "utf8");
      const manifest = parseManifest(bytes);
      if (manifest === undefined) return { reason: "the manifest is not valid" };
      if (!verify(bytes, signature, manifest.keyId))
        return { reason: "the signature does not hold" };
      const found = (await listFiles(dir)).filter(
        (path) => path !== MANIFEST_FILE && path !== SIGNATURE_FILE,
      );
      const listed = Object.keys(manifest.files);
      if (
        found.length !== listed.length ||
        !found.every((path) => manifest.files[path] !== undefined)
      )
        return { reason: "the files are not the ones the manifest lists" };
      for (const path of listed) {
        if (sha256Hex(await readFile(join(dir, path))) !== manifest.files[path])
          return { reason: `${path} is not what was signed` };
      }
      return { manifest };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
  };

  const markBad = async (uiVersion: number): Promise<void> => {
    const state = await readState();
    let { current, previous } = state;
    if (current === uiVersion) [current, previous] = [previous, undefined];
    else if (previous === uiVersion) previous = undefined;
    await writeState({
      ...(current !== undefined ? { current } : {}),
      ...(previous !== undefined ? { previous } : {}),
      floor: state.floor,
      bad: [...new Set([...state.bad, uiVersion])].slice(-MAX_BAD),
    });
  };

  /** Where the page is loaded from: the newest bundle that checks out, else the page the app was built with. */
  const selectPage = async (): Promise<Page> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await readState();
      const candidate = [state.current, state.previous].find(
        (v): v is number => v !== undefined && !state.bad.includes(v),
      );
      if (candidate === undefined) break;
      const dir = join(root, String(candidate));
      const checked = await verifyDir(dir);
      const reason =
        "reason" in checked
          ? checked.reason
          : deps.shell !== undefined && checked.manifest.shell !== deps.shell
            ? "it is for another shell than this app's"
            : checked.manifest.uiVersion <= deps.bundledVersion
              ? "the app came with a newer page"
              : undefined;
      if (reason === undefined) {
        await cleanup().catch(() => {});
        return { kind: "ui", uiVersion: candidate, dir };
      }
      log(`interface ${candidate} is not used: ${reason}`);
      await markBad(candidate);
    }
    await cleanup().catch(() => {});
    return { kind: "bundled" };
  };

  /** Takes the bundle unpacked in `staging`, if the manifest and signature given are for exactly it. */
  const install = async (
    staging: string,
    manifestBytes: Uint8Array,
    signature: string,
  ): Promise<InstallResult> => {
    try {
      await writeFile(join(staging, MANIFEST_FILE), manifestBytes);
      await writeFile(join(staging, SIGNATURE_FILE), signature);
      const checked = await verifyDir(staging);
      if ("reason" in checked) return { ok: false, reason: checked.reason };
      const { uiVersion } = checked.manifest;
      const state = await readState();
      if (uiVersion <= Math.max(state.floor, deps.bundledVersion))
        return { ok: false, reason: `version ${uiVersion} is not newer than what was seen` };
      const target = join(root, String(uiVersion));
      await mkdir(root, { recursive: true });
      await rm(target, { recursive: true, force: true });
      await rename(staging, target);
      const keep = (v: number | undefined) =>
        v !== undefined && v !== uiVersion && !state.bad.includes(v) ? v : undefined;
      const previous = keep(state.current) ?? keep(state.previous);
      await writeState({
        current: uiVersion,
        ...(previous !== undefined ? { previous } : {}),
        floor: Math.max(state.floor, uiVersion),
        bad: state.bad.filter((v) => v !== uiVersion),
      });
      await cleanup();
      return { ok: true, uiVersion };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        transient: true,
      };
    }
  };

  /** Removes the bundles that are neither in use nor the fallback, and staging folders that were left behind. */
  const cleanup = async (): Promise<void> => {
    const state = await readState();
    const keep = new Set(
      [state.current, state.previous, inUse()].flatMap((v) => (v === undefined ? [] : [String(v)])),
    );
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const path = join(root, name);
      if (name === "state.json" || keep.has(name)) continue;
      if (name.startsWith(STAGING_PREFIX)) {
        const info = await stat(path).catch(() => undefined);
        if (info === undefined || now() - info.mtimeMs < STAGING_MAX_AGE_MS) continue;
      } else if (!/^\d+$/.test(name)) continue;
      await rm(path, { recursive: true, force: true });
    }
  };

  /** A new empty folder to unpack a bundle into. */
  const newStaging = async (uiVersion: number): Promise<string> => {
    const dir = join(root, `${STAGING_PREFIX}${uiVersion}-${process.pid}-${now()}`);
    await mkdir(dir, { recursive: true });
    return dir;
  };

  return {
    /** Says which bundle the window shows, asked again at each cleanup. */
    showing: (fn: () => number | undefined): void => {
      inUse = fn;
    },
    readState,
    selectPage,
    markBad,
    install,
    cleanup,
    newStaging,
    verifyDir,
  };
};

export type UiStore = ReturnType<typeof createUiStore>;

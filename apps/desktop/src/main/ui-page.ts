// Which page the window shows, and what happens when a page taken from outside the app does not work: it must say it
// has drawn itself within BOOT_MS, else it is marked bad and the one before it (in the end, the page the app came with,
// which is never marked) is shown. No Electron here: the window gives `load`, so the tests drive it with a fake.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { InterfaceState } from "@cycle/ui";
import type { UiStore } from "./ui-store.ts";

export const BOOT_MS = 15_000;

export type PageSwitchDeps = {
  /** Without a store the app only ever shows its own page. */
  store?: UiStore;
  /** Where the page the app came with is: `<renderer>/index.html`. */
  bundledUrl: string;
  /** The version of that page (build.json); 0 for a run from source. */
  bundledVersion: number;
  /** Shows a page in the window. Rejects when it could not be loaded. */
  load: (url: string) => Promise<void>;
  /** The newest bundle on this computer (`UiUpdater.state.installed`), if any. */
  installed: () => number | undefined;
  emit: (state: InterfaceState) => void;
  bootMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  log?: (message: string) => void;
};

export const createPageSwitch = (deps: PageSwitchDeps) => {
  // Declared first: the store asks which bundle is showing.
  const set = deps.setTimeout ?? setTimeout;
  const clear = deps.clearTimeout ?? clearTimeout;
  const log = deps.log ?? (() => {});
  let url = deps.bundledUrl;
  /** The bundle showing, or undefined for the page the app came with. */
  let running: number | undefined;
  /** What was marked bad here: not offered as ready any more, though the updater still says it is on disk. */
  const bad = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // One change of page at a time.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };

  /** Whether the page has said it is drawn, for the page being loaded now. */
  let drawn = false;
  deps.store?.showing(() => running);

  const info = (): InterfaceState => {
    const shown = running ?? deps.bundledVersion;
    const installed = deps.installed();
    return {
      bundled: deps.bundledVersion,
      running: shown,
      ...(installed !== undefined && installed > shown && !bad.has(installed)
        ? { ready: installed }
        : {}),
    };
  };

  const disarm = () => {
    if (timer !== undefined) clear(timer);
    timer = undefined;
  };

  /** Chooses the page, shows it, and (for a bundle) waits for it to say it is drawn. */
  const show = async (): Promise<void> => {
    disarm();
    drawn = false;
    const page =
      deps.store !== undefined ? await deps.store.selectPage() : ({ kind: "bundled" } as const);
    if (page.kind === "ui") {
      url = pathToFileURL(join(page.dir, "index.html")).href;
      running = page.uiVersion;
    } else {
      url = deps.bundledUrl;
      running = undefined;
    }
    deps.emit(info());
    try {
      await deps.load(url);
    } catch (error) {
      if (running === undefined) throw error;
      await fail(running, error instanceof Error ? error.message : String(error));
      return;
    }
    // The time to draw is counted from when the page has loaded, not from when it was asked for: a slow disk or a busy
    // computer at login must not make a good bundle look broken.
    if (running !== undefined && !drawn) {
      const shown = running;
      timer = set(
        () =>
          void failed(shown, "it did not say it had drawn itself in time").catch((error) =>
            log(`Interface ${shown} could not be replaced: ${String(error)}`),
          ),
        deps.bootMs ?? BOOT_MS,
      );
    }
  };

  const fail = async (uiVersion: number, reason: string): Promise<void> => {
    if (running !== uiVersion) return;
    log(`Interface ${uiVersion} is not used any more: ${reason}`);
    disarm();
    bad.add(uiVersion);
    await deps.store?.markBad(uiVersion);
    await show();
  };
  const failed = (uiVersion: number, reason: string) => serial(() => fail(uiVersion, reason));

  return {
    /** The address of the page showing: the only one that may call main, and the only one the window may navigate to. */
    url: () => url,
    state: info,
    /** The first page. */
    start: () => serial(show),
    /** The page says it has drawn itself. */
    booted: (): void => {
      drawn = true;
      disarm();
    },
    /** The page's process ended or its load failed: before it said it was drawn, that is a page that does not work. */
    broke: (reason: string): Promise<void> | undefined => {
      if (drawn || running === undefined) return undefined;
      return failed(running, reason);
    },
    /** Shows the newest page that is good, if it is not the one showing. */
    apply: () =>
      serial(async () => {
        const state = deps.store !== undefined ? await deps.store.readState() : undefined;
        if (state?.current === undefined || state.current === running) return;
        await show();
      }),
    /** Tells the page the state again (after an install). */
    refresh: (): void => deps.emit(info()),
  };
};

export type PageSwitch = ReturnType<typeof createPageSwitch>;

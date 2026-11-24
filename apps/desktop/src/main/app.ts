import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isUiEvent } from "@cycle/analytics/events";
import { commandChannel, sshChannel, sshCommand } from "@cycle/client";
import type { OidcClient } from "@cycle/oidc";
import { resolveLanguage, type Translator, translatorFor, type UpdateState } from "@cycle/ui";
import {
  API_METHODS,
  type AppEvent,
  channel,
  EVENT_CHANNEL,
  type LocationConfig,
} from "@cycle/ui/api";
import {
  app,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
} from "electron";
import { shellQuote } from "../shared/release.ts";
import { Account, type AccountStore } from "./account.ts";
import { type AnalyticsControl, offAnalytics } from "./analytics.ts";
import { notifyAttention } from "./attention.ts";
import { dispatch, type Handlers } from "./dispatch.ts";
import { fileEnvironments } from "./environments.ts";
import { extensionOf, imageBytes, imageFileName, isClipboardType } from "./image-out.ts";
import { ConnectionManager } from "./manager.ts";
import { memoryPreferencesStore, type PreferencesStore, startPreferences } from "./preferences.ts";
import { fileSettings } from "./settings.ts";
import { cleanStale, Updater, type UpdaterDeps } from "./updater.ts";
import { type FrameStore, keepFrame, MIN_SIZE, restoredFrame } from "./window-frame.ts";

export type AppOptions = {
  /**
   * Where the person signs in, and where the login is kept (.agents/notes/2026-11-23-sso-login-desktop-must-sign-in.md). Not optional: the app is
   * not used without a login.
   */
  account: { client: OidcClient; store: AccountStore };
  /** Where the built page is: index.html, renderer.js, app.css. */
  rendererDir: string;
  preloadPath: string;
  /** How to run `cycle proxy` for this computer. */
  localCommand: string[];
  /** The whole environment of that command. Nothing is inherited from the app. */
  localEnv: Record<string, string>;
  /**
   * Show the window. A test turns it off, and then, on macOS, the app also stays out of the Dock and can never take the
   * focus from what the person is doing (the page still runs, and is driven, as it would be shown).
   */
  show?: boolean;
  /** What the app reports about how it is used (docs/analytics.md). Without it, nothing is. */
  analytics?: AnalyticsControl;
  /** Where the look and the language the person chose are kept. Without it, they last for this run. */
  preferences?: PreferencesStore;
  /** Where the window's size and place are kept between runs. Without it, the window opens at the default frame. */
  windowFrame?: FrameStore;
  /** How the app updates itself. Without it, updating is off. */
  update?: Omit<UpdaterDeps, "emit" | "quit">;
};

/** What asking for an update came to, in the words of the dictionary; the states that are not an answer say nothing. */
const updateResult = (
  kind: UpdateState["kind"],
): "available" | "up_to_date" | "error" | "disabled" | undefined => {
  switch (kind) {
    case "available":
      return "available";
    case "up-to-date":
      return "up_to_date";
    case "error":
      return "error";
    case "disabled":
      return "disabled";
    case "idle":
    case "checking":
    case "downloading":
    case "installing":
      return undefined;
  }
};

/**
 * What a link the page asks to open may be: a web page, or an address to write to (the mail app). The page checks the same
 * list (`isSafeLink` in @cycle/ui) and asks the person first; this is the check that does not trust the page.
 */
const OPENABLE = new Set(["https:", "http:", "mailto:"]);
const isOpenable = (url: string): boolean => {
  try {
    return OPENABLE.has(new URL(url).protocol);
  } catch {
    return false;
  }
};

/** How each kind of location is reached. The one place that knows. */
const channelFor =
  (options: AppOptions, localHandoff: () => Promise<void> | undefined) =>
  (location: LocationConfig) =>
  async () => {
    if (location.kind === "local") {
      const paused = localHandoff();
      if (paused) await paused;
      return commandChannel({ command: options.localCommand, env: options.localEnv });
    }
    const { transport } = location;
    return sshChannel({ host: transport.host, command: transport.command ?? ["cycle", "proxy"] });
  };

/** What went wrong in what ssh said: its last line, which is the cause (earlier lines are warnings and progress). */
const lastLine = (stderr: string): string =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("Warning: Permanently added"))
    .at(-1)
    ?.slice(0, 300) ?? "";

/** Runs `command` on the machine of a remote location, over ssh called as the connection calls it. */
const runOnHost = (location: LocationConfig, command: string): Promise<void> => {
  if (location.kind === "local") return Promise.reject(new Error("This is not a remote location."));
  const [program, ...args] = sshCommand({
    host: location.transport.host,
    args: ["-o", "ConnectTimeout=15"],
    command: ["sh", "-c", shellQuote(command)],
  });
  return new Promise((done, fail) => {
    execFile(
      program ?? "ssh",
      args,
      { timeout: 180_000, encoding: "utf8", maxBuffer: 1 << 20 },
      (error, _stdout, stderr) => {
        if (error === null) return done();
        // Said in words, never as the command line ssh was given.
        if (error.killed === true) return fail(new Error("It took too long."));
        fail(new Error(lastLine(stderr) || "ssh did not succeed."));
      },
    );
  });
};

/**
 * Starts the app: the connections, the window, and the bridge between them. The page is not trusted
 * with anything it could use against the user: agent output reaches it, and agent output is the
 * agent's word. So it gets no node, no navigation, no new windows, no permissions, and no network.
 */
/**
 * For a test on the person's own Mac: the app stays out of the Dock and can never come to the front. Call it before
 * anything is awaited: macOS brings a regular app to the front as soon as it has started.
 */
export const stayInBackground = () => {
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
};

export const startApp = async (options: AppOptions) => {
  const hidden = options.show === false;
  if (hidden) stayInBackground();
  await app.whenReady();
  if (process.platform === "darwin") createRequire(options.preloadPath)("./ime-paste.node");
  const indexUrl = pathToFileURL(join(options.rendererDir, "index.html")).href;
  let window: BrowserWindow | undefined;

  const usage = options.analytics ?? offAnalytics;
  const { analytics } = usage;

  // Before the window is made: the first thing drawn is already in the theme the person chose.
  const preferences = await startPreferences({
    store: options.preferences ?? memoryPreferencesStore(),
    systemLanguage: () => app.getPreferredSystemLanguages()[0] ?? app.getLocale(),
    applyTheme: (theme) => {
      nativeTheme.themeSource = theme;
    },
    track: (name, props) => analytics.track(name, props),
  });
  // What main says itself (a notification) is in the language chosen now, not the one at the start.
  const translator = (): Translator => {
    const { language, systemLanguage } = preferences.state();
    return translatorFor(resolveLanguage(language, systemLanguage));
  };

  const emit = (event: AppEvent) => {
    if (window !== undefined && !window.isDestroyed())
      window.webContents.send(EVENT_CHANNEL, event);
  };
  // Before anything is connected: until the person is signed in, no location is, and no session is read.
  let opened = false;
  let connectWhenOpen = false;
  const account = new Account({
    client: options.account.client,
    store: options.account.store,
    // Only a web page (connector-auth.ts checks it before it is handed over).
    open: (url) => shell.openExternal(url),
    track: (name, props) => analytics.track(name, props as never),
    log: (message) => console.warn(`[account] ${message}`),
    onChange: (status) => {
      emit({ type: "account", account: status });
      if (status.open && !opened && connectWhenOpen) void manager.connectAll();
      opened = status.open;
    },
  });
  // Not waited for here: the window opens at once and says it is starting; the page's first question (`account`) is
  // answered once the login is confirmed with the provider (at most STARTUP_CHECK_MS).
  const accountReady = account.start().then((status) => {
    opened = status.open;
  });
  let handoff: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  const manager = new ConnectionManager({
    ...(options.update !== undefined ? { appVersion: options.update.current.version } : {}),
    settings: fileSettings(join(app.getPath("userData"), "settings.json")),
    environments: fileEnvironments(join(app.getPath("userData"), "environments.json")),
    channelFor: channelFor(options, () => handoff?.promise),
    runOnHost,
    emit,
    track: (name, props) => analytics.track(name, props),
    promptSuggestions: () => preferences.state().promptSuggestions,
    // A connector's sign-in page: the manager only hands over a web address (connector-auth.ts checks it).
    openBrowser: (url) => shell.openExternal(url),
    attention: notifyAttention({
      window: () => window,
      // A hidden window is a test's: a notification would land in the person's own Notification Center, and pressing it
      // would bring the app to the front.
      supported: () => !hidden && Notification.isSupported(),
      create: (notification) => new Notification(notification),
      activate: () => app.focus({ steal: true }),
      translator,
      emit,
    }),
    chooseDirectory: async () => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    revealPath: (path) => shell.showItemInFolder(path),
  });
  await manager.init();
  analytics.track("app_launched", {
    remote_locations: (await manager.locations()).locations.filter((e) => e.kind === "remote")
      .length,
    first_run: usage.first,
  });

  const updater = new Updater({
    ...(options.update ?? {
      current: { version: "0.0.0", platform: process.platform, arch: process.arch },
      appPath: "",
      repo: "",
      fetch,
      extract: async () => {},
      disabled: "Updates are for the installed app.",
    }),
    handOff: async (swap) => {
      // Stopping the daemon drops its socket. A reconnect would start another copy from the old bundle.
      handoff = Promise.withResolvers<void>();
      try {
        await options.update?.handOff(swap);
      } catch (error) {
        handoff.resolve();
        handoff = undefined;
        throw error;
      }
    },
    emit: (state) => emit({ type: "app-update", state }),
    quit: () => app.quit(),
  });
  /** The most the page may put on the clipboard at once: a long output, not a file. */
  const MAX_COPY = 5_000_000;
  const methods: Handlers = {
    updateState: () => updater.state,
    checkForUpdate: async () => {
      const state = await updater.check(true);
      const result = updateResult(state.kind);
      if (result !== undefined) analytics.track("update_checked", { result });
      return state;
    },
    installUpdate: () => {
      analytics.track("update_install_started", {});
      return updater.install();
    },
    // From the page, so only what the page may say, and checked: anything else is dropped.
    track: (event: unknown, props: unknown) => {
      if (typeof event === "string" && isUiEvent(event))
        analytics.trackUnchecked(event, props ?? {});
    },
    preferences: () => preferences.state(),
    setPreferences: (change: unknown) => preferences.set(change),
    account: async () => {
      await accountReady;
      return account.status();
    },
    signIn: () => account.signIn(),
    cancelSignIn: () => account.cancelSignIn(),
    signOut: () => account.signOut(),
    analytics: () => usage.status(),
    setAnalytics: (enabled: unknown) => usage.set(enabled === true),
    // Through main, not the page's navigator.clipboard: the page is given no permissions. Text only, of a sane size.
    copyText: (text: unknown) => {
      if (typeof text !== "string" || text.length > MAX_COPY) return false;
      clipboard.writeText(text);
      return true;
    },
    // A picture the page shows (CYCL-212), checked to be one before it goes anywhere (image-out.ts).
    // The clipboard takes a PNG: a JPEG is made one here, from what was checked to be a JPEG.
    copyImage: async (type: unknown, data: unknown) => {
      const image = imageBytes(type, data);
      if (image === undefined || !isClipboardType(image.type)) return false;
      let png = image.bytes;
      if (image.type === "image/jpeg") {
        const picture = nativeImage.createFromBuffer(Buffer.from(image.bytes));
        if (picture.isEmpty()) return false;
        png = new Uint8Array(picture.toPNG());
      }
      try {
        await clipboard.write([
          new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) }),
        ]);
        return true;
      } catch {
        return false;
      }
    },
    // Written only to the file the person picked in the system's dialog: the page names no path.
    saveImage: async (name: unknown, type: unknown, data: unknown) => {
      const image = imageBytes(type, data);
      if (image === undefined) return "failed";
      const ext = extensionOf(image.type);
      const options = {
        defaultPath: join(app.getPath("downloads"), imageFileName(name, image.type)),
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      };
      const chosen =
        window !== undefined && !window.isDestroyed()
          ? await dialog.showSaveDialog(window, options)
          : await dialog.showSaveDialog(options);
      if (chosen.canceled || chosen.filePath === undefined || chosen.filePath === "")
        return "cancelled";
      try {
        await writeFile(chosen.filePath, image.bytes);
        return "saved";
      } catch {
        return "failed";
      }
    },
  };

  // Only our own page may ask main for anything.
  const call = dispatch(manager, methods, () => account.status().open);
  for (const method of API_METHODS) {
    ipcMain.handle(channel(method), (event, ...args: unknown[]) => {
      if (event.senderFrame?.url !== indexUrl) throw new Error("Refused: not from the app's page");
      return call(method, args);
    });
  }

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);

  // As the person left it, on a screen that is connected now (window-frame.ts).
  const frame = restoredFrame(
    options.windowFrame?.load(),
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
  );
  window = new BrowserWindow({
    ...frame.bounds,
    // Below this the sidebar and the conversation cannot both be used (DESIGN.md section 9).
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    ...(frame.fullScreen ? { fullscreen: true } : {}),
    // On a Mac the title bar is hidden; the traffic lights sit in the sidebar's corner. The close button is 14 wide,
    // so at x 17 its centre is 24 from the edge: the centre of the sidebar's icon column (sidebar.css), which it lines up with.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 17, y: 14 } }
      : {}),
    show: options.show ?? true,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // A window that is never shown counts as hidden, and a hidden page's timers and animation frames are held back.
      backgroundThrottling: !hidden,
    },
  });
  if (frame.maximized && !frame.fullScreen) window.maximize();
  if (options.windowFrame !== undefined) {
    const shown = window;
    const keeper = keepFrame({
      store: options.windowFrame,
      current: () =>
        shown.isDestroyed()
          ? undefined
          : {
              bounds: shown.getNormalBounds(),
              maximized: shown.isMaximized(),
              fullScreen: shown.isFullScreen(),
            },
    });
    shown.on("resize", keeper.changed);
    shown.on("move", keeper.changed);
    shown.on("maximize", keeper.changed);
    shown.on("unmaximize", keeper.changed);
    shown.on("enter-full-screen", keeper.changed);
    shown.on("leave-full-screen", keeper.changed);
    shown.on("close", keeper.closing);
  }
  const contents = window.webContents;
  // A link in the conversation opens in the user's browser (or mail app, for mailto), and never here.
  contents.setWindowOpenHandler(({ url }) => {
    if (isOpenable(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (url === indexUrl) return;
    event.preventDefault();
    if (isOpenable(url)) void shell.openExternal(url);
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  await window.loadURL(indexUrl);
  // Every location is connected from here, not when the person picks one: what is wrong with one is in its status.
  // Signed out, that waits for the sign-in.
  void accountReady.then(() => {
    connectWhenOpen = true;
    if (account.status().open) void manager.connectAll();
  });
  if (options.update !== undefined && options.update.disabled === undefined) {
    await cleanStale(options.update.appPath);
    updater.start();
  }

  app.on("window-all-closed", () => app.quit());
  // What is waiting to be reported goes out before the app ends, for as long as the sink allows (two seconds).
  let flushed = false;
  app.on("before-quit", (event) => {
    updater.stop();
    account.close();
    void manager.close();
    // Also when it was just turned off: its last word may still be waiting.
    if (flushed || !usage.status().available) return;
    flushed = true;
    event.preventDefault();
    void analytics.shutdown().finally(() => app.quit());
  });
  return { window, manager, contents, updater, account };
};

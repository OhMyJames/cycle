import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  BrowserWindow,
  type IpcMainInvokeEvent,
  Notification,
  app,
  dialog,
  ipcMain,
  shell,
} from "electron";
import { DaemonLog } from "./daemon-log";
import { daemonLaunch } from "./launch";
import { readLoginEnv } from "./login-env";
import { BUILD_FILE, type BuildInfo, LINUX_ICON, PRELOAD } from "./shared/layout";
import { updatesFolder } from "./update/plan";
import { systemPorts } from "./update/system";
import { createUpdater } from "./update/updater";
import { createRemoteConnection } from "./remote/connection";
import { connectionPorts, remotesFile } from "./remote/system";
import { RemoteStore } from "./remote/store";
import type { RemoteState } from "./shared/remote-state";
import { randomUUID } from "node:crypto";

/** A packaged app carries its daemon and codex; a repository run uses the repository's. */
const packaged = existsSync(path.join(app.getAppPath(), BUILD_FILE));

/**
 * Only the packaged macOS app replaces itself. The preload is told with this argument, so the page
 * is offered updates nowhere else.
 */
const selfUpdating = packaged && process.platform === "darwin";
const UPDATES_ARGUMENT = "--cycle-updates";
const UPDATE_CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
/** A focus asks GitHub at most this often, so switching windows does not spend its allowance. */
const FOCUS_UPDATE_CHECK_MS = 5 * 60 * 1000;

let daemonProcess: ChildProcess | null = null;
let pageOrigin = "";
/** What the window shows now, which a window made again shows too. */
let currentUrl = "";
/** This machine's own daemon's page, which the app returns to. */
let localUrl = "";
let stopRemote: (() => void) | undefined;

// Finder gives an app a bare environment. Agents and MCP servers need what a
// terminal has: the `PATH` and proxy variables of the owner's shell profile.
let ownerEnv: Promise<Record<string, string> | undefined> | undefined;
const readOwnerEnv = (): Promise<Record<string, string> | undefined> =>
  (ownerEnv ??= packaged
    ? readLoginEnv({
        shell: process.env["SHELL"] || "/bin/zsh",
        log: (line) => console.error(`[cycle] ${line}`),
      })
    : Promise.resolve(undefined));

/**
 * Finds the page to show. With CYCLE_PAGE_URL the app shows a daemon that is
 * already running; otherwise it starts one on a free port, which also serves
 * the page, and owns its lifetime.
 */
async function ensureDaemon(): Promise<string> {
  const given = process.env["CYCLE_PAGE_URL"];
  if (given) return given;
  const launch = daemonLaunch({
    appPath: app.getAppPath(),
    packaged,
    bun: process.env["CYCLE_BUN_BIN"],
  });
  const loginEnv = await readOwnerEnv();
  const child = spawn(launch.command, [...launch.args], {
    env: { ...process.env, ...loginEnv, ...launch.env },
    stdio: ["ignore", "pipe", packaged ? "pipe" : "inherit"],
  });
  daemonProcess = child;
  // From Finder there is no terminal to print to, so what the daemon says goes to a file.
  if (child.stderr) {
    // The home the daemon itself will use, which the owner's shell profile may set.
    const home =
      loginEnv?.["CYCLE_HOME"] ??
      process.env["CYCLE_HOME"] ??
      path.join(os.homedir(), ".cycle-codex");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // Kept from one start to the next, up to a size: what a turn waited for is read long after it ran.
    const file = path.join(home, "daemon.log");
    const log = new DaemonLog(
      {
        size: () => (existsSync(file) ? statSync(file).size : 0),
        append: (text) => appendFileSync(file, text, { mode: 0o600 }),
        rotate: () => renameSync(file, `${file}.1`),
      },
      () => new Date(),
    );
    // A file made before with wider rights is held to the owner's alone.
    try {
      chmodSync(file, 0o600);
    } catch {
      // Not there yet: it is made with them.
    }
    log.start();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => log.write(chunk));
    child.stderr.on("end", () => log.end());
  }
  return new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`failed to start daemon: ${error.message}`)));
    child.once("exit", (code) => {
      // A daemon that found another already running points at it and leaves.
      if (code !== 0) reject(new Error(`daemon exited before it was ready (code ${code})`));
    });
    if (!child.stdout) return;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { type?: string; pageUrl?: string };
        if (message.type === "listening" && message.pageUrl) resolve(message.pageUrl);
      } catch {
        console.log(`[daemon] ${line}`);
      }
    });
    // A daemon that said all it had to without saying where it is will never say it.
    lines.on("close", () => reject(new Error("daemon stopped before it said where it is")));
  });
}

/** Only the daemon's own page may use the bridge. */
function fromPage(event: IpcMainInvokeEvent): boolean {
  try {
    return new URL(event.senderFrame?.url ?? "").origin === pageOrigin;
  } catch {
    return false;
  }
}

function createWindow(pageUrl: string): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 560,
    minHeight: 400,
    title: "Cycle",
    ...(packaged && process.platform === "linux"
      ? { icon: path.join(app.getAppPath(), LINUX_ICON) }
      : {}),
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 13 } }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(app.getAppPath(), PRELOAD),
      ...(selfUpdating ? { additionalArguments: [UPDATES_ARGUMENT] } : {}),
    },
  });
  // Agent output can contain links; never navigate the app window to them.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== pageOrigin) event.preventDefault();
  });
  void window.loadURL(pageUrl);
}

/** Shows a page in the window, and lets the bridge answer to that page alone. */
function load(url: string): void {
  pageOrigin = new URL(url).origin;
  currentUrl = url;
  const window = BrowserWindow.getAllWindows()[0];
  if (window) void window.loadURL(url);
}

/**
 * Remote servers: the list is kept here, beside the owner's other local files, and a server is
 * reached through an ssh tunnel that this process owns. The page is told a state, never a token.
 */
async function startRemotes(): Promise<void> {
  const loginEnv = await readOwnerEnv();
  const env = { ...process.env, ...loginEnv };
  const home = env["CYCLE_HOME"] ?? path.join(os.homedir(), ".cycle-codex");
  const store = new RemoteStore(remotesFile(home), () => randomUUID());
  const connection = createRemoteConnection(
    connectionPorts({
      env,
      localOrigin: () => new URL(localUrl).origin,
      show: (url) => load(url),
      onState: (state: RemoteState) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send("cycle:remotes-state", state);
        }
      },
    }),
  );
  stopRemote = () => connection.disconnect();
  const backToLocal = (): void => {
    connection.disconnect();
    if (currentUrl !== localUrl) load(localUrl);
  };
  ipcMain.handle("cycle:remotes-list", (event) => (fromPage(event) ? store.list() : []));
  ipcMain.handle("cycle:remotes-add", (event, input: unknown) =>
    fromPage(event) ? store.add(input) : { ok: false, error: "Not allowed." },
  );
  ipcMain.handle("cycle:remotes-update", (event, id: unknown, input: unknown) =>
    fromPage(event) && typeof id === "string"
      ? store.update(id, input)
      : { ok: false, error: "Not allowed." },
  );
  ipcMain.handle("cycle:remotes-remove", async (event, id: unknown) => {
    if (!fromPage(event) || typeof id !== "string") return;
    const state = connection.state();
    if (state.status !== "idle" && state.id === id) backToLocal();
    await store.remove(id);
  });
  ipcMain.handle("cycle:remotes-state", (event) =>
    fromPage(event) ? connection.state() : { status: "idle" },
  );
  ipcMain.handle("cycle:remotes-connect", async (event, id: unknown) => {
    if (!fromPage(event)) return;
    const remote = typeof id === "string" ? await store.get(id) : undefined;
    if (!remote) {
      backToLocal();
      return;
    }
    await connection.connect(remote);
    // A server that cannot be reached leaves the owner on this machine's own page, whose
    // Settings show why, rather than on a page whose tunnel has just been closed.
    if (connection.state().status === "failed" && currentUrl !== localUrl) load(localUrl);
  });
}

/**
 * The app's own updates: looked for shortly after it starts, then every few hours, and when the
 * owner asks. A found one is downloaded, and installed only when the owner says so in the page,
 * because that restarts the app and stops whatever turn is running.
 */
async function startUpdater(): Promise<() => void> {
  const loginEnv = await readOwnerEnv();
  const env = { ...process.env, ...loginEnv };
  const info = JSON.parse(
    readFileSync(path.join(app.getAppPath(), BUILD_FILE), "utf8"),
  ) as BuildInfo;
  const updater = createUpdater(
    systemPorts({
      // In the home the daemon itself uses, which the owner's shell profile may set.
      updates: updatesFolder(env["CYCLE_HOME"], os.homedir()),
      info,
      appPath: app.getAppPath(),
      env,
      quit: () => app.quit(),
      onState: (state) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send("cycle:update-state", state);
        }
      },
    }),
  );
  ipcMain.handle("cycle:update-state", (event) => (fromPage(event) ? updater.state() : null));
  ipcMain.handle("cycle:update-check", async (event) => {
    if (fromPage(event)) await updater.check();
  });
  ipcMain.handle("cycle:update-install", async (event) => {
    if (fromPage(event)) await updater.install();
  });
  let askedAt = 0;
  const check = (): void => {
    const now = Date.now();
    if (now - askedAt < FOCUS_UPDATE_CHECK_MS) return;
    askedAt = now;
    void updater.check();
  };
  setInterval(check, UPDATE_CHECK_EVERY_MS);
  return check;
}

async function start(): Promise<void> {
  await app.whenReady();
  let pageUrl: string;
  try {
    pageUrl = await ensureDaemon();
  } catch (error) {
    dialog.showErrorBox("Cycle", error instanceof Error ? error.message : String(error));
    app.quit();
    return;
  }
  pageOrigin = new URL(pageUrl).origin;
  localUrl = pageUrl;
  currentUrl = pageUrl;

  ipcMain.handle("cycle:pick-directory", async (event) => {
    if (!fromPage(event)) return null;
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("cycle:notify", (event, title: unknown, body: unknown) => {
    if (!fromPage(event) || !Notification.isSupported()) return;
    const notification = new Notification({ title: String(title), body: String(body) });
    notification.on("click", () => BrowserWindow.getAllWindows()[0]?.show());
    notification.show();
  });
  ipcMain.handle("cycle:open-external", (event, url: unknown) => {
    if (fromPage(event) && typeof url === "string" && /^(https?:|mailto:)/.test(url)) {
      void shell.openExternal(url);
    }
  });

  let checkForUpdates: (() => void) | undefined;
  if (selfUpdating) {
    // Before the window, so the page's first question about updates has someone to answer it.
    try {
      checkForUpdates = await startUpdater();
    } catch (error) {
      console.error(`[cycle] updates are off: ${String(error)}`);
    }
  }

  try {
    await startRemotes();
  } catch (error) {
    console.error(`[cycle] remote servers are off: ${String(error)}`);
  }

  createWindow(pageUrl);
  if (checkForUpdates) {
    // As soon as the page is there, and again whenever the owner comes back to it.
    checkForUpdates();
    app.on("browser-window-focus", () => checkForUpdates?.());
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(currentUrl);
  });
  // A second launch of the packaged app ends at once and leaves this one in front.
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) {
      createWindow(currentUrl);
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}

// Only a packaged app holds the lock, so repository runs can still sit side by side.
if (packaged && !app.requestSingleInstanceLock()) app.quit();
else void start();

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  stopRemote?.();
  daemonProcess?.kill();
});

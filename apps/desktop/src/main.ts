import { type ChildProcess, spawn } from "node:child_process";
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

let daemonProcess: ChildProcess | null = null;
let pageOrigin = "";

/**
 * Finds the page to show. With CYCLE_PAGE_URL the app shows a daemon that is
 * already running; otherwise it starts one (under Bun) on a free port, which
 * also serves the page, and owns its lifetime.
 */
function ensureDaemon(): Promise<string> {
  const given = process.env["CYCLE_PAGE_URL"];
  if (given) return Promise.resolve(given);
  // Paths hang off the app root (apps/desktop): the bundler rewrites __dirname.
  const entry = path.resolve(app.getAppPath(), "../daemon/src/main.ts");
  const child = spawn(process.env["CYCLE_BUN_BIN"] ?? "bun", [entry], {
    env: {
      ...process.env,
      CYCLE_DAEMON_PORT: "0",
      CYCLE_UI_DIR: path.join(app.getAppPath(), "dist/renderer"),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  daemonProcess = child;
  return new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`failed to start daemon: ${error.message}`)));
    child.once("exit", (code) => {
      // A daemon that found another already running points at it and leaves.
      if (code !== 0) reject(new Error(`daemon exited before it was ready (code ${code})`));
    });
    if (!child.stdout) return;
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const message = JSON.parse(line) as { type?: string; pageUrl?: string };
        if (message.type === "listening" && message.pageUrl) resolve(message.pageUrl);
      } catch {
        console.log(`[daemon] ${line}`);
      }
    });
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
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 13 } }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(app.getAppPath(), "dist/preload.cjs"),
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

void app.whenReady().then(async () => {
  let pageUrl: string;
  try {
    pageUrl = await ensureDaemon();
  } catch (error) {
    dialog.showErrorBox("Cycle", error instanceof Error ? error.message : String(error));
    app.quit();
    return;
  }
  pageOrigin = new URL(pageUrl).origin;

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

  createWindow(pageUrl);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(pageUrl);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => daemonProcess?.kill());

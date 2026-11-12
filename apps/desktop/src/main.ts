import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { BrowserWindow, app, dialog, shell } from "electron";

let daemonProcess: ChildProcess | null = null;

/**
 * Resolve the daemon endpoint. With CYCLE_DAEMON_URL the app attaches to an
 * already-running daemon; otherwise it spawns one (under Bun) on a free port
 * and owns its lifetime.
 */
function ensureDaemon(): Promise<string> {
  if (process.env.CYCLE_DAEMON_URL) return Promise.resolve(process.env.CYCLE_DAEMON_URL);

  // Paths hang off the app root (apps/desktop): the bundler rewrites __dirname.
  const entry = path.resolve(app.getAppPath(), "../daemon/src/main.ts");
  const child = spawn(process.env.CYCLE_BUN_BIN ?? "bun", [entry], {
    env: { ...process.env, CYCLE_DAEMON_PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  daemonProcess = child;

  return new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`failed to start daemon: ${error.message}`)));
    child.once("exit", (code) => reject(new Error(`daemon exited before it was ready (code ${code})`)));
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.type === "listening") resolve(message.url);
      } catch {
        console.log(`[daemon] ${line}`);
      }
    });
  });
}

function createWindow(daemonUrl: string): void {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 480,
    minHeight: 360,
    title: "Cycle",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Agent output can contain links; never navigate the app window to them.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  void window.loadFile(path.join(app.getAppPath(), "dist/renderer/index.html"), { query: { daemon: daemonUrl } });
}

app.whenReady().then(async () => {
  let daemonUrl: string;
  try {
    daemonUrl = await ensureDaemon();
  } catch (error) {
    dialog.showErrorBox("Cycle", error instanceof Error ? error.message : String(error));
    app.quit();
    return;
  }
  createWindow(daemonUrl);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(daemonUrl);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => daemonProcess?.kill());

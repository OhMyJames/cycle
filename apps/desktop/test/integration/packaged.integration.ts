// The packaged app, as a user's machine would run it: assembled by scripts/package.ts (or given, in
// CYCLE_PACKAGED_APP, as the workflow does for the bundle it just built), started with a bare
// environment (no bun or node on PATH, no repository). It must find the daemon and Claude inside
// itself, start the daemon, and show a window that is connected to it.
//
// The window is read over the DevTools protocol, which Electron serves when asked
// (--remote-debugging-port): the page's own environment indicator has to say "connected", and the page has to be locked
// down (its CSP, no Node, only the bridge's methods).
// Linux (under xvfb) and macOS run the same test; what differs is only where the executable is.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageApp } from "../../scripts/package.ts";
import { evaluate } from "./cdp.ts";

const linux = process.platform === "linux";
const mac = process.platform === "darwin";
const ready = mac || (linux && Bun.which("xvfb-run") !== null);

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-packaged-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** Where the pieces are, for an app that was built here or one that was handed in. */
const locate = () => {
  const given = process.env.CYCLE_PACKAGED_APP;
  if (given === undefined) return packageApp(join(root, "build"));
  const appDir = mac ? join(given, "Contents/Resources/app") : join(given, "resources/app");
  const executable = mac ? join(given, "Contents/MacOS/Electron") : join(given, "cycle");
  return { app: given, appDir, executable, version: "" };
};

test.skipIf(!ready)(
  "the packaged app starts the daemon it carries, and its window connects to it",
  async () => {
    const packaged = locate();
    expect(existsSync(join(packaged.appDir, "build.json"))).toBe(true);
    expect(existsSync(join(packaged.appDir, "bin/claude"))).toBe(true);

    const data = join(root, "data");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const flags = [
      "--no-sandbox", // the test machine has no setuid chrome-sandbox; the window itself stays sandboxed
      "--disable-gpu",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(root, "electron")}`,
    ];
    const proc = Bun.spawn(
      linux ? ["xvfb-run", "-a", packaged.executable, ...flags] : [packaged.executable, ...flags],
      {
        // The packaged app carries the real project key: a test must say that nothing is to be reported.
        // On a Mac the window is hidden, so that it does not take the person's focus: it is read over DevTools, not looked
        // at. Under xvfb nobody's focus is there to take, and the window is shown as it is for a user.
        env: {
          PATH: "/usr/bin:/bin",
          HOME: root,
          CYCLE_HOME: data,
          CYCLE_ANALYTICS: "off",
          ...(mac ? { CYCLE_TEST_HIDDEN_WINDOW: "1" } : {}),
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    try {
      // The window says it is connected: the page, the main process and the bundled daemon, together.
      const started = Date.now();
      let state: unknown;
      for (;;) {
        state = await evaluate(
          port,
          // An environment that is connected is not shown in the sidebar's list of environments that are apart (only one that is not is),
          // so the window says it by the button that starts a session being usable: it is while some environment is connected.
          "document.querySelector('button[title^=\"New session\"]')?.disabled === false ? 'connected' : null",
        ).catch(() => undefined);
        if (state === "connected") break;
        if (Date.now() - started > 45_000) {
          throw new Error(`the window never said connected (last: ${String(state)})`);
        }
        await Bun.sleep(250);
      }
      // The page is locked down, as the preload and the main process leave it: what Electron alone decides, and so what
      // the tests in a browser (web.integration.ts) cannot show.
      const page = (await evaluate(
        port,
        `({
          csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null,
          nodeRequire: typeof require,
          nodeProcess: typeof process,
          ipcRenderer: typeof window.ipcRenderer,
          bridgeKeys: Object.keys(window.cycle).sort(),
        })`,
      )) as Record<string, unknown>;
      expect(page.csp).toContain("default-src 'none'");
      expect(page.csp).toContain("connect-src 'none'");
      expect(page.nodeRequire).toBe("undefined");
      expect(page.nodeProcess).toBe("undefined");
      expect(page.ipcRenderer).toBe("undefined");
      // The bridge has these methods and nothing else. Written out on purpose: a method added to the bridge is something
      // more the page can do, and has to be added here, where a review sees it.
      expect(page.bridgeKeys).toEqual(
        [
          "ackReturn",
          "addConnector",
          "agentDefaults",
          "agents",
          "analytics",
          "answerForm",
          "answerPermission",
          "archiveSession",
          "attachTerminal",
          "authorizeConnector",
          "cancel",
          "cancelConnectorAuth",
          "checkForUpdate",
          "chooseDirectory",
          "closeTerminal",
          "connect",
          "copyText",
          "createSession",
          "createTerminal",
          "deleteSession",
          "dequeue",
          "detachTerminal",
          "disconnect",
          "dismissBackground",
          "environments",
          "installUpdate",
          "listConnectors",
          "listFiles",
          "listFolders",
          "listTerminals",
          "markRead",
          "onEvent",
          "openSession",
          "planUsage",
          "preferences",
          "prompt",
          "readFile",
          "readTrust",
          "removeConnector",
          "removeEnvironment",
          "renameSession",
          "resizeTerminal",
          "saveEnvironment",
          "searchFiles",
          "sessions",
          "setAgentDefaults",
          "setAnalytics",
          "setPreferences",
          "setSessionConfig",
          "setTrust",
          "signOutConnector",
          "terminalInput",
          "track",
          "updateConnector",
          "updateState",
          "upgradeDaemon",
          "workspaceFile",
          "workspaceStatus",
        ].sort(),
      );

      // And the daemon that serves it is the one inside the app.
      const pid = Number((await Bun.file(join(data, "daemon.pid")).text()).trim());
      if (linux)
        expect(await readlink(`/proc/${pid}/exe`)).toBe(join(packaged.appDir, "bin/cycle"));
      else {
        const ps = Bun.spawnSync(["ps", "-p", String(pid), "-o", "command="]);
        expect(ps.stdout.toString()).toContain(join(packaged.appDir, "bin/cycle"));
      }
      process.kill(pid, "SIGTERM");
    } finally {
      proc.kill();
      await proc.exited;
    }
  },
  120_000,
);

// The app's entry. Everything is in app.ts; this says where things are.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { posthogSink } from "@cycle/analytics/posthog";
import { app, safeStorage } from "electron";
import { CONTRACT_MAJOR } from "../shared/contract.ts";
import { POSTHOG_HOST } from "../shared/posthog.ts";
import { RELEASE_REPO } from "../shared/release.ts";
import { ssoClientFor } from "./account.ts";
import { accountStoreFor } from "./account-store.ts";
import {
  fileAnalyticsStore,
  optedOutByEnvironment,
  projectOf,
  startAnalytics,
} from "./analytics.ts";
import { startApp, stayInBackground } from "./app.ts";
import { managedDaemonDir, seedAndReport } from "./daemon-home.ts";
import { localHome } from "./home.ts";
import { BUILD_FILE, bundledDaemonDir, daemonCommand, loginShellPath } from "./layout.ts";
import { filePreferencesStore } from "./preferences.ts";
import { stopRefusal } from "./stop-refused.ts";
import { verifySignature } from "./ui-crypto.ts";
import { UI_KEYS } from "./ui-keys.ts";
import { createUiStore } from "./ui-store.ts";
import { SWAP_SCRIPT, verifySameTeam } from "./updater.ts";
import { fileFrameStore } from "./window-frame.ts";

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
// Only a test sets it: the packaged app is run on the developer's own Mac, and must not take the focus there. Said at
// once, before anything is awaited: macOS brings a regular app to the front as soon as it has started.
const hidden = env.CYCLE_TEST_HIDDEN_WINDOW === "1";
if (hidden) stayInBackground();
const packaged = existsSync(join(here, "..", BUILD_FILE));
// Only a test sets it: where the app keeps its own data (settings, the login of a test's stand-in provider), also when the
// app is opened again by the updater, which `--user-data-dir` does not survive. Before anything reads the folder.
if (env.CYCLE_USER_DATA !== undefined && env.CYCLE_USER_DATA !== "")
  app.setPath("userData", env.CYCLE_USER_DATA);
// Only a test sets these (a stand-in sign-in provider, its own data folder), and a test runs the app with a HOME of its
// own that has no keychain: Chromium's key for cookies and safeStorage would then ask macOS for one, which shows the
// person a "Keychain Not Found" window. A test's app uses Chromium's stand-in keychain instead. Before "ready".
if (
  (env.CYCLE_SSO_ISSUER !== undefined && env.CYCLE_SSO_ISSUER !== "") ||
  (env.CYCLE_USER_DATA !== undefined && env.CYCLE_USER_DATA !== "")
)
  app.commandLine.appendSwitch("use-mock-keychain");

const run = (program: string, args: string[], timeoutMs: number, env?: Record<string, string>) =>
  new Promise<string>((done, fail) => {
    execFile(
      program,
      args,
      { timeout: timeoutMs, encoding: "utf8", ...(env ? { env } : {}) },
      (error, stdout) => (error ? fail(error) : done(stdout)),
    );
  });

// Not awaited at the top level: Electron loads an ES module main before it starts the event loop that
// emits "ready", so awaiting the app's own start here would wait for itself, forever.
const main = async () => {
  // Started from Finder, the app has launchd's bare PATH. The user's own is what Claude's tools need.
  const path =
    packaged && process.platform === "darwin" ? await loginShellPath(env.SHELL, run) : undefined;
  const dataHome = localHome({ packaged, env, home: homedir() });
  // The daemon's data directory, where the packaged app runs its daemon from too (`<it>/daemon/bin`, CYC-538).
  const dataRoot = dataHome ?? join(homedir(), ".cycle");
  let daemon = daemonCommand({
    here,
    env,
    platform: process.platform,
    arch: process.arch,
    exists: existsSync,
    managedDir: managedDaemonDir(dataRoot),
  });
  const localEnv = {
    PATH: path ?? env.PATH ?? "",
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    ...(env.LANG !== undefined ? { LANG: env.LANG } : {}),
    // Who the person is and which shell is theirs, for the terminals beside a session (CYCL-223): without SHELL they
    // ran /bin/sh, with none of the person's prompt and rc files. Not secrets, and not on any agent's allowlist.
    ...Object.fromEntries(
      (["SHELL", "USER", "LOGNAME"] as const).flatMap((name) =>
        env[name] !== undefined ? [[name, env[name]]] : [],
      ),
    ),
    // Where the daemon keeps its data: what the person chose, else (a run from source) a directory of its own,
    // else the daemon's default, which is the installed app's.
    ...(dataHome !== undefined ? { CYCLE_HOME: dataHome } : {}),
    // Only a test sets it: a daemon that does not update itself from the channel (docs/daemon.md "自动更新").
    ...(env.CYCLE_DAEMON_UPDATES === "off" ? { CYCLE_DAEMON_UPDATES: "off" } : {}),
  };
  const info = buildInfo();
  // Reported to only with a project (the build has one, or the environment names one), and never against what the person
  // said: the environment's opt-out is checked here, before anything is made.
  const project = optedOutByEnvironment(env) ? undefined : projectOf(info, env);
  const analytics = await startAnalytics({
    store: fileAnalyticsStore(join(app.getPath("userData"), "analytics.json")),
    sink:
      project === undefined
        ? undefined
        : () => posthogSink({ apiKey: project.key, host: project.host ?? POSTHOG_HOST }),
    context: {
      app_version: info?.version ?? "dev",
      platform: process.platform,
      arch: process.arch,
    },
    onDrop: (name, reason) => console.warn(`[analytics] ${name} not sent: ${reason}`),
  });
  // The daemon this app carries goes where the daemon runs from, when the one there is missing or older. When it cannot
  // be put there, the app runs the one it carries, as before CYC-538.
  if (packaged && info?.daemonVersion !== undefined) {
    const seeded = await seedAndReport(
      {
        bundledDir: bundledDaemonDir(here),
        bundledVersion: info.daemonVersion,
        managedDir: managedDaemonDir(dataRoot),
        versionOf: (dir) =>
          run(join(dir, "cycle"), ["version"], 15_000, localEnv)
            .then((out) => out.trim())
            .catch(() => undefined),
        running: () => listening(join(dataRoot, "daemon.sock")),
        copy: copyDaemonFolder,
      },
      (name, props) => analytics.analytics.track(name, props),
      (message) => console.warn(`[daemon] ${message}`),
    );
    if (seeded === "failed") daemon = [join(bundledDaemonDir(here), "cycle")];
  } else if (packaged) {
    daemon = [join(bundledDaemonDir(here), "cycle")];
  }
  // The person's own login is sealed with the keychain in the installed app. A run from source, and a test (which names
  // its stand-in provider), keep theirs in a file of their own and never reach the keychain.
  const sso = ssoClientFor(env);
  const userData = app.getPath("userData");
  const { store: accountStore } = accountStoreFor({
    packaged,
    test: sso.test,
    userData,
    sealer: {
      available: () => safeStorage.isEncryptionAvailable(),
      seal: (text) => safeStorage.encryptString(text),
      open: (sealed) => safeStorage.decryptString(sealed),
    },
  });
  await startApp({
    account: { client: sso.client, store: accountStore },
    analytics,
    preferences: filePreferencesStore(join(app.getPath("userData"), "preferences.json")),
    // A test's hidden window neither opens where the person's did nor moves it.
    ...(hidden
      ? {}
      : { windowFrame: fileFrameStore(join(app.getPath("userData"), "window-frame.json")) }),
    rendererDir: join(here, "renderer"),
    preloadPath: join(here, "preload.cjs"),
    localCommand: [...daemon, "proxy"],
    localEnv,
    // Where the Loop server listens is where the local daemon keeps its data (docs/protocol.md §17). The desktop holds
    // no itsaplan key: the file an older version read is only removed (`oldKeyFile`).
    loop: {
      socket: join(dataHome ?? join(homedir(), ".cycle"), "loop.sock"),
      oldKeyFile: join(userData, "itsaplan-key"),
      chatCwd: join(dataHome ?? join(homedir(), ".cycle"), "ticket-chat"),
    },
    update: updateDeps(daemon, localEnv, dataRoot),
    ...interfaceOptions(userData, info),
    ...(hidden ? { show: false } : {}),
  });
};

/**
 * Interface updates (docs/desktop.md). The app takes bundles signed by the keys built into it, from the repository's
 * release, for its contract major (shared/contract.ts). A run from source takes none, since its page is the one being
 * worked on, unless a test names a loopback address and a key of its own (an installed app cannot be pointed anywhere
 * else, nor given a key).
 */
const interfaceOptions = (userData: string, info: ReturnType<typeof buildInfo>) => {
  if (!packaged && !env.CYCLE_UI_URL) return {};
  const contract = info?.contract ?? CONTRACT_MAJOR;
  const testKeys = (() => {
    if (packaged || !env.CYCLE_UI_KEYS) return {};
    try {
      return JSON.parse(env.CYCLE_UI_KEYS) as Record<string, string>;
    } catch {
      return {};
    }
  })();
  const keys = { ...UI_KEYS, ...testKeys };
  const bundledVersion = info?.uiVersion ?? 0;
  const loopback = (() => {
    if (packaged || !env.CYCLE_UI_URL) return undefined;
    try {
      const u = new URL(env.CYCLE_UI_URL);
      return u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname)
        ? `${u.origin}/`
        : undefined;
    } catch {
      return undefined;
    }
  })();
  const verify = (bytes: Uint8Array, signature: string, keyId: string) =>
    verifySignature(bytes, signature, keyId, keys);
  return {
    interface: {
      store: createUiStore({
        root: join(userData, "ui"),
        verify,
        bundledVersion,
        contract,
        log: (message) => console.warn(`[interface] ${message}`),
      }),
      bundledVersion,
      ...(!packaged && Number(env.CYCLE_UI_BOOT_MS) > 0
        ? { bootMs: Number(env.CYCLE_UI_BOOT_MS) }
        : {}),
      updater: {
        contract,
        hasKeys: Object.keys(keys).length > 0,
        verify,
        repo: RELEASE_REPO,
        ...(loopback !== undefined ? { baseUrl: loopback } : {}),
        fetch,
        extract: (zip: string, into: string) =>
          run("/usr/bin/ditto", ["-x", "-k", zip, into], 300_000).then(() => {}),
        log: (message: string) => console.warn(`[interface] ${message}`),
      },
    },
  };
};

/** What the build recorded about itself (`package`), or nothing in a run from source. */
const buildInfo = ():
  | {
      version: string;
      contract?: number;
      uiVersion?: number;
      daemonVersion?: string;
      posthogKey?: string;
      posthogHost?: string;
    }
  | undefined =>
  packaged ? JSON.parse(readFileSync(join(here, "..", BUILD_FILE), "utf8")) : undefined;

/** Whether something listens on a unix socket. */
const listening = (socket: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = connect(socket);
    const done = (up: boolean) => {
      probe.destroy();
      resolve(up);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    probe.setTimeout(2_000, () => done(false));
  });

/** Whether the daemon whose pid is in `pidFile` runs a program inside `appPath`. */
const runsFromInside = async (pidFile: string, appPath: string): Promise<boolean> => {
  const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const program = await run("/bin/ps", ["-o", "comm=", "-p", String(pid)], 5_000).catch(() => "");
  return program.trim().startsWith(`${appPath}/`);
};

/**
 * Copies the app's daemon folder: a clone on APFS (no space taken until a file changes), and without the quarantine
 * mark a download from a browser leaves on the app, which would make Gatekeeper look at each program as downloaded.
 */
const copyDaemonFolder = async (from: string, to: string): Promise<void> => {
  if (process.platform === "darwin") {
    await run("/bin/cp", ["-c", "-R", from, to], 120_000).catch(async () => {
      // A volume that cannot clone: a plain copy, over nothing a half-made clone left.
      await rm(to, { recursive: true, force: true });
      await run("/bin/cp", ["-R", from, to], 300_000);
    });
    await run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", to], 60_000).catch(() => "");
    return;
  }
  await run("/bin/cp", ["-R", from, to], 300_000);
};

const localRelease = (url: string | undefined) => {
  if (url === undefined) return {};
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname))
    return {};
  const base = parsed.origin;
  return { apiBase: base, assetPrefix: `${base}/dl/` };
};

/** What the updater needs from this machine. Only an installed macOS app can replace itself. */
const updateDeps = (daemon: string[], localEnv: Record<string, string>, dataRoot: string) => {
  const info = packaged
    ? (JSON.parse(readFileSync(join(here, "..", BUILD_FILE), "utf8")) as {
        version: string;
        platform: string;
        arch: string;
      })
    : { version: "0.0.0", platform: process.platform, arch: process.arch };
  // dist -> app -> Resources -> Contents -> Cycle.app
  const appPath = resolve(here, "../../../..");
  const codesign = (args: string[]) =>
    new Promise<string>((done, fail) =>
      execFile("/usr/bin/codesign", args, { encoding: "utf8" }, (error, stdout, stderr) =>
        error ? fail(error) : done(`${stdout}${stderr}`),
      ),
    );
  return {
    current: info,
    appPath,
    repo: RELEASE_REPO,
    fetch,
    // For the test that updates a real bundle against a release served on this machine. Only a
    // loopback address is taken, so it can never point the app at somewhere else.
    ...localRelease(env.CYCLE_UPDATE_URL),
    disabled:
      packaged && process.platform === "darwin"
        ? undefined
        : "Updates are for the installed macOS app.",
    extract: (zip: string, into: string) =>
      run("/usr/bin/ditto", ["-x", "-k", zip, into], 300_000).then(() => {}),
    verifyBundle: verifySameTeam(codesign),
    log: (message: string) => console.warn(`[update] ${message}`),
    // The daemon runs from its own folder (CYC-538) and goes on working through the swap. Only one an older app started
    // from inside this app would outlive the swap with its agents' binaries gone: that one is stopped first, as before.
    handOff: async (swap: { appPath: string; newApp: string; oldApp: string; staging: string }) => {
      if (await runsFromInside(join(dataRoot, "daemon.pid"), swap.appPath)) {
        try {
          await run(daemon[0] ?? "", [...daemon.slice(1), "stop"], 20_000, localEnv);
        } catch (error) {
          const refused = stopRefusal(error);
          throw refused === undefined ? error : new Error(refused);
        }
      }
      const helper = spawn(
        "/bin/sh",
        [
          "-c",
          SWAP_SCRIPT,
          "cycle-swap",
          String(process.pid),
          swap.appPath,
          swap.newApp,
          swap.oldApp,
          swap.staging,
          "/usr/bin/open",
        ],
        { detached: true, stdio: "ignore" },
      );
      await new Promise<void>((resolve, reject) => {
        helper.once("error", reject);
        helper.once("spawn", resolve);
      });
      helper.unref();
    },
  };
};
main().catch((error) => {
  console.error(error);
  process.exit(1);
});

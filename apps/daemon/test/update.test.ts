import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { CycleClient, connectUnix } from "@cycle/client";
import { pathsFor } from "../src/config.ts";
import { Daemon, isListening, listenUnix } from "../src/index.ts";
import { startDetached } from "../src/proxy.ts";
import { askWorking, stopDaemon } from "../src/stop.ts";
import { installOf, recordedVersion, runUpdate, type UpdateDeps } from "../src/update.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
let cleanup: (() => Promise<void> | void)[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  for (const clean of cleanup.reverse()) await clean();
  cleanup = [];
  await dispose();
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const SCRIPT = new TextEncoder().encode("#!/bin/sh\necho installing\n");

/** A daemon on `<dir>/daemon.sock`, as `serve` runs one. */
const serve = async (fake = fakeAgent()) => {
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  const socket = join(dir, "daemon.sock");
  const server = await listenUnix({
    path: socket,
    onConnection: ({ stream }) => daemon.accept(stream),
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    server.close();
    await daemon.close();
  };
  cleanup.push(stop);
  return { daemon, socket, stop };
};

/** `runUpdate` with everything outside the process faked: what was downloaded, what was installed, said. */
const harness = (over: Partial<UpdateDeps> = {}) => {
  const said: string[] = [];
  const calls = {
    downloads: [] as string[],
    installs: [] as string[],
    starts: 0,
    stops: [] as boolean[],
  };
  const deps: UpdateDeps = {
    version: "0.3.1",
    requested: undefined,
    now: false,
    install: { kind: "installed", prefix: "/home/u/.local" },
    recorded: async () => undefined,
    download: async (url) => {
      calls.downloads.push(url);
      return url.endsWith(".sha256")
        ? new TextEncoder().encode(`${sha(SCRIPT)}  install.sh\n`)
        : SCRIPT;
    },
    runInstaller: async (_dir, tag) => {
      calls.installs.push(tag);
      return 0;
    },
    isRunning: async () => false,
    runningVersion: async () => undefined,
    stop: async (force) => {
      calls.stops.push(force);
      return 0;
    },
    start: async () => {
      calls.starts += 1;
      return true;
    },
    say: (line) => said.push(line),
    ...over,
  };
  return { deps, said, calls };
};

test("the daemon records the version the app reports, and an odd one is not kept", async () => {
  const { socket } = await serve();
  const report = async (appVersion: string) => {
    const client = new CycleClient({
      connect: () => connectUnix(socket),
      name: "cycle-desktop",
      appVersion,
    });
    await client.start();
    await client.close();
  };
  expect(await recordedVersion(dir)).toBeUndefined();
  await report("0.3.7");
  await waitFor(() => existsRecorded(), "the version to be written");
  expect(await recordedVersion(dir)).toBe("0.3.7");
  // An alpha reports the release it was cut from, and the latest report wins.
  await report("0.3.9");
  await waitFor(async () => (await recordedVersion(dir)) === "0.3.9", "the newer version");
  await report("0.3.9-alpha.2; rm -rf /");
  await Bun.sleep(50);
  expect(await recordedVersion(dir)).toBe("0.3.9");
});

const waitFor = async (condition: () => Promise<boolean>, what: string) => {
  const at = Date.now();
  while (!(await condition())) {
    if (Date.now() - at > 5_000) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
};

const existsRecorded = () => Bun.file(join(dir, "app-version")).exists();

test("with no argument it installs the recorded version; --version installs that one", async () => {
  const a = harness({ recorded: async () => "0.3.5" });
  expect(await runUpdate(a.deps)).toBe(0);
  expect(a.calls.installs).toEqual(["v0.3.5"]);
  expect(a.calls.downloads[0]).toContain("/download/v0.3.5/install.sh");
  expect(a.calls.downloads[1]).toEndWith("/install.sh.sha256");
  const b = harness({ recorded: async () => "0.3.5", requested: "0.3.8" });
  expect(await runUpdate(b.deps)).toBe(0);
  expect(b.calls.installs).toEqual(["v0.3.8"]);
});

test("with neither a recorded version nor --version it refuses and says how", async () => {
  const h = harness();
  expect(await runUpdate(h.deps)).not.toBe(0);
  expect(h.calls.downloads).toEqual([]);
  expect(h.calls.installs).toEqual([]);
  expect(h.said.join("\n")).toContain("--version");
});

test("a wrong sha256 or a failed download installs nothing and fails", async () => {
  const bad = harness({
    recorded: async () => "0.3.5",
    download: async (url) =>
      url.endsWith(".sha256") ? new TextEncoder().encode(`${"0".repeat(64)}  install.sh`) : SCRIPT,
    isRunning: async () => true,
  });
  expect(await runUpdate(bad.deps)).toBe(1);
  expect(bad.calls.installs).toEqual([]);
  expect(bad.calls.stops).toEqual([]);
  expect(bad.said.join("\n")).toContain("does not match");

  const down = harness({
    recorded: async () => "0.3.5",
    download: async () => {
      throw new Error("HTTP 404");
    },
    isRunning: async () => true,
  });
  expect(await runUpdate(down.deps)).toBe(1);
  expect(down.calls.installs).toEqual([]);
  expect(down.calls.stops).toEqual([]);
  expect(down.said.join("\n")).toContain("HTTP 404");
});

test("a failed installer leaves the running daemon alone", async () => {
  const h = harness({
    recorded: async () => "0.3.5",
    runInstaller: async () => 1,
    isRunning: async () => true,
  });
  expect(await runUpdate(h.deps)).toBe(1);
  expect(h.calls.stops).toEqual([]);
  expect(h.calls.starts).toBe(0);
});

test("the version it already is: nothing is downloaded or changed", async () => {
  const h = harness({ recorded: async () => "0.3.1", isRunning: async () => true });
  expect(await runUpdate(h.deps)).toBe(0);
  expect(h.calls.downloads).toEqual([]);
  expect(h.calls.stops).toEqual([]);
  expect(h.said.join("\n")).toContain("Already 0.3.1");
});

test("a program inside the desktop app is not replaced", async () => {
  const h = harness({
    recorded: async () => "0.3.5",
    install: installOf("/Applications/Cycle.app/Contents/Resources/bin/cycle", true),
  });
  expect(await runUpdate(h.deps)).not.toBe(0);
  expect(h.calls.downloads).toEqual([]);
  expect(h.said.join("\n")).toContain("updated with it");
});

test("where a program is decides whether it can be replaced", () => {
  expect(installOf("/home/u/.local/share/cycle/cycle", true, "linux")).toEqual({
    kind: "installed",
    prefix: "/home/u/.local",
  });
  expect(installOf("/usr/bin/bun", false, "linux").kind).toBe("source");
  expect(installOf("/opt/x/cycle", true, "linux").kind).toBe("unknown");
  expect(installOf("/Users/u/.local/share/cycle/cycle", true, "darwin").kind).toBe("unsupported");
});

test("with no daemon running only the program is replaced", async () => {
  const h = harness({ recorded: async () => "0.3.5" });
  expect(await runUpdate(h.deps)).toBe(0);
  expect(h.calls.installs).toEqual(["v0.3.5"]);
  expect(h.calls.stops).toEqual([]);
  expect(h.calls.starts).toBe(0);
});

/** What `cycle update` does with a daemon: stop it as `cycle stop` does, then start one on the same socket. */
const switching = (
  socket: string,
  stop: () => Promise<void>,
  started: { new?: () => Promise<void> },
) => ({
  isRunning: () => isListening(socket),
  stop: (force: boolean) =>
    stopDaemon({
      force,
      wait: !force,
      interactive: false,
      isRunning: () => isListening(socket),
      working: () => askWorking(socket, 2_000),
      choose: async () => "cancel" as const,
      signal: () => void stop(),
      say: () => {},
      pollMs: 20,
      stopWithinMs: 2_000,
    }),
  start: async (_installed: string) => {
    const next = await serve();
    started.new = next.stop;
    return isListening(socket);
  },
});

test("it waits for a running turn to end, then the new daemon is already listening", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { daemon, socket, stop } = await serve(fakeAgent({ onPrompt: () => held }));
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "go" }],
  });
  const started: { new?: () => Promise<void> } = {};
  const h = harness({ recorded: async () => "0.3.5", ...switching(socket, stop, started) });
  const updating = runUpdate(h.deps);
  await until(() => h.calls.installs.length === 1, "the install");
  await Bun.sleep(150);
  // The program is replaced, but the daemon with a turn running is not touched.
  expect(await isListening(socket)).toBe(true);
  expect(started.new).toBeUndefined();
  release();
  await until(() => c.ended() === 1, "the turn to end");
  expect(await updating).toBe(0);
  expect(started.new).toBeDefined();
  expect(await isListening(socket)).toBe(true);
  expect(h.said.at(-1)).toContain("listening");
});

test("--now switches over a running turn without waiting", async () => {
  const { daemon, socket, stop } = await serve(
    fakeAgent({ onPrompt: () => new Promise(() => {}) }),
  );
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "go" }],
  });
  const started: { new?: () => Promise<void> } = {};
  const h = harness({
    recorded: async () => "0.3.5",
    now: true,
    ...switching(socket, stop, started),
  });
  expect(await runUpdate(h.deps)).toBe(0);
  expect(started.new).toBeDefined();
  expect(await isListening(socket)).toBe(true);
});

test("the recorded version file holds just the version", async () => {
  const { socket } = await serve();
  const client = new CycleClient({ connect: () => connectUnix(socket), appVersion: "1.2.3" });
  await client.start();
  await client.close();
  await until(() => Bun.file(join(dir, "app-version")).size > 0, "the file");
  expect((await readFile(join(dir, "app-version"), "utf8")).trim()).toBe("1.2.3");
});

test("the same version with an older daemon still running switches it over, without installing", async () => {
  let running = true;
  const h = harness({
    recorded: async () => "0.3.1",
    isRunning: async () => running,
    runningVersion: async () => "0.3.0",
    stop: async () => {
      running = false;
      return 0;
    },
  });
  expect(await runUpdate(h.deps)).toBe(0);
  expect(h.calls.installs).toEqual([]);
  expect(h.calls.starts).toBe(1);
  const same = harness({
    recorded: async () => "0.3.1",
    isRunning: async () => true,
    runningVersion: async () => "0.3.1",
  });
  expect(await runUpdate(same.deps)).toBe(0);
  expect(same.calls.starts).toBe(0);
});

test("a lower target is a downgrade and is warned about; macOS is refused up front", async () => {
  const h = harness({ recorded: async () => "0.3.0" });
  expect(await runUpdate(h.deps)).toBe(0);
  expect(h.said.join("\n")).toContain("downgrade");
  const mac = harness({
    recorded: async () => "0.3.5",
    install: installOf("/Users/u/.local/share/cycle/cycle", true, "darwin"),
  });
  expect(await runUpdate(mac.deps)).toBe(2);
  expect(mac.calls.downloads).toEqual([]);
  expect(mac.said.join("\n")).toContain("Linux");
});

test("a daemon is started from the program that was just put in place, not the one that was running", async () => {
  // The installer replaces the file with a rename: what was there is a different file from what is there now.
  const bin = join(dir, "share-cycle");
  const mark = join(dir, "started-by");
  const script = (name: string) => `#!/bin/sh\necho ${name} > "${mark}"\n`;
  await Bun.write(bin, script("old"));
  await Bun.write(`${bin}.new`, script("new"));
  await chmod(bin, 0o755);
  await chmod(`${bin}.new`, 0o755);
  await rename(`${bin}.new`, bin);
  startDetached(pathsFor(dir), [bin]);
  await waitFor(async () => await Bun.file(mark).exists(), "the program to run");
  expect((await readFile(mark, "utf8")).trim()).toBe("new");
});

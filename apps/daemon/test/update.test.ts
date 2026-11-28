import { afterEach, beforeEach, expect, test } from "bun:test";
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

/** `runUpdate` with everything outside the process faked: what was staged, switched and started, and what it said. */
const harness = (over: Partial<UpdateDeps> = {}) => {
  const said: string[] = [];
  const calls = { stages: 0, swaps: 0, starts: 0, stops: [] as boolean[] };
  const deps: UpdateDeps = {
    version: "0.3.1",
    requested: undefined,
    now: false,
    install: { kind: "installed", prefix: "/home/u/.local" },
    installDir: "/home/u/.local/share/cycle",
    stage: async () => {
      calls.stages += 1;
      return { staged: { version: "0.3.5" } };
    },
    isRunning: async () => false,
    stop: async (force) => {
      calls.stops.push(force);
      return 0;
    },
    start: async () => {
      calls.starts += 1;
      return true;
    },
    swap: async () => {
      calls.swaps += 1;
    },
    stillStaged: async () => true,
    selfUpdating: async () => true,
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

test("it stages the newest version on the channel and, with no daemon running, switches the folder", async () => {
  const h = harness();
  expect(await runUpdate(h.deps)).toBe(0);
  expect(h.calls).toEqual({ stages: 1, swaps: 1, starts: 0, stops: [] });
  expect(h.said.join("\n")).toContain("Installed 0.3.5");
});

test("--version is refused: the channel has only its newest", async () => {
  const h = harness({ requested: "0.3.8" });
  expect(await runUpdate(h.deps)).toBe(2);
  expect(h.calls.stages).toBe(0);
});

test("a failed download changes nothing", async () => {
  const h = harness({ stage: async () => ({ error: "HTTP 404" }), isRunning: async () => true });
  expect(await runUpdate(h.deps)).toBe(1);
  expect(h.calls).toEqual({ stages: 0, swaps: 0, starts: 0, stops: [] });
  expect(h.said.join("\n")).toContain("HTTP 404");
});

test("already the newest: nothing is switched or stopped", async () => {
  const h = harness({ stage: async () => ({}), isRunning: async () => true });
  expect(await runUpdate(h.deps)).toBe(0);
  expect(h.calls.stops).toEqual([]);
  expect(h.calls.swaps).toBe(0);
  expect(h.said.join("\n")).toContain("Already the newest");
});

test("a program inside the desktop app is not replaced", async () => {
  const h = harness({
    install: installOf("/Applications/Cycle.app/Contents/Resources/bin/cycle", true),
  });
  expect(await runUpdate(h.deps)).toBe(2);
  expect(h.calls.stages).toBe(0);
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
  // Where the app puts it (CYC-538), on any platform.
  expect(installOf("/Users/u/.cycle/daemon/bin/cycle", true, "darwin").kind).toBe("managed");
  expect(installOf("/home/u/.cycle/daemon/bin/cycle", true, "linux").kind).toBe("managed");
  expect(installOf("/Users/u/.cycle/daemon/bin/cycle", false, "darwin").kind).toBe("source");
});

test("a daemon that will not stop keeps running the old version, and is told what happens next", async () => {
  const h = harness({ isRunning: async () => true, stop: async () => 4 });
  expect(await runUpdate(h.deps)).toBe(1);
  expect(h.calls.swaps).toBe(0);
  expect(h.said.join("\n")).toContain("switches by itself");
  // One that does not update itself is not said to.
  const off = harness({
    isRunning: async () => true,
    stop: async () => 4,
    selfUpdating: async () => false,
  });
  expect(await runUpdate(off.deps)).toBe(1);
  expect(off.said.join("\n")).not.toContain("switches by itself");
  expect(off.said.join("\n")).toContain("cycle stop --wait");
});

test("a daemon that switched by itself while this waited is not switched again, and is started", async () => {
  const h = harness({ isRunning: async () => true, stillStaged: async () => false });
  expect(await runUpdate(h.deps)).toBe(0);
  expect(h.calls.swaps).toBe(0);
  expect(h.calls.starts).toBe(1);
});

test("a switch that fails starts the current version again", async () => {
  const h = harness({
    isRunning: async () => true,
    swap: async () => {
      throw new Error("ENOENT");
    },
  });
  expect(await runUpdate(h.deps)).toBe(1);
  expect(h.calls.starts).toBe(1);
  expect(h.said.join("\n")).toContain("started again");
});

/** What `cycle update` does with a daemon: stop it as `cycle stop` does, then start one on the same socket. */
const switching = (
  socket: string,
  stop: () => Promise<void>,
  started: { new?: () => Promise<void> },
  say: (line: string) => void = () => {},
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
      say,
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
  const messages: string[] = [];
  const h = harness({ ...switching(socket, stop, started, (line) => messages.push(line)) });
  const updating = runUpdate(h.deps);
  await until(
    () => messages.some((line) => line.startsWith("Waiting for them to finish")),
    "the updater to observe the running turn",
    1_000,
  );
  expect(h.calls.stages).toBe(1);
  // The version is ready, but the daemon with a turn running is not touched.
  expect(await isListening(socket)).toBe(true);
  expect(started.new).toBeUndefined();
  release();
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
  const h = harness({ now: true, ...switching(socket, stop, started) });
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

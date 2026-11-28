// The daemon updating itself (docs/daemon.md "自动更新", CYC-538): what it takes from the channel and what it refuses,
// how it builds the next version from the installed files and the channel, when it switches, and how a switch is undone.
// The channel is served on a loopback port; the folders are temporary.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { blobName, daemonManifestName, daemonSignatureName } from "../src/channel.ts";
import { Daemon } from "../src/index.ts";
import { RELEASE_KEYS, type ReleaseKeys, verifySignature } from "../src/release-keys.ts";
import {
  forgetOld,
  oldDir,
  putStaged,
  readStaged,
  recordBad,
  SelfUpdate,
  type SelfUpdateDeps,
  stagedDir,
  swapBack,
  swapIn,
  whyNotUpdatable,
} from "../src/self-update.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
let servers: { stop: () => void }[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  for (const server of servers) server.stop();
  servers = [];
  await dispose();
});

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEYS: ReleaseKeys = {
  t1: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
};
const other = generateKeyPairSync("ed25519").privateKey;

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string) => new TextEncoder().encode(text);

type Files = Record<string, string>;

/** A manifest for these files, as the publisher makes one. */
const manifestFor = (files: Files, over: Record<string, unknown> = {}) => ({
  v: 1,
  kind: "daemon",
  version: "0.3.200",
  commit: "abcdef1",
  platform: "linux",
  arch: "x64",
  protocol: "0.2",
  inputs: "f".repeat(64),
  keyId: "t1",
  files: Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      path,
      { sha256: sha(text), size: bytesOf(text).length, mode: path === "cycle" ? 0o755 : 0o644 },
    ]),
  ),
  ...over,
});

/** A channel on a loopback port: the manifest, its signature, and the blobs. What was asked for is counted. */
const channel = (
  manifest: unknown,
  files: Files,
  options: { key?: typeof privateKey; status?: number } = {},
) => {
  const text = JSON.stringify(manifest);
  const signature = sign(null, Buffer.from(text), options.key ?? privateKey).toString("base64");
  const asked: string[] = [];
  const blobs = new Map(Object.values(files).map((t) => [blobName(sha(t)), Bun.gzipSync(t)]));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const name = new URL(request.url).pathname.slice(1);
      asked.push(name);
      if (options.status !== undefined) return new Response("", { status: options.status });
      if (name === daemonManifestName("linux", "x64"))
        return request.headers.get("if-none-match") === '"m1"'
          ? new Response(null, { status: 304 })
          : new Response(text, { headers: { etag: '"m1"' } });
      if (name === daemonSignatureName("linux", "x64")) return new Response(signature);
      const blob = blobs.get(name);
      return blob !== undefined ? new Response(blob) : new Response("", { status: 404 });
    },
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}/`, asked };
};

/** An installed daemon folder with these files. */
const installed = async (files: Files) => {
  const installDir = join(dir, "share", "cycle");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(installDir, path, ".."), { recursive: true });
    await writeFile(join(installDir, path), text);
  }
  return installDir;
};

const updater = (installDir: string, baseUrl: string, over: Partial<SelfUpdateDeps> = {}) => {
  const logged: string[] = [];
  const checked: string[] = [];
  const applied: string[] = [];
  const deps: SelfUpdateDeps = {
    version: "0.3.100",
    platform: "linux",
    arch: "x64",
    protocol: "0.2",
    installDir,
    keys: KEYS,
    verify: verifySignature,
    fetch,
    baseUrl,
    stateFile: join(dir, "data", "daemon-update.json"),
    check: async (folder, version) => {
      checked.push(version);
      if (!existsSync(join(folder, "cycle"))) throw new Error("no daemon");
    },
    idle: async () => true,
    apply: async (staged) => {
      applied.push(staged.version);
    },
    log: { info: (event) => logged.push(event), warn: (event) => logged.push(event) },
    ...over,
  };
  return { update: new SelfUpdate(deps), logged, checked, applied };
};

const OLD = { cycle: "daemon v100", claude: "claude 2.1", "plugins/a.json": "{}" };
const NEW = { cycle: "daemon v200", claude: "claude 2.1", "plugins/a.json": "{}" };

test("a newer version is built from the installed files where they are the same, and the channel where not", async () => {
  const installDir = await installed(OLD);
  const c = channel(manifestFor(NEW), NEW);
  const { update, checked } = updater(installDir, c.baseUrl);
  const state = await update.check();
  expect(state).toEqual({ updates: "on", pending: { version: "0.3.200" } });
  expect(checked).toEqual(["0.3.200"]);
  // Only the daemon changed: only its file was downloaded.
  expect(c.asked.filter((n) => n.startsWith("daemon-blob-"))).toEqual([blobName(sha(NEW.cycle))]);
  for (const [path, text] of Object.entries(NEW))
    expect(await readFile(join(stagedDir(installDir), path), "utf8")).toBe(text);
  expect(await readStaged(installDir)).toEqual({ version: "0.3.200" });
  // The running folder is untouched.
  expect(await readFile(join(installDir, "cycle"), "utf8")).toBe(OLD.cycle);
});

test("a manifest that is not signed by a built-in key, not a daemon's, or for another platform is not taken", async () => {
  const installDir = await installed(OLD);
  const cases = [
    [channel(manifestFor(NEW), NEW, { key: other }), "signature_refused"],
    [channel(manifestFor(NEW, { keyId: "nope" }), NEW), "signature_refused"],
    [channel(manifestFor(NEW, { kind: "ui" }), NEW), "manifest_invalid"],
    [channel(manifestFor(NEW, { arch: "arm64" }), NEW), "wrong_platform"],
    [
      channel(
        manifestFor(NEW, { files: { claude: { sha256: sha("x"), size: 1, mode: 0o755 } } }),
        NEW,
      ),
      "manifest_invalid",
    ],
  ] as const;
  for (const [c, why] of cases) {
    const { update } = updater(installDir, c.baseUrl);
    const state = await update.check();
    // Said, so that `cycle update` does not take it for "nothing newer".
    expect(state).toEqual({ updates: "on", skipped: why });
    expect(c.asked.some((n) => n.startsWith("daemon-blob-"))).toBe(false);
  }
  expect(existsSync(stagedDir(installDir))).toBe(false);
});

test("the same or an older version, one that failed before, or another protocol major is not taken", async () => {
  const installDir = await installed(OLD);
  const same = updater(installDir, channel(manifestFor(NEW, { version: "0.3.100" }), NEW).baseUrl);
  expect((await same.update.check()).updates === "on" && !("pending" in same.update.state)).toBe(
    true,
  );
  const major = updater(installDir, channel(manifestFor(NEW, { protocol: "1.0" }), NEW).baseUrl);
  await major.update.check();
  expect(major.update.state).toEqual({ updates: "on", skipped: "needs_manual_update" });
  expect(major.logged).toContain("self_update_needs_manual_update");
  const bad = updater(installDir, channel(manifestFor(NEW), NEW).baseUrl);
  await recordBad(join(dir, "data", "daemon-update.json"), "0.3.200");
  await bad.update.check();
  expect(bad.update.state).toEqual({ updates: "on", skipped: "failed_before" });
  expect(existsSync(stagedDir(installDir))).toBe(false);
});

test("a file that is not what the manifest says stages nothing, and the check fails quietly", async () => {
  const installDir = await installed(OLD);
  const wrong = { ...NEW, cycle: "tampered" };
  const manifest = manifestFor(NEW);
  // The blob served for the daemon's hash is other bytes.
  const c = channel(manifest, { ...wrong, extra: NEW.cycle });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const name = new URL(request.url).pathname.slice(1);
      if (name === blobName(sha(NEW.cycle))) return new Response(Bun.gzipSync("tampered!!!"));
      return fetch(`${c.baseUrl}${name}`);
    },
  });
  servers.push(server);
  const { update, logged } = updater(installDir, `http://127.0.0.1:${server.port}/`);
  const state = await update.check();
  expect(state.updates === "on" && state.error).toContain("not what its manifest says");
  expect(logged).toContain("self_update_check_failed");
  expect(existsSync(stagedDir(installDir))).toBe(false);
  expect(existsSync(`${installDir}.staging-${process.pid}`)).toBe(false);
});

test("a folder that fails its check is not staged", async () => {
  const installDir = await installed(OLD);
  const c = channel(manifestFor(NEW), NEW);
  const { update } = updater(installDir, c.baseUrl, {
    check: async () => {
      throw new Error("The new daemon says it is nothing, not 0.3.200.");
    },
  });
  const state = await update.check();
  expect(state.updates === "on" && state.error).toContain("says it is nothing");
  expect(await readStaged(installDir)).toBeUndefined();
});

test("an unchanged manifest is not read again (ETag), and a channel with nothing is quiet", async () => {
  const installDir = await installed(OLD);
  const c = channel(manifestFor(NEW, { version: "0.3.50" }), NEW);
  const { update } = updater(installDir, c.baseUrl);
  await update.check();
  await update.check();
  expect(c.asked.filter((n) => n === daemonSignatureName("linux", "x64"))).toHaveLength(1);
  const none = updater(installDir, channel(manifestFor(NEW), NEW, { status: 404 }).baseUrl);
  expect(await none.update.check()).toEqual({ updates: "on" });
});

test("it switches only when the daemon is idle, to the version staged", async () => {
  const installDir = await installed(OLD);
  let idle = false;
  const c = channel(manifestFor(NEW), NEW);
  const { update, applied } = updater(installDir, c.baseUrl, { idle: async () => idle });
  expect(await update.tryApply()).toBe(false);
  await update.check();
  expect(await update.tryApply()).toBe(false);
  expect(applied).toEqual([]);
  idle = true;
  expect(await update.tryApply()).toBe(true);
  expect(applied).toEqual(["0.3.200"]);
});

test("a version the app staged is taken when newer, and thrown away when not", async () => {
  const installDir = await installed(OLD);
  const ready = join(dir, "ready");
  await mkdir(ready);
  await writeFile(join(ready, "cycle"), "daemon v300");
  await putStaged(installDir, ready, "0.3.300");
  const { update, applied } = updater(installDir, "http://127.0.0.1:9/");
  expect(await update.tryApply()).toBe(true);
  expect(applied).toEqual(["0.3.300"]);

  const older = join(dir, "older");
  await mkdir(older);
  await writeFile(join(older, "cycle"), "daemon v50");
  await putStaged(installDir, older, "0.3.50");
  const second = updater(installDir, "http://127.0.0.1:9/");
  expect(await second.update.tryApply()).toBe(false);
  expect(existsSync(stagedDir(installDir))).toBe(false);
});

test("a switch puts the staged folder in place and keeps the old one; going back restores it", async () => {
  const installDir = await installed(OLD);
  const c = channel(manifestFor(NEW), NEW);
  await updater(installDir, c.baseUrl).update.check();
  await swapIn(installDir);
  expect(await readFile(join(installDir, "cycle"), "utf8")).toBe(NEW.cycle);
  expect(await readFile(join(oldDir(installDir), "cycle"), "utf8")).toBe(OLD.cycle);
  expect(await readStaged(installDir)).toBeUndefined();
  await swapBack(installDir);
  expect(await readFile(join(installDir, "cycle"), "utf8")).toBe(OLD.cycle);
  expect(existsSync(oldDir(installDir))).toBe(false);
  // After a version has proved itself the one before goes.
  await updater(installDir, c.baseUrl).update.check();
  await swapIn(installDir);
  await forgetOld(installDir);
  expect(existsSync(oldDir(installDir))).toBe(false);
});

test("a switch that cannot rename the staged folder leaves the running one where it was", async () => {
  const installDir = await installed(OLD);
  await expect(swapIn(installDir)).rejects.toThrow();
  expect(await readFile(join(installDir, "cycle"), "utf8")).toBe(OLD.cycle);
});

test("only a release, installed where an installer puts it, with a key, updates itself", () => {
  const base = { version: "0.3.1", keys: KEYS, env: {} };
  expect(whyNotUpdatable({ ...base, install: { kind: "installed" } })).toBeUndefined();
  expect(whyNotUpdatable({ ...base, install: { kind: "managed" } })).toBeUndefined();
  expect(whyNotUpdatable({ ...base, version: "dev", install: { kind: "managed" } })).toBeDefined();
  expect(whyNotUpdatable({ ...base, install: { kind: "bundled" } })).toBeDefined();
  expect(whyNotUpdatable({ ...base, install: { kind: "source" } })).toBeDefined();
  expect(whyNotUpdatable({ ...base, keys: {}, install: { kind: "managed" } })).toBeDefined();
  expect(
    whyNotUpdatable({
      ...base,
      env: { CYCLE_DAEMON_UPDATES: "off" },
      install: { kind: "managed" },
    }),
  ).toBeDefined();
});

test("the daemon's key is the app's interface key", async () => {
  const { UI_KEYS } = await import("../../desktop/src/main/ui-keys.ts");
  expect(RELEASE_KEYS).toEqual(UI_KEYS);
});

test("the daemon counts as idle for a switch only with no turn, after a quiet while", async () => {
  let clock = 1_000_000;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeAgent({ onPrompt: () => held });
  const daemon = await Daemon.start({
    dataDir: join(dir, "data"),
    agents: [fake.definition],
    now: () => clock,
  });
  try {
    expect(await daemon.quietForUpdate(60_000)).toBe(true);
    const c = await connectClient(daemon);
    const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
    await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
    await c.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    // A turn is running; a client connected does not count against it.
    expect(await daemon.quietForUpdate(60_000)).toBe(false);
    release();
    await until(() => c.ended() === 1, "the turn to end");
    expect(await daemon.quietForUpdate(60_000)).toBe(false);
    clock += 61_000;
    expect(await daemon.quietForUpdate(60_000)).toBe(true);
  } finally {
    await daemon.close();
  }
});

test("a look at the channel does not start while a switch is deciding", async () => {
  const installDir = await installed(OLD);
  const c = channel(manifestFor(NEW), NEW);
  let decide: (idle: boolean) => void = () => {};
  const { update } = updater(installDir, c.baseUrl, {
    idle: () =>
      new Promise<boolean>((resolve) => {
        decide = resolve;
      }),
  });
  const ready = join(dir, "ready");
  await mkdir(ready);
  await writeFile(join(ready, "cycle"), "daemon v150");
  await putStaged(installDir, ready, "0.3.150");
  const switching = update.tryApply();
  await Bun.sleep(20);
  await update.check();
  expect(c.asked).toEqual([]);
  decide(false);
  expect(await switching).toBe(false);
});

const staged = async (installDir: string, version = "0.3.150") => {
  const ready = join(dir, `ready-${version}`);
  await mkdir(ready);
  await writeFile(join(ready, "cycle"), `daemon v${version}`);
  await putStaged(installDir, ready, version);
};

test("a version waits, then drains after drainAfter, then forces after forceAfter, and says so", async () => {
  const installDir = await installed(OLD);
  await staged(installDir);
  let clock = 0;
  const working = true;
  const calls: string[] = [];
  const { update, applied, logged } = updater(installDir, "http://127.0.0.1:1", {
    now: () => clock,
    idle: async () => !working,
    drained: async () => !working,
    setDraining: (on) => calls.push(`draining:${on}`),
    forced: async () => ({ sessions: 2, background: 3 }),
    changed: () => calls.push("changed"),
    drainAfterMs: 15 * 60_000,
    forceAfterMs: 10 * 60_000,
  });
  expect(await update.tryApply()).toBe(false);
  expect(update.state).toMatchObject({ phase: { state: "waiting", since: 0 } });
  clock = 14 * 60_000;
  expect(await update.tryApply()).toBe(false);
  expect(update.state).toMatchObject({ phase: { state: "waiting" } });
  clock = 15 * 60_000;
  expect(await update.tryApply()).toBe(false);
  expect(update.state).toMatchObject({
    phase: { state: "draining", since: clock, forceAt: clock + 10 * 60_000 },
  });
  expect(calls).toContain("draining:true");
  expect(logged).toContain("self_update_draining");
  clock += 9 * 60_000;
  expect(await update.tryApply()).toBe(false);
  expect(applied).toEqual([]);
  clock += 60_000;
  expect(await update.tryApply()).toBe(true);
  expect(applied).toEqual(["0.3.150"]);
  expect(logged).toContain("self_update_forced");
});

test("draining switches at once when nothing is left, without the quiet time", async () => {
  const installDir = await installed(OLD);
  await staged(installDir);
  let clock = 0;
  const quiet = false;
  let drained = false;
  const { update, applied, logged } = updater(installDir, "http://127.0.0.1:1", {
    now: () => clock,
    idle: async () => quiet,
    drained: async () => drained,
    drainAfterMs: 60_000,
  });
  expect(await update.tryApply()).toBe(false);
  clock = 60_000;
  expect(await update.tryApply()).toBe(false);
  drained = true;
  expect(await update.tryApply()).toBe(true);
  expect(applied).toEqual(["0.3.150"]);
  expect(logged).not.toContain("self_update_forced");
});

test("with both limits 0 there is only waiting, and a failed switch ends draining", async () => {
  const installDir = await installed(OLD);
  await staged(installDir);
  let clock = 0;
  const calls: string[] = [];
  const { update } = updater(installDir, "http://127.0.0.1:1", {
    now: () => clock,
    idle: async () => false,
    setDraining: (on) => calls.push(`draining:${on}`),
  });
  await update.tryApply();
  clock = 24 * 3_600_000;
  await update.tryApply();
  expect(update.state).toMatchObject({ phase: { state: "waiting" } });
  expect(calls).toEqual([]);

  const failing = updater(installDir, "http://127.0.0.1:1", {
    now: () => clock,
    idle: async () => false,
    drained: async () => true,
    setDraining: (on) => calls.push(`draining:${on}`),
    drainAfterMs: 1,
    apply: async () => {
      throw new Error("cannot");
    },
  });
  await failing.update.tryApply();
  clock += 5;
  await failing.update.tryApply();
  expect(calls).toEqual(["draining:true", "draining:false"]);
  expect(failing.update.state).not.toHaveProperty("phase");
});

test("a turn that ends is looked at at once", async () => {
  const installDir = await installed(OLD);
  await staged(installDir);
  const { update, applied } = updater(installDir, "http://127.0.0.1:1", {
    setTimeout: (() => 0) as unknown as typeof setTimeout,
    clearInterval: (() => {}) as unknown as typeof clearInterval,
  });
  update.nudge();
  await until(() => applied.length === 1, "the look");
});

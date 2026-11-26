import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateState } from "@cycle/ui/api";
import { scanBundle } from "../src/main/delta.ts";
import {
  SWAP_SCRIPT,
  type Swap,
  teamOf,
  Updater,
  verifyBySource,
  verifySameTeam,
} from "../src/main/updater.ts";
import { archiveName, manifestFor, manifestName, type TreeEntry } from "../src/shared/release.ts";
import { makeZip, type Spec, unzip, writeBundle, type ZipOptions } from "./zip-fixture.ts";

const REPO = "o/r";
const PLATFORM = { platform: "darwin", arch: "arm64" };

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let base: string;
/** What the fake GitHub answers, and what was asked of it. */
const github = {
  releases: [] as unknown[],
  requests: [] as { path: string; ifNoneMatch: string | null }[],
  files: new Map<string, Uint8Array>(),
  status: 200,
  etag: '"v1"',
  /** Whether a range request is answered with the range (as GitHub does), and what was sent of an archive. */
  ranges: true,
  ranged: 0,
  /** What a range request is answered with when it is not 206. */
  rangeStatus: 0,
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-updater-"));
  github.releases = [];
  github.requests = [];
  github.files = new Map();
  github.status = 200;
  github.etag = '"v1"';
  github.ranges = true;
  github.ranged = 0;
  github.rangeStatus = 0;
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const ifNoneMatch = request.headers.get("if-none-match");
      github.requests.push({ path: url.pathname, ifNoneMatch });
      if (github.status !== 200) return new Response("no", { status: github.status });
      if (url.pathname === `/repos/${REPO}/releases`) {
        if (ifNoneMatch === github.etag) return new Response(null, { status: 304 });
        return Response.json(github.releases, { headers: { etag: github.etag } });
      }
      const file = github.files.get(url.pathname);
      if (!file) return new Response("missing", { status: 404 });
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
      if (range === null || !github.ranges) return new Response(Buffer.from(file));
      if (github.rangeStatus !== 0) return new Response("no", { status: github.rangeStatus });
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), file.length - 1);
      github.ranged += end - start + 1;
      return new Response(Buffer.from(file.subarray(start, end + 1)), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${file.length}` },
      });
    },
  });
  base = `http://localhost:${server.port}`;
});
afterEach(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Puts a release on the fake GitHub; its archive is these bytes. */
const publish = (
  version: string,
  options: {
    bytes?: Uint8Array;
    draft?: boolean;
    manifest?: boolean;
    claimedSha?: string;
    claimedSize?: number;
    tree?: TreeEntry[];
  } = {},
) => {
  const bytes = options.bytes ?? new TextEncoder().encode(`archive ${version}`);
  const manifest = manifestFor(
    { version, ...PLATFORM },
    { sha256: options.claimedSha ?? sha(bytes), size: options.claimedSize ?? bytes.length },
    options.tree,
  );
  const tag = `v${version}`;
  const assets: unknown[] = [];
  const add = (name: string) => {
    assets.push({ name, browser_download_url: `${base}/dl/${tag}/${name}` });
  };
  add(archiveName(version, "darwin", "arm64"));
  github.files.set(`/dl/${tag}/${archiveName(version, "darwin", "arm64")}`, bytes);
  if (options.manifest !== false) {
    add(manifestName("darwin", "arm64"));
    github.files.set(
      `/dl/${tag}/${manifestName("darwin", "arm64")}`,
      new TextEncoder().encode(JSON.stringify(manifest)),
    );
  }
  github.releases.push({ tag_name: tag, draft: options.draft ?? false, assets });
};

/** The archive here is not a zip; the fake unpacks a bundle of the version the manifest names. */
const fakeExtract = async (zip: string, into: string) => {
  const app = join(into, "Cycle.app", "Contents/Resources/app");
  await mkdir(app, { recursive: true });
  const version = (await readFile(zip, "utf8")).replace("archive ", "");
  await writeFile(join(app, "build.json"), JSON.stringify({ version, ...PLATFORM }));
};

const make = (over: Partial<ConstructorParameters<typeof Updater>[0]> = {}) => {
  const states: UpdateState[] = [];
  const log: string[] = [];
  const swaps: Swap[] = [];
  const notes: string[] = [];
  const updater = new Updater({
    current: { version: "0.1.0", ...PLATFORM },
    appPath: join(dir, "apps", "Cycle.app"),
    repo: REPO,
    apiBase: base,
    assetPrefix: `${base}/dl/`,
    fetch,
    handOff: async (swap) => {
      log.push("handOff");
      swaps.push(swap);
    },
    quit: () => log.push("quit"),
    emit: (state) => states.push(state),
    log: (message) => notes.push(message),
    ...over,
    extract: async (zip, into) => {
      log.push("extract");
      await (over.extract ?? fakeExtract)(zip, into);
    },
  });
  return { updater, states, log, swaps, notes };
};

test("with nothing newer it says it is up to date, and a second ask is answered by GitHub with 'not modified'", async () => {
  publish("0.1.0");
  const { updater } = make();
  expect((await updater.check(false)).kind).toBe("up-to-date");
  expect((await updater.check(false)).kind).toBe("up-to-date");
  const asks = github.requests.filter((r) => r.path.endsWith("/releases"));
  expect(asks[0]?.ifNoneMatch).toBeNull();
  expect(asks[1]?.ifNoneMatch).toBe('"v1"');
});

test("it picks the newest release, skipping drafts and releases without this platform's manifest", async () => {
  publish("0.1.1");
  publish("0.3.0", { draft: true });
  publish("0.2.0", { manifest: false });
  publish("0.1.5");
  const { updater } = make();
  const state = await updater.check(false);
  expect(state).toMatchObject({ kind: "available", version: "0.1.5" });
});

test("a release that is not newer, or whose tag is not a version, is no update", async () => {
  publish("0.0.9");
  github.releases.push({ tag_name: "nightly", draft: false, assets: [] });
  const { updater } = make();
  expect((await updater.check(false)).kind).toBe("up-to-date");
});

test("a tag with a `-` is never chosen, and the release beside it is", async () => {
  publish("0.9.0-alpha.5");
  publish("0.8.0-beta");
  publish("0.1.5");
  const { updater } = make();
  expect(await updater.check(false)).toMatchObject({ kind: "available", version: "0.1.5" });
});

test("a check that fails on the timer says nothing, and one the user asked for says why", async () => {
  github.status = 403;
  const { updater, states } = make();
  await updater.check(false);
  expect(states).toEqual([]);
  const state = await updater.check(true);
  expect(state).toMatchObject({ kind: "error" });
  expect((state as { message: string }).message).toMatch(/limiting/);
  // The next good answer clears it.
  github.status = 200;
  expect((await updater.check(true)).kind).toBe("up-to-date");
});

test("it installs: downloads, checks, unpacks, hands off and quits, in that order", async () => {
  publish("0.2.0");
  await mkdir(join(dir, "apps"), { recursive: true });
  const { updater, states, log, swaps } = make();
  await updater.check(false);
  await updater.install();
  expect(log).toEqual(["extract", "handOff", "quit"]);
  expect(states.map((s) => s.kind)).toEqual([
    "available",
    "downloading",
    "downloading",
    "installing",
  ]);
  const swap = swaps[0];
  expect(swap?.appPath).toBe(join(dir, "apps", "Cycle.app"));
  expect(existsSync(join(swap?.newApp ?? "", "Contents/Resources/app/build.json"))).toBe(true);
  // Beside the app, so the swap is a rename.
  expect(swap?.newApp.startsWith(join(dir, "apps"))).toBe(true);
});

test("an archive that does not match its checksum is not installed, and leaves nothing behind", async () => {
  publish("0.2.0", { claimedSha: "0".repeat(64) });
  await mkdir(join(dir, "apps"), { recursive: true });
  const { updater, log, states } = make();
  await updater.check(false);
  await expect(updater.install()).rejects.toThrow(/checksum/);
  expect(log).toEqual([]);
  expect(await readdir(join(dir, "apps"))).toEqual([]);
  expect(states.at(-1)).toMatchObject({ kind: "error", version: "0.2.0" });
});

test("an archive larger or smaller than its manifest says is refused", async () => {
  await mkdir(join(dir, "apps"), { recursive: true });
  publish("0.2.0", { claimedSize: 3 });
  const first = make();
  await first.updater.check(false);
  await expect(first.updater.install()).rejects.toThrow(/larger/);

  github.releases = [];
  publish("0.3.0", { claimedSize: 10_000 });
  const second = make();
  await second.updater.check(false);
  await expect(second.updater.install()).rejects.toThrow(/incomplete/);
});

test("a download outside the allowed place is refused", async () => {
  publish("0.2.0");
  const { updater } = make({ assetPrefix: "https://github.com/o/r/releases/download/" });
  const state = await updater.check(true);
  expect(state).toMatchObject({ kind: "error" });
  expect((state as { message: string }).message).toMatch(/Refused/);
});

test("a manifest for another version than its release is refused", async () => {
  publish("0.2.0");
  const other = manifestFor({ version: "0.9.0", ...PLATFORM }, { sha256: "a".repeat(64), size: 5 });
  github.files.set(
    `/dl/v0.2.0/${manifestName("darwin", "arm64")}`,
    new TextEncoder().encode(JSON.stringify(other)),
  );
  const { updater } = make();
  const state = await updater.check(true);
  expect((state as { message: string }).message).toMatch(/not for this release/);
});

test("an unpacked bundle that is not the version promised is refused before anything is touched", async () => {
  publish("0.2.0");
  await mkdir(join(dir, "apps"), { recursive: true });
  const { updater, log } = make({
    extract: async (_zip, into) => {
      const app = join(into, "Cycle.app", "Contents/Resources/app");
      await mkdir(app, { recursive: true });
      await writeFile(join(app, "build.json"), JSON.stringify({ version: "9.9.9", ...PLATFORM }));
    },
  });
  await updater.check(false);
  await expect(updater.install()).rejects.toThrow(/not the version/);
  expect(log).toEqual(["extract"]);
});

test("a folder the user cannot write to, or a translocated app, is told so before downloading", async () => {
  publish("0.2.0");
  const { updater } = make({ appPath: "/proc/nowhere/Cycle.app" });
  await updater.check(false);
  await expect(updater.install()).rejects.toThrow(/cannot replace itself/);
  const translocated = make({ appPath: "/private/var/folders/x/AppTranslocation/ABC/d/Cycle.app" });
  await translocated.updater.check(false);
  await expect(translocated.updater.install()).rejects.toThrow(/temporary read-only/);
  expect(
    github.requests.some((r) => r.path.startsWith("/dl/v0.2.0") && r.path.endsWith(".zip")),
  ).toBe(false);
});

test("there is nothing to install before something has been found, and a failed install can be tried again", async () => {
  const { updater } = make();
  await expect(updater.install()).rejects.toThrow(/no update/);
  publish("0.2.0", { claimedSha: "0".repeat(64) });
  await mkdir(join(dir, "apps"), { recursive: true });
  await updater.check(false);
  await expect(updater.install()).rejects.toThrow();
  // The timer does not wipe the error the user has not seen; their own check does.
  await updater.check(false);
  expect(updater.state.kind).toBe("error");
  expect((await updater.check(true)).kind).toBe("available");
});

test("not an installed app: nothing is asked of GitHub", async () => {
  publish("0.2.0");
  const { updater } = make({ disabled: "development" });
  updater.start();
  expect((await updater.check(true)).kind).toBe("disabled");
  await expect(updater.install()).rejects.toThrow(/development/);
  expect(github.requests).toEqual([]);
});

test("it checks at once and then every minute, and stops", async () => {
  publish("0.1.0");
  const calls: { fn: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];
  const { updater } = make({
    setInterval: (fn, ms) => {
      calls.push({ fn, ms });
      return "handle";
    },
    clearInterval: (h) => cleared.push(h),
  });
  // The check runs without being awaited: wait, within a bound, for the request it makes.
  const requests = async (n: number) => {
    for (let i = 0; i < 200 && github.requests.length < n; i += 1) await Bun.sleep(5);
    // A moment more, so that one too many would be seen.
    await Bun.sleep(20);
    expect(github.requests.length).toBe(n);
  };
  updater.start();
  expect(calls[0]?.ms).toBe(60_000);
  await requests(1);
  calls[0]?.fn();
  await requests(2);
  updater.stop();
  expect(cleared).toEqual(["handle"]);
});

test("a tick while a check is still going does not start another", async () => {
  publish("0.1.0");
  const { updater } = make();
  await Promise.all([updater.check(false), updater.check(false), updater.check(false)]);
  expect(github.requests.filter((r) => r.path.endsWith("/releases")).length).toBe(1);
});

// ---- the swap, run for real ----

const sh = async (script: string, args: string[]) => {
  const proc = Bun.spawn(["/bin/sh", "-c", script, "swap", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return proc;
};

const bundles = async () => {
  const apps = join(dir, "apps");
  const app = join(apps, "Cycle.app");
  const staging = join(apps, ".Cycle-update-0.2.0");
  const next = join(staging, "unpacked", "Cycle.app");
  await mkdir(app, { recursive: true });
  await mkdir(next, { recursive: true });
  await writeFile(join(app, "which"), "old");
  await writeFile(join(next, "which"), "new");
  const opener = join(dir, "open");
  await writeFile(opener, `#!/bin/sh\nprintf '%s\\n' "$*" > ${dir}/opened\n`);
  await chmod(opener, 0o755);
  return { apps, app, staging, next, old: join(apps, ".Cycle-old"), opener };
};

test("the swap script waits for the old app to go, puts the new bundle in place, removes the leftovers and opens it", async () => {
  const b = await bundles();
  const sleeper = Bun.spawn(["sleep", "0.3"]);
  const started = Date.now();
  await sh(SWAP_SCRIPT, [String(sleeper.pid), b.app, b.next, b.old, b.staging, b.opener]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  expect(await readFile(join(b.app, "which"), "utf8")).toBe("new");
  expect(await readdir(b.apps)).toEqual(["Cycle.app"]);
  expect((await readFile(join(dir, "opened"), "utf8")).trim()).toBe(`-n ${b.app}`);
});

test("if the new bundle cannot be put in place the old one is put back and still opened", async () => {
  const b = await bundles();
  await rm(b.next, { recursive: true });
  await sh(SWAP_SCRIPT, ["999999", b.app, b.next, b.old, b.staging, b.opener]);
  expect(await readFile(join(b.app, "which"), "utf8")).toBe("old");
  expect((await readFile(join(dir, "opened"), "utf8")).trim()).toBe(`-n ${b.app}`);
});

// ---- signatures ----

test("the team is read from codesign's listing; an ad hoc signature has none", () => {
  expect(teamOf("Identifier=dev.cycle.app\nTeamIdentifier=ABCDE12345\n")).toBe("ABCDE12345");
  expect(teamOf("Signature=adhoc\nTeamIdentifier=not set\n")).toBeUndefined();
  expect(teamOf("")).toBeUndefined();
});

test("a signed app takes only an update of the same team that verifies; an ad hoc one takes any", async () => {
  const listing = (team: string) => `TeamIdentifier=${team}\n`;
  const codesign =
    (teams: Record<string, string>, valid = true) =>
    async (args: string[]) => {
      if (args[0] === "--verify") {
        if (!valid) throw new Error("bad");
        return "";
      }
      const path = args.at(-1) ?? "";
      return teams[path] ?? "";
    };
  const ok = verifySameTeam(codesign({ cur: listing("T1"), next: listing("T1") }));
  await ok("next", "cur");
  const other = verifySameTeam(codesign({ cur: listing("T1"), next: listing("T2") }));
  await expect(other("next", "cur")).rejects.toThrow(/same team/);
  const broken = verifySameTeam(codesign({ cur: listing("T1"), next: listing("T1") }, false));
  await expect(broken("next", "cur")).rejects.toThrow(/not valid/);
  const adhoc = verifySameTeam(codesign({ cur: "TeamIdentifier=not set\n", next: listing("T2") }));
  await adhoc("next", "cur");
});

// ---- by the difference ----

const buildJson = (version: string) => JSON.stringify({ version, ...PLATFORM });
/** Something that does not compress, so that what is fetched can be told from what is not. */
const filler = Array.from({ length: 40_000 }, (_, i) => ((i * 2654435761) >>> 0).toString(36)).join(
  "",
);
const bundleOf = (version: string, extra: Spec = {}): Spec => ({
  "Contents/Resources/app/build.json": buildJson(version),
  "Contents/Resources/app/main.js": `main of ${version}`,
  "Contents/Frameworks/Electron": filler,
  "Contents/Frameworks/Current": { link: "Electron" },
  ...extra,
});

/** The app as installed at 0.1.0, and a release of `version` whose archive carries a file table. */
const installAndPublish = async (version: string, options: ZipOptions = {}, extra: Spec = {}) => {
  const installed = join(dir, "apps", "Cycle.app");
  await writeBundle(installed, bundleOf("0.1.0"));
  const spec = bundleOf(version, extra);
  const built = join(dir, `built-${version}`);
  await writeBundle(built, spec);
  const bytes = makeZip(spec, options);
  publish(version, { bytes, tree: await scanBundle(built) });
  return bytes;
};
const unpack = (updater: Partial<ConstructorParameters<typeof Updater>[0]> = {}) => ({
  extract: async (zip: string, into: string) => {
    await unzip(new Uint8Array(await readFile(zip)), into);
  },
  ...updater,
});

test("it updates by the difference: what is installed is reused and only what changed is fetched", async () => {
  const zip = await installAndPublish("0.2.0");
  const { updater, states, log, swaps, notes } = make(unpack());
  await updater.check(false);
  await updater.install();

  // No whole archive: nothing was unpacked from one, and what was asked of the archive is a fraction of it.
  expect(log).toEqual(["handOff", "quit"]);
  expect(github.ranged).toBeGreaterThan(0);
  const downloads = states.filter((s) => s.kind === "downloading");
  expect(downloads.length).toBeGreaterThan(0);
  expect(downloads.every((s) => s.kind === "downloading" && s.how === "difference")).toBe(true);
  // (The first request is for the archive's end, which in an archive this small is all of it.)
  const fetched = Number(/fetched (\d+) of/.exec(notes.at(-1) ?? "")?.[1]);
  expect(notes.at(-1)).toMatch(
    /by the difference: fetched \d+ of \d+ bytes, 2 files changed, 1 reused/,
  );
  expect(fetched).toBeLessThan(zip.length / 4);
  expect(github.ranged).toBe(zip.length + fetched);
  const app = swaps[0]?.newApp ?? "";
  expect(
    JSON.parse(await readFile(join(app, "Contents/Resources/app/build.json"), "utf8")).version,
  ).toBe("0.2.0");
  expect(await readFile(join(app, "Contents/Frameworks/Electron"), "utf8")).toBe(filler);
  expect(states.at(-1)).toMatchObject({ kind: "installing", version: "0.2.0" });
});

test("a server that does not honour ranges costs only the saving: the whole archive is downloaded and installed", async () => {
  await installAndPublish("0.2.0");
  github.ranges = false;
  const { updater, states, log, swaps, notes } = make(unpack());
  await updater.check(false);
  await updater.install();
  expect(log).toEqual(["extract", "handOff", "quit"]);
  expect(notes.join("\n")).toMatch(
    /by the difference failed \(.*range.*\); downloading the whole update/,
  );
  expect(states.some((s) => s.kind === "downloading" && s.how === "whole")).toBe(true);
  expect(existsSync(join(swaps[0]?.newApp ?? "", "Contents/Resources/app/build.json"))).toBe(true);
});

test("a fetched file that does not match the file table is not installed; the whole archive is used instead", async () => {
  // main.js is stored here, and what the archive holds of it is not what the table hashed.
  await installAndPublish("0.2.0", {
    stored: ["Contents/Resources/app/main.js"],
    corrupt: { "Contents/Resources/app/main.js": new TextEncoder().encode("main of 0.2.X") },
  });
  const { updater, log, notes } = make(unpack());
  await updater.check(false);
  await updater.install();
  expect(log).toContain("extract");
  expect(notes.join("\n")).toMatch(/does not match the file table/);
});

test("when the difference is most of the archive it is not worth it, and the archive is downloaded whole", async () => {
  await installAndPublish("0.2.0");
  // Nothing of the installed bundle is as the release has it.
  await rm(join(dir, "apps", "Cycle.app"), { recursive: true });
  await writeBundle(join(dir, "apps", "Cycle.app"), {
    "Contents/Resources/app/build.json": buildJson("0.1.0"),
    "Contents/Frameworks/Electron": "something else entirely",
  });
  const { updater, log, notes } = make(unpack());
  await updater.check(false);
  await updater.install();
  expect(log).toContain("extract");
  expect(notes.join("\n")).toMatch(/not worth it/);
});

test("a release whose table is unusable is installed whole, and the log says why", async () => {
  await installAndPublish("0.2.0");
  const key = `/dl/v0.2.0/${manifestName("darwin", "arm64")}`;
  const manifest = JSON.parse(new TextDecoder().decode(github.files.get(key)));
  manifest.tree = [
    { path: "../escape", kind: "file", mode: 0o644, size: 1, sha256: "a".repeat(64) },
  ];
  github.files.set(key, new TextEncoder().encode(JSON.stringify(manifest)));
  const { updater, log, notes } = make(unpack());
  await updater.check(false);
  await updater.install();
  expect(log).toContain("extract");
  expect(github.ranged).toBe(0);
  expect(notes[0]).toMatch(/file table is not usable/);
});

test("with the difference turned off nothing is fetched piecewise", async () => {
  await installAndPublish("0.2.0");
  const { updater, log } = make(unpack({ delta: false }));
  await updater.check(false);
  await updater.install();
  expect(log).toContain("extract");
  expect(github.ranged).toBe(0);
});

test("a limit on requests is told to the user, not answered with the whole download that would meet it too", async () => {
  await installAndPublish("0.2.0");
  github.rangeStatus = 429;
  const { updater, log, states } = make(unpack());
  await updater.check(false);
  await expect(updater.install()).rejects.toThrow(/limiting/);
  expect(log).not.toContain("extract");
  expect(states.at(-1)).toMatchObject({ kind: "error", version: "0.2.0" });
});

/** A GitHub that takes the request and never answers, as a line that has gone quiet; it does end when told to. */
const asFetch = (call: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>) =>
  Object.assign(call, { preconnect: () => undefined }) as typeof fetch;
const silent = asFetch(
  (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }),
);

test("a check that GitHub does not answer ends with an error, and the next check can be made", async () => {
  publish("0.2.0");
  const { updater } = make({ fetch: silent, deadlineMs: 50 });
  const state = await Promise.race([
    updater.check(true),
    Bun.sleep(2_000).then(() => "still waiting" as const),
  ]);
  expect(state).toMatchObject({
    kind: "error",
    message: expect.stringContaining("did not answer"),
  });
  // Not held: a later check goes out (this time to the fake GitHub), and finds the update.
  const again = make({ deadlineMs: 50 });
  expect((await again.updater.check(true)).kind).toBe("available");
});

test("a manifest that GitHub does not send in time ends the check, and the next one goes through", async () => {
  publish("0.2.0");
  let stalledManifest = true;
  const slowManifest = asFetch((input, init) => {
    const url = String(input);
    if (stalledManifest && url.includes("latest-darwin-arm64.json")) return silent(input, init);
    return fetch(input, init);
  });
  const { updater } = make({ fetch: slowManifest, deadlineMs: 50 });
  expect((await updater.check(true)).kind).toBe("error");
  stalledManifest = false;
  expect((await updater.check(true)).kind).toBe("available");
});

test("an archive that goes quiet part-way ends the install with an error, and the app can try again", async () => {
  publish("0.2.0");
  await mkdir(join(dir, "apps"), { recursive: true });
  let stall = true;
  const quiet = asFetch((input, init) => {
    if (!stall || !String(input).includes("/dl/") || String(input).endsWith(".json"))
      return fetch(input, init);
    // The answer begins, one piece of the body comes, and then nothing, until the request is ended.
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(3));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        }),
        { status: 200 },
      ),
    );
  });
  const { updater } = make({ fetch: quiet, deadlineMs: 50 });
  await updater.check(false);
  await expect(updater.install()).rejects.toThrow(/did not answer/);
  // Not held: it can be asked again, and goes through.
  stall = false;
  await updater.install();
});

test("a release list that begins and then goes quiet ends the check", async () => {
  publish("0.2.0");
  const half = asFetch((input, init) => {
    if (!String(input).includes("/releases")) return fetch(input, init);
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("["));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        }),
        { status: 200 },
      ),
    );
  });
  const { updater } = make({ fetch: half, deadlineMs: 50 });
  expect(await updater.check(true)).toMatchObject({ kind: "error" });
});

// ---- the local alpha repository ----

/** Puts an alpha in a fake repository (a folder on disk), as the build script would. */
const alphaDir = () => join(dir, "alpha");
const putAlpha = async (
  version: string,
  options: {
    folder?: string;
    claimedSha?: string;
    claimedSize?: number;
    builtAt?: string;
    commit?: string;
    subject?: string;
  } = {},
) => {
  const bytes = new TextEncoder().encode(`archive ${version}`);
  const manifest = {
    ...manifestFor(
      { version, ...PLATFORM },
      { sha256: options.claimedSha ?? sha(bytes), size: options.claimedSize ?? bytes.length },
    ),
    commit: options.commit ?? "abc1234",
    subject: options.subject ?? "do a thing",
    builtAt: options.builtAt ?? "2026-11-25T00:00:00Z",
  };
  const folder = join(alphaDir(), options.folder ?? version.replaceAll("+", "_"));
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(folder, manifest.file), bytes);
};
const fakeAlpha = () => ({
  dir: alphaDir(),
  list: () => readdir(alphaDir()).catch(() => [] as string[]),
  read: (path: string) => readFile(join(alphaDir(), path), "utf8"),
  copy: async (path: string, to: string) => {
    await writeFile(to, await readFile(join(alphaDir(), path)));
  },
});
const withAlpha = (over: Partial<ConstructorParameters<typeof Updater>[0]> = {}) =>
  make({ localAlpha: fakeAlpha(), ...over });

test("a newer alpha in the local repository is offered, with its commit and subject; .partial is not read", async () => {
  await putAlpha("0.1.1-alpha.1+abc1234", { commit: "abc1234", subject: "first" });
  await putAlpha("0.1.1-alpha.9+zzz", { folder: ".partial" });
  await putAlpha("0.1.1-alpha.8+zzz", { folder: "0.1.1-alpha.8_zzz.partial" });
  await mkdir(join(alphaDir(), ".partial", "0.1.1-alpha.7_q"), { recursive: true });
  const { updater } = withAlpha({ current: { version: "0.1.0", ...PLATFORM } });
  expect(await updater.check(false)).toMatchObject({
    kind: "available",
    version: "0.1.1-alpha.1+abc1234",
    source: "local",
    commit: "abc1234",
    subject: "first",
  });
});

test("of GitHub and the local repository, the newer is offered; one side failing leaves the other", async () => {
  publish("0.2.0");
  await putAlpha("0.1.1-alpha.1+abc");
  const first = withAlpha();
  expect(await first.updater.check(false)).toMatchObject({
    version: "0.2.0",
    source: "release",
  });
  await rm(alphaDir(), { recursive: true, force: true });
  github.releases = [];
  publish("0.1.0");
  await putAlpha("0.2.0-alpha.1+abc");
  const second = withAlpha();
  expect(await second.updater.check(false)).toMatchObject({
    version: "0.2.0-alpha.1+abc",
    source: "local",
  });
  github.status = 500;
  const third = withAlpha();
  expect(await third.updater.check(false)).toMatchObject({ source: "local" });
});

test("a local repository that cannot be read leaves GitHub's answer", async () => {
  publish("0.2.0");
  const { updater } = withAlpha({
    localAlpha: {
      ...fakeAlpha(),
      list: async () => {
        throw new Error("nope");
      },
    },
  });
  expect(await updater.check(false)).toMatchObject({ version: "0.2.0", source: "release" });
});

test("older, and the same version with the same +meta, are not offered; the same version with other +meta is a reinstall", async () => {
  const current = { version: "0.2.0-alpha.3+abc", ...PLATFORM };
  await putAlpha("0.2.0-alpha.2+zzz");
  await putAlpha("0.2.0-alpha.3+abc");
  expect((await withAlpha({ current }).updater.check(false)).kind).toBe("up-to-date");
  await putAlpha("0.2.0-alpha.3+def");
  expect(await withAlpha({ current }).updater.check(false)).toMatchObject({
    kind: "available",
    version: "0.2.0-alpha.3+def",
    source: "local",
  });
});

test("without a local repository, or with an empty one, it behaves as before", async () => {
  publish("0.1.5");
  expect(await make().updater.check(false)).toMatchObject({ version: "0.1.5", source: "release" });
  expect(await withAlpha().updater.check(false)).toMatchObject({
    version: "0.1.5",
    source: "release",
  });
  github.releases = [];
  expect((await withAlpha().updater.check(false)).kind).toBe("up-to-date");
});

test("a local alpha is copied, checked and swapped in, and verified as local", async () => {
  await putAlpha("0.1.1-alpha.1+abc");
  const sources: string[] = [];
  const { updater, swaps, log } = withAlpha({
    appPath: join(dir, "apps", "Cycle.app"),
    verifyBundle: async (_n, _c, source) => {
      sources.push(source);
    },
  });
  await mkdir(join(dir, "apps"), { recursive: true });
  await updater.check(false);
  await updater.install();
  expect(sources).toEqual(["local"]);
  expect(swaps).toHaveLength(1);
  expect(log).toContain("quit");
});

test("a local alpha whose size or SHA-256 differs from its manifest is not installed", async () => {
  await mkdir(join(dir, "apps"), { recursive: true });
  for (const bad of [{ claimedSha: "0".repeat(64) }, { claimedSize: 3 }]) {
    await rm(alphaDir(), { recursive: true, force: true });
    await putAlpha("0.1.1-alpha.1+abc", bad);
    const { updater, swaps, log } = withAlpha();
    await updater.check(false);
    await expect(updater.install()).rejects.toThrow(/manifest|checksum/);
    expect(swaps).toHaveLength(0);
    expect(log).not.toContain("extract");
    expect(updater.state.kind).toBe("error");
  }
});

test("a local alpha needs a valid signature from the alpha certificate, and not the same team", async () => {
  const listing = (authority: string) =>
    `Authority=${authority}\nAuthority=Other\nTeamIdentifier=not set\n`;
  const codesign =
    (authority: string, valid = true) =>
    async (args: string[]) => {
      if (args[0] === "--verify") {
        if (!valid) throw new Error("bad");
        return "";
      }
      return args.at(-1) === "cur" ? "TeamIdentifier=T1\n" : listing(authority);
    };
  await verifyBySource(codesign("Cycle Alpha (local)"))("next", "cur", "local");
  await expect(verifyBySource(codesign("Someone Else"))("next", "cur", "local")).rejects.toThrow(
    /Cycle Alpha \(local\)/,
  );
  await expect(
    verifyBySource(codesign("Cycle Alpha (local)", false))("next", "cur", "local"),
  ).rejects.toThrow(/not valid/);
  // A release is still held to the team.
  await expect(
    verifyBySource(codesign("Cycle Alpha (local)"))("next", "cur", "release"),
  ).rejects.toThrow(/same team/);
});

test("of two builds of one version, the one running is not offered the other if it is older, and the older is offered the newer", async () => {
  await putAlpha("0.2.0-alpha.3+aaa", { builtAt: "2026-11-25T01:00:00Z" });
  await putAlpha("0.2.0-alpha.3+bbb", { builtAt: "2026-11-25T02:00:00Z" });
  const running = (meta: string, builtAt: string) => ({
    version: `0.2.0-alpha.3+${meta}`,
    builtAt,
    ...PLATFORM,
  });
  // Running the older: the newer is offered. Running the newer: nothing, the older is not offered back.
  expect(
    await withAlpha({ current: running("aaa", "2026-11-25T01:00:00Z") }).updater.check(false),
  ).toMatchObject({ kind: "available", version: "0.2.0-alpha.3+bbb" });
  expect(
    (await withAlpha({ current: running("bbb", "2026-11-25T02:00:00Z") }).updater.check(false))
      .kind,
  ).toBe("up-to-date");
});

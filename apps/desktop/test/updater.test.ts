import { expect, test } from "bun:test";
import { archiveName, manifestFor, manifestName } from "../src/shared/release";
import type { UpdateState } from "../src/shared/update-state";
import type { BundleFacts, RunningApp } from "../src/update/plan";
import { LATEST_RELEASE_URL } from "../src/update/plan";
import { type UpdatePorts, createUpdater } from "../src/update/updater";

const SHA = "a".repeat(64);
const SIZE = 200;
const API = "https://api.github.com/repos/OhMyJames/cycle/releases/assets";
const GOOD: BundleFacts = { identifier: "dev.cycle.codex", version: "0.2.0", signed: true };
const APP: RunningApp = {
  bundle: "/Applications/Cycle Codex.app",
  identifier: "dev.cycle.codex",
  folderWritable: true,
};

/** A GitHub with one release, and a disk that remembers what was unpacked. */
function world(
  change: Partial<UpdatePorts> & { version?: string; githubToken?: string | undefined } = {},
) {
  const version = change.version ?? "0.2.0";
  const states: UpdateState[] = [];
  const calls: string[] = [];
  const sent: (string | undefined)[] = [];
  const unpacked = new Map<string, BundleFacts>();
  const network = { offline: false };
  const release = JSON.stringify({
    tag_name: `v${version}`,
    assets: [
      { name: manifestName("darwin", "arm64"), url: `${API}/1`, size: 150 },
      { name: archiveName(version, "darwin", "arm64"), url: `${API}/2`, size: SIZE },
    ],
  });
  const manifest = JSON.stringify(
    manifestFor({ version, platform: "darwin", arch: "arm64" }, { sha256: SHA, size: SIZE }),
  );
  const ports: UpdatePorts = {
    current: "0.1.0",
    platform: "darwin",
    arch: "arm64",
    now: () => 1000,
    token: async () => change.githubToken,
    get: async (url, headers) => {
      if (network.offline) throw new Error("offline");
      sent.push(headers["Authorization"]);
      return { status: 200, text: url === LATEST_RELEASE_URL ? release : manifest };
    },
    download: async (_version, url, headers, onProgress) => {
      calls.push(`download ${url}`);
      sent.push(headers["Authorization"]);
      for (const received of [50, 51, 100, SIZE]) onProgress(received);
      return { status: 200, size: SIZE, sha256: SHA };
    },
    unpack: async (name) => {
      calls.push(`unpack ${name}`);
      unpacked.set(name, { ...GOOD, version: name });
      return { ...GOOD, version: name };
    },
    inspect: async (name) => unpacked.get(name),
    clean: async (keep) => {
      calls.push(`clean ${keep.join(",")}`);
      for (const name of unpacked.keys()) if (!keep.includes(name)) unpacked.delete(name);
    },
    running: async () => APP,
    swap: async (name) => {
      calls.push(`swap ${name}`);
    },
    onState: (state) => states.push(state),
    ...change,
  };
  return { updater: createUpdater(ports), states, calls, sent, unpacked, network };
}

const statuses = (states: UpdateState[]) =>
  states.map((state) =>
    state.status === "downloading" ? `downloading ${state.progress}` : state.status,
  );

test("a newer release is downloaded, verified and offered, and nothing is installed", async () => {
  const { updater, states, calls, sent } = world({ githubToken: "secret" });
  expect(updater.state()).toEqual({ current: "0.1.0", status: "idle" });
  await updater.check();
  expect(statuses(states)).toEqual([
    "checking",
    "downloading 0",
    "downloading 0.25",
    "downloading 0.5",
    "downloading 1",
    "ready",
  ]);
  expect(updater.state()).toEqual({ current: "0.1.0", status: "ready", version: "0.2.0" });
  expect(calls).toEqual(["clean ", `download ${API}/2`, "unpack 0.2.0", "clean 0.2.0"]);
  expect(sent).toEqual(["Bearer secret", "Bearer secret", "Bearer secret"]);
  expect(JSON.stringify(states)).not.toContain("secret");
});

test("with no token it asks GitHub all the same", async () => {
  const { updater, sent } = world();
  await updater.check();
  expect(updater.state().status).toBe("ready");
  expect(sent).toEqual([undefined, undefined, undefined]);
});

test("the running version, or an older release, is up to date, and old downloads go", async () => {
  for (const version of ["0.1.0", "0.0.9"]) {
    const { updater, calls } = world({ version });
    await updater.check();
    expect(updater.state()).toEqual({ current: "0.1.0", status: "upToDate", checkedAt: 1000 });
    expect(calls).toEqual(["clean "]);
  }
});

test.each([
  [404, undefined, "error", "gh auth login"],
  [404, "t", "upToDate", ""],
  [401, "bad-token", "error", "refused the token"],
  [500, "t", "error", "500"],
])("GitHub answering %i with token %p leaves %s", async (status, token, expected, message) => {
  const { updater } = world({ githubToken: token, get: async () => ({ status, text: "{}" }) });
  await updater.check();
  const state = updater.state();
  expect(state.status).toBe(expected as UpdateState["status"]);
  if (state.status === "error") {
    expect(state.message).toContain(message);
    expect(state.message).not.toContain("bad-token");
  }
});

test.each<[string, Partial<UpdatePorts>, string]>([
  ["is cut short", { download: async () => ({ status: 200, size: 5, sha256: SHA }) }, "bytes"],
  [
    "has another hash",
    { download: async () => ({ status: 200, size: SIZE, sha256: "b".repeat(64) }) },
    "SHA-256",
  ],
  ["is refused", { download: async () => ({ status: 403, size: 0, sha256: "" }) }, "403"],
  [
    "holds another app",
    { unpack: async () => ({ ...GOOD, identifier: "dev.clawdot.cycle" }) },
    "another app",
  ],
  ["is not signed", { unpack: async () => ({ ...GOOD, signed: false }) }, "signature"],
  [
    "fails on the way",
    {
      download: async () => {
        throw new Error("The download stopped arriving.");
      },
    },
    "stopped arriving",
  ],
])("a download that %s is an error, and is removed", async (_name, change, message) => {
  const { updater, calls } = world(change);
  await updater.check();
  expect(updater.state()).toMatchObject({
    status: "error",
    message: expect.stringContaining(message),
  });
  expect(calls.at(-1)).toBe("clean ");
  await updater.install();
  expect(calls).not.toContain("swap 0.2.0");
});

test("a release with no build for this Mac is an error, with nothing downloaded", async () => {
  const { updater, calls } = world({ arch: "x64" });
  await updater.check();
  expect(updater.state()).toMatchObject({
    status: "error",
    message: expect.stringContaining("x64"),
  });
  expect(calls.some((call) => call.startsWith("download"))).toBe(false);
});

test("what an earlier run unpacked is offered without downloading again", async () => {
  const { updater, calls, unpacked } = world();
  unpacked.set("0.2.0", GOOD);
  await updater.check();
  expect(updater.state().status).toBe("ready");
  expect(calls).toEqual(["clean 0.2.0"]);
});

test("a waiting update stays offered through later checks, even failed ones", async () => {
  const { updater, states, calls, network } = world();
  await updater.check();
  const before = states.length;
  await updater.check();
  network.offline = true;
  await updater.check();
  expect(updater.state()).toEqual({ current: "0.1.0", status: "ready", version: "0.2.0" });
  expect(statuses(states.slice(before))).toEqual(["ready"]);
  expect(calls.filter((call) => call.startsWith("download"))).toHaveLength(1);
});

test("only one check runs at a time", async () => {
  const { updater, calls } = world();
  await Promise.all([updater.check(), updater.check()]);
  expect(calls.filter((call) => call.startsWith("download"))).toHaveLength(1);
});

test("installing happens only when asked, and only with an update ready", async () => {
  const { updater, calls } = world();
  await updater.install();
  expect(calls).toEqual([]);
  await updater.check();
  expect(calls).not.toContain("swap 0.2.0");
  await updater.install();
  expect(calls.at(-1)).toBe("swap 0.2.0");
});

test.each<[string, RunningApp, string]>([
  ["old-cycle's app", { ...APP, bundle: "/Applications/Cycle.app" }, "Only Cycle Codex.app"],
  ["another identifier", { ...APP, identifier: "dev.clawdot.cycle" }, "another app"],
  ["a folder it cannot write", { ...APP, folderWritable: false }, "cannot be written"],
])("running as %s, the install is refused and the update stays", async (_name, running, why) => {
  const { updater, calls } = world({ running: async () => running });
  await updater.check();
  await updater.install();
  expect(calls).not.toContain("swap 0.2.0");
  expect(updater.state()).toMatchObject({
    status: "ready",
    version: "0.2.0",
    message: expect.stringContaining(why),
  });
});

test("an update that changed on disk since it was downloaded is not installed", async () => {
  const { updater, calls, unpacked } = world();
  await updater.check();
  unpacked.set("0.2.0", { ...GOOD, signed: false });
  await updater.install();
  expect(calls).not.toContain("swap 0.2.0");
  expect(updater.state()).toMatchObject({ status: "error" });
  expect(unpacked.size).toBe(0);
});

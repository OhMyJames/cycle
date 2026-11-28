// The daemon's release channel (src/channel.ts, scripts/channel.ts; docs/daemon.md "自动更新", CYC-538): which manifests a
// daemon takes, what the publisher decides has changed, which files it uploads again, in what order it publishes, and
// what it cleans up. `gh` is faked; the folders are temporary.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assemble,
  blobsToDelete,
  daemonInputs,
  filesIn,
  KEEP_UNUSED_MS,
  type Plan,
  plan,
  publish,
} from "../scripts/channel.ts";
import { blobName, parseDaemonManifest } from "../src/channel.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(() => dispose());

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A built daemon folder. */
const built = async (name: string, files: Record<string, string>) => {
  const at = join(dir, name);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(at, path, ".."), { recursive: true });
    await writeFile(join(at, path), text);
    if (!path.includes("/") && path !== "install.sh") await chmod(join(at, path), 0o755);
  }
  return at;
};

const FOLDER = {
  cycle: "daemon",
  claude: "claude",
  "clawdot-plugins/plugins/a.json": "{}",
  "install.sh": "#!/bin/sh",
};

test("a manifest is taken only when every part of it is as a daemon expects", () => {
  const good = {
    v: 1,
    kind: "daemon",
    version: "0.3.1",
    commit: "abcdef1",
    platform: "darwin",
    arch: "arm64",
    protocol: "0.2",
    inputs: "a".repeat(64),
    keyId: "k1",
    files: { cycle: { sha256: "b".repeat(64), size: 3, mode: 0o755 } },
  };
  expect(parseDaemonManifest(JSON.stringify(good))).toEqual(good as never);
  const bad = [
    { ...good, kind: "ui" },
    { ...good, version: "0.3" },
    { ...good, files: {} },
    { ...good, files: { claude: good.files.cycle } },
    { ...good, files: { ...good.files, "../x": good.files.cycle } },
    { ...good, files: { ...good.files, "/etc/x": good.files.cycle } },
    { ...good, files: { ...good.files, a: good.files.cycle, "a/b": good.files.cycle } },
    { ...good, files: { cycle: { ...good.files.cycle, mode: 0o777 } } },
  ];
  for (const m of bad) expect(parseDaemonManifest(JSON.stringify(m))).toBeUndefined();
  expect(parseDaemonManifest("not json")).toBeUndefined();
});

test("the plan leaves the installer out and does not count the executable's own bytes", async () => {
  const a = await built("a", FOLDER);
  const b = await built("b", {
    ...FOLDER,
    cycle: "daemon, built again with another version in it",
  });
  expect(await filesIn(a)).toEqual(["claude", "clawdot-plugins/plugins/a.json", "cycle"]);
  const planA = await plan(a, "sources", "0.3");
  const planB = await plan(b, "sources", "0.3");
  expect(planA.inputs).toBe(planB.inputs);
  expect(planA.files.claude).toEqual({ sha256: sha("claude"), size: 6, mode: 0o755 });
  expect(planA.files["clawdot-plugins/plugins/a.json"]?.mode).toBe(0o644);
  // A change in the sources, in a shipped file, or in the app's major and minor is a change.
  expect((await plan(a, "other sources", "0.3")).inputs).not.toBe(planA.inputs);
  expect((await plan(a, "sources", "0.4")).inputs).not.toBe(planA.inputs);
  const c = await built("c", { ...FOLDER, claude: "claude 2" });
  expect((await plan(c, "sources", "0.3")).inputs).not.toBe(planA.inputs);
});

const assembled = async (folder: string, p: Plan, over: Partial<Parameters<typeof assemble>[0]>) =>
  assemble({
    dir: folder,
    plan: p,
    previous: undefined,
    version: "0.3.10",
    commit: "abcdef1",
    platform: "darwin",
    arch: "arm64",
    keyId: "k1",
    signed: true,
    ...over,
  });

test("a signed file whose unsigned bytes did not change keeps the published entry and is not uploaded", async () => {
  const folder = await built("a", FOLDER);
  const p = await plan(folder, "sources", "0.3");
  const first = await assembled(folder, p, {});
  expect(first.upload.sort()).toEqual(["claude", "clawdot-plugins/plugins/a.json", "cycle"]);
  expect(first.manifest.files.claude?.source).toBe(sha("claude"));
  // Signed again: other bytes, the same source.
  await writeFile(join(folder, "claude"), "claude, signed at another time");
  await writeFile(join(folder, "cycle"), "daemon, signed at another time");
  const cycle = p.files.cycle;
  if (cycle === undefined) throw new Error("no daemon in the plan");
  const p2 = { ...p, files: { ...p.files, cycle: { ...cycle, sha256: sha("new daemon") } } };
  const second = await assembled(folder, p2, { previous: first.manifest, version: "0.3.11" });
  expect(second.upload).toEqual(["cycle"]);
  expect(second.manifest.files.claude).toEqual(first.manifest.files.claude as never);
  // Unsigned (Linux), entries carry no source: the same bytes are simply the same blob.
  const linux = await assembled(folder, p, { signed: false, platform: "linux", arch: "x64" });
  expect(linux.manifest.files.claude?.source).toBeUndefined();
});

test("publishing uploads missing files, then the signature, then the manifest, and not over a newer one", async () => {
  const folder = await built("a", FOLDER);
  const p = await plan(folder, "sources", "0.3");
  const made = await assembled(folder, p, { signed: false, platform: "linux", arch: "x64" });
  const out = join(dir, "out", "linux-x64");
  await mkdir(join(out, "blobs"), { recursive: true });
  for (const path of made.upload)
    await writeFile(join(out, "blobs", blobName(made.manifest.files[path]?.sha256 ?? "")), "gz");
  await writeFile(join(out, "daemon-linux-x64.json"), JSON.stringify(made.manifest));

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const calls: string[][] = [];
  let published: string | undefined;
  const existing = blobName(made.manifest.files.claude?.sha256 ?? "");
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[1] === "view" && args.includes("--json"))
      return JSON.stringify({
        assets: [
          { name: existing, updatedAt: new Date(0).toISOString() },
          { name: blobName("e".repeat(64)), updatedAt: new Date(0).toISOString() },
        ],
      });
    if (args[1] === "download") {
      if (published === undefined) throw new Error("not found");
      return published;
    }
    return "";
  };
  const result = await publish({
    gh,
    repo: "o/r",
    sha: "abc",
    dirs: [out],
    key: privateKey,
    now: Date.now(),
    log: () => {},
  });
  expect(result.published).toEqual(["linux-x64 0.3.10"]);
  const uploads = calls.filter((c) => c[1] === "upload").map((c) => c[3]?.split("/").at(-1));
  // The file already published is not uploaded again; the manifest is the last thing to change.
  expect(uploads).not.toContain(existing);
  expect(uploads.at(-2)).toBe("daemon-linux-x64.json.sig");
  expect(uploads.at(-1)).toBe("daemon-linux-x64.json");
  const signature = await readFile(join(out, "daemon-linux-x64.json.sig"), "utf8");
  expect(
    verify(
      null,
      Buffer.from(await readFile(join(out, "daemon-linux-x64.json"))),
      publicKey,
      Buffer.from(signature.trim(), "base64"),
    ),
  ).toBe(true);
  // A blob no manifest needs, old enough, is removed; the one in use is not.
  expect(result.deleted).toEqual([blobName("e".repeat(64))]);

  // A run that waited its turn for an older commit does not put its manifest over a newer one.
  published = JSON.stringify({ ...made.manifest, version: "0.3.12" });
  calls.length = 0;
  const again = await publish({
    gh,
    repo: "o/r",
    sha: "abc",
    dirs: [out],
    key: privateKey,
    now: Date.now(),
    log: () => {},
  });
  expect(again.published).toEqual([]);
  expect(calls.filter((c) => c[1] === "upload")).toEqual([]);
});

test("a file no manifest needs is kept for a day, for a daemon still downloading the version before", () => {
  const now = Date.parse("2026-11-28T00:00:00Z");
  const fresh = { name: blobName("1".repeat(64)), updatedAt: new Date(now - 1000).toISOString() };
  const stale = {
    name: blobName("2".repeat(64)),
    updatedAt: new Date(now - KEEP_UNUSED_MS - 1).toISOString(),
  };
  const used = { name: blobName("3".repeat(64)), updatedAt: new Date(0).toISOString() };
  const manifest = { name: "daemon-linux-x64.json", updatedAt: new Date(0).toISOString() };
  expect(blobsToDelete([fresh, stale, used, manifest], new Set([used.name]), now)).toEqual([
    stale.name,
  ]);
});

test("the files of the manifest just replaced stay until the next publish, however old they are", async () => {
  const folder = await built("a", FOLDER);
  const made = await assembled(folder, await plan(folder, "sources", "0.3"), {
    signed: false,
    platform: "linux",
    arch: "x64",
  });
  const out = join(dir, "out", "linux-x64");
  await mkdir(join(out, "blobs"), { recursive: true });
  for (const path of made.upload)
    await writeFile(join(out, "blobs", blobName(made.manifest.files[path]?.sha256 ?? "")), "gz");
  await writeFile(join(out, "daemon-linux-x64.json"), JSON.stringify(made.manifest));
  const before = blobName("d".repeat(64));
  const replacedManifest = {
    ...made.manifest,
    version: "0.3.9",
    files: { cycle: { sha256: "d".repeat(64), size: 1, mode: 0o755 } },
  };
  const gh = async (args: string[]) => {
    if (args[1] === "view" && args.includes("--json"))
      return JSON.stringify({ assets: [{ name: before, updatedAt: new Date(0).toISOString() }] });
    if (args[1] === "download") return JSON.stringify(replacedManifest);
    return "";
  };
  const { privateKey } = generateKeyPairSync("ed25519");
  const result = await publish({
    gh,
    repo: "o/r",
    sha: "abc",
    dirs: [out],
    key: privateKey,
    now: Date.now(),
    log: () => {},
  });
  expect(result.published).toEqual(["linux-x64 0.3.10"]);
  expect(result.deleted).toEqual([]);
});

test("the daemon's bundle inputs do not include the Loop protocol, so a change to it publishes nothing (CYC-560)", async () => {
  const inputs = await daemonInputs();
  expect(inputs.some((p) => p.endsWith("packages/protocol/src/index.ts"))).toBe(true);
  expect(inputs.filter((p) => p.endsWith("packages/protocol/src/loop.ts"))).toEqual([]);
});

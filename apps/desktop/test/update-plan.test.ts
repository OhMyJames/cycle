import { expect, test } from "bun:test";
import {
  archiveName,
  isNewer,
  manifestFor,
  manifestName,
  parseManifest,
} from "../src/shared/release";
import {
  SWAP_SCRIPT,
  archiveAsset,
  assetHeaders,
  bundleOf,
  bundleProblem,
  downloadProblem,
  findToken,
  installRefusal,
  manifestAsset,
  parseRelease,
  releaseHeaders,
  swapPlan,
  updatesFolder,
} from "../src/update/plan";

const SHA = "a".repeat(64);
const API = "https://api.github.com/repos/OhMyJames/cycle/releases/assets";
const BUNDLE = "/Applications/Cycle Codex.app";

test.each([
  ["0.2.0", "0.1.0", true],
  ["0.10.0", "0.9.9", true],
  ["1.0.0", "0.99.99", true],
  ["0.1.0", "0.1.0", false],
  ["0.1.0", "0.2.0", false],
  ["0.2.0-beta", "0.1.0", false],
  ["nope", "0.1.0", false],
])("%s newer than %s: %p", (candidate, current, newer) => {
  expect(isNewer(candidate, current)).toBe(newer);
});

test("a manifest the release script writes is one the updater reads", () => {
  const manifest = manifestFor(
    { version: "0.2.0", platform: "darwin", arch: "arm64" },
    { sha256: SHA, size: 10 },
  );
  expect(manifest.file).toBe("Cycle-Codex-0.2.0-darwin-arm64.zip");
  expect(manifestName("darwin", "arm64")).toBe("latest-darwin-arm64.json");
  expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
});

test.each([
  ["not JSON", "<html>"],
  ["no version", { version: "v2" }],
  ["an archive of another name", { file: "../../evil.zip" }],
  ["a short hash", { sha256: "abc" }],
  ["no size", { size: 0 }],
])("a manifest with %s is refused", (_name, change) => {
  const whole = manifestFor(
    { version: "0.2.0", platform: "darwin", arch: "arm64" },
    { sha256: SHA, size: 10 },
  );
  const text = typeof change === "string" ? change : JSON.stringify({ ...whole, ...change });
  expect(() => parseManifest(text)).toThrow("manifest");
});

const releaseJson = (assets: { name: string; url: string; size: number }[], tag = "v0.2.0") =>
  JSON.stringify({ tag_name: tag, assets });
const ASSETS = [
  { name: manifestName("darwin", "arm64"), url: `${API}/1`, size: 120 },
  { name: archiveName("0.2.0", "darwin", "arm64"), url: `${API}/2`, size: 10 },
];

test("a release gives its version and this platform's two assets", () => {
  const release = parseRelease(releaseJson(ASSETS));
  expect(release.version).toBe("0.2.0");
  expect(manifestAsset(release, "darwin", "arm64")?.url).toBe(`${API}/1`);
  expect(manifestAsset(release, "darwin", "x64")).toBeUndefined();
  const manifest = JSON.stringify(
    manifestFor({ version: "0.2.0", platform: "darwin", arch: "arm64" }, { sha256: SHA, size: 10 }),
  );
  expect(archiveAsset(release, manifest, "darwin", "arm64").asset.url).toBe(`${API}/2`);
  expect(() => archiveAsset(release, manifest, "darwin", "x64")).toThrow("darwin arm64");
  const other = manifest.replaceAll("0.2.0", "0.3.0");
  expect(() => archiveAsset(release, other, "darwin", "arm64")).toThrow("0.3.0");
});

test("a release is refused without a version tag, and its assets count only on GitHub's API", () => {
  expect(() => parseRelease(releaseJson([], "nightly"))).toThrow("tag");
  expect(() => parseRelease("<html>")).toThrow("JSON");
  const elsewhere = ASSETS.map((asset) => ({ ...asset, url: "https://example.com/x" }));
  expect(manifestAsset(parseRelease(releaseJson(elsewhere)), "darwin", "arm64")).toBeUndefined();
});

test("the token is taken from the shell's exports before gh is asked", async () => {
  const asked: string[] = [];
  const gh =
    (stdout: string, code = 0) =>
    async (command: string, args: readonly string[]) => {
      asked.push([command, ...args].join(" "));
      return { code, stdout };
    };
  expect(await findToken({ GH_TOKEN: " one ", GITHUB_TOKEN: "two" }, gh("three"))).toBe("one");
  expect(await findToken({ GITHUB_TOKEN: "two" }, gh("three"))).toBe("two");
  expect(asked).toEqual([]);
  expect(await findToken({}, gh("three\n"))).toBe("three");
  expect(asked).toEqual(["gh auth token"]);
  expect(await findToken({}, gh("not logged in", 1))).toBeUndefined();
  expect(
    await findToken({}, async () => {
      throw new Error("ENOENT");
    }),
  ).toBeUndefined();
});

test("the token is sent only as a header, and an asset is asked for as a file", () => {
  expect(releaseHeaders(undefined)["Authorization"]).toBeUndefined();
  expect(releaseHeaders("t")["Authorization"]).toBe("Bearer t");
  expect(assetHeaders("t")).toMatchObject({
    Accept: "application/octet-stream",
    Authorization: "Bearer t",
  });
});

test("a download must be the size and hash the manifest gives", () => {
  const manifest = manifestFor(
    { version: "0.2.0", platform: "darwin", arch: "arm64" },
    { sha256: SHA, size: 10 },
  );
  expect(downloadProblem(manifest, { size: 10, sha256: SHA })).toBeUndefined();
  expect(downloadProblem(manifest, { size: 9, sha256: SHA })).toContain("bytes");
  expect(downloadProblem(manifest, { size: 10, sha256: "b".repeat(64) })).toContain("SHA-256");
});

test.each([
  [{ identifier: "dev.cycle.codex", version: "0.2.0", signed: true }, undefined],
  [{ identifier: "dev.clawdot.cycle", version: "0.2.0", signed: true }, "another app"],
  [{ identifier: undefined, version: "0.2.0", signed: true }, "no identifier"],
  [{ identifier: "dev.cycle.codex", version: "0.1.0", signed: true }, "0.1.0"],
  [{ identifier: "dev.cycle.codex", version: "0.2.0", signed: false }, "signature"],
])("an unpacked bundle %j: %p", (facts, problem) => {
  const found = bundleProblem(facts, "0.2.0");
  if (problem === undefined) expect(found).toBeUndefined();
  else expect(found).toContain(problem);
});

test.each([
  [{ bundle: BUNDLE, identifier: "dev.cycle.codex", folderWritable: true }, undefined],
  [{ bundle: undefined, identifier: undefined, folderWritable: false }, "not running from"],
  // old-cycle's app, even if something gave it this app's identifier.
  [
    { bundle: "/Applications/Cycle.app", identifier: "dev.cycle.codex", folderWritable: true },
    "Only Cycle Codex.app",
  ],
  [{ bundle: BUNDLE, identifier: "dev.clawdot.cycle", folderWritable: true }, "another app"],
  [{ bundle: BUNDLE, identifier: undefined, folderWritable: true }, "no identifier"],
  [
    { bundle: BUNDLE, identifier: "dev.cycle.codex", folderWritable: false },
    "/Applications cannot be written",
  ],
])("replacing the running app %j: %p", (running, refusal) => {
  const found = installRefusal(running);
  if (refusal === undefined) expect(found).toBeUndefined();
  else expect(found).toContain(refusal);
});

test("the bundle is found from the app path, and only from a bundle's", () => {
  expect(bundleOf(`${BUNDLE}/Contents/Resources/app`)).toBe(BUNDLE);
  expect(bundleOf("/repo/apps/desktop")).toBeUndefined();
  expect(bundleOf("/opt/Cycle Codex-linux-x64/resources/app")).toBeUndefined();
});

test("downloads stay in Cycle's own home, never old-cycle's", () => {
  expect(updatesFolder(undefined, "/Users/me")).toBe("/Users/me/.cycle-codex/updates");
  expect(updatesFolder("/data/cycle/", "/Users/me")).toBe("/data/cycle/updates");
  expect(updatesFolder("/Users/me/.cycle", "/Users/me")).toBe("/Users/me/.cycle-codex/updates");
  expect(updatesFolder("relative", "/Users/me")).toBe("/Users/me/.cycle-codex/updates");
});

test("the swap is given its paths as arguments, beside the app and never as an app's name", () => {
  const plan = swapPlan(BUNDLE, 42);
  expect(plan.command).toBe("/bin/sh");
  expect(plan.args).toEqual([
    "-c",
    SWAP_SCRIPT,
    "cycle-update",
    "42",
    BUNDLE,
    "/Applications/.Cycle Codex.app.updating-42",
    "/Applications/.Cycle Codex.app.previous-42",
  ]);
  expect(SWAP_SCRIPT).not.toContain("Cycle");
  expect(plan.next.endsWith(".app")).toBe(false);
  expect(plan.previous.endsWith(".app")).toBe(false);
});

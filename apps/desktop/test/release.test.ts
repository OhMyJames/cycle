import { expect, test } from "bun:test";
import {
  archiveName,
  daemonTooOld,
  daemonUpgradeCommand,
  isNewer,
  MIN_DAEMON_VERSION,
  manifestFor,
  parseManifest,
  parseTree,
  parseVersion,
  shellQuote,
  type TreeEntry,
} from "../src/shared/release.ts";

const hash = "a".repeat(64);

test("a manifest the release script wrote is one the updater accepts", () => {
  const manifest = manifestFor(
    { version: "0.1.0", platform: "darwin", arch: "arm64" },
    { sha256: hash, size: 5 },
  );
  expect(manifest.file).toBe("Cycle-0.1.0-darwin-arm64.zip");
  expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
});

test("a manifest that points at another file, or is not whole, is refused", () => {
  const ok = manifestFor(
    { version: "0.1.0", platform: "darwin", arch: "arm64" },
    { sha256: hash, size: 5 },
  );
  expect(() => parseManifest(JSON.stringify({ ...ok, file: "evil.zip" }))).toThrow(
    /unexpected archive/,
  );
  expect(() => parseManifest(JSON.stringify({ ...ok, sha256: "xyz" }))).toThrow(/SHA-256/);
  expect(() => parseManifest(JSON.stringify({ ...ok, size: 0 }))).toThrow(/size/);
  expect(() => parseManifest(JSON.stringify({ ...ok, version: "1.0" }))).toThrow(/version/);
  expect(() => parseManifest("not json")).toThrow(/not JSON/);
  expect(archiveName("0.1.0", "darwin", "arm64")).toBe("Cycle-0.1.0-darwin-arm64.zip");
});

test("versions compare as numbers, and anything that is not major.minor.patch is never newer", () => {
  expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  expect(isNewer("1.0.0-beta", "0.1.0")).toBe(false);
});

test("the command for a remote machine downloads this release's daemon, checks it, installs it and stops the old one", () => {
  const command = daemonUpgradeCommand("0.1.1");
  const steps = command.split(" && ");
  expect(steps[1]).toBe(
    "curl -fsSLO 'https://github.com/OhMyJames/cycle/releases/download/v0.1.1/install.sh'",
  );
  expect(steps.indexOf("sha256sum -c install.sh.sha256")).toBeLessThan(
    steps.indexOf("sh install.sh 'v0.1.1'"),
  );
  expect(steps.at(-1)).toBe('"$HOME/.local/bin/cycle" stop');
});

test("the command stops the old daemon as the person chose: ask, interrupt now, or wait in the background", () => {
  const last = (stop?: "ask" | "now" | "later") =>
    daemonUpgradeCommand("0.1.1", stop).split(" && ").at(-1);
  expect(last()).toBe('"$HOME/.local/bin/cycle" stop');
  expect(last("ask")).toBe('"$HOME/.local/bin/cycle" stop');
  expect(last("now")).toBe('"$HOME/.local/bin/cycle" stop --force');
  // Only the stop goes to the background, detached from the ssh session, after the install has worked.
  expect(last("later")).toBe(
    '{ nohup "$HOME/.local/bin/cycle" stop --wait >/dev/null 2>&1 </dev/null & }',
  );
});

const TREE: TreeEntry[] = [
  { path: "Contents", kind: "dir" },
  { path: "Contents/Frameworks", kind: "dir" },
  { path: "Contents/Frameworks/Lib", kind: "link", target: "../Resources/Lib" },
  { path: "Contents/Resources", kind: "dir" },
  { path: "Contents/Resources/Lib", kind: "file", mode: 0o755, size: 3, sha256: hash },
];

test("a manifest with a file table keeps it, and one without is the manifest it always was", () => {
  const build = { version: "0.2.0", platform: "darwin", arch: "arm64" };
  const plain = manifestFor(build, { sha256: hash, size: 5 });
  expect("tree" in plain).toBe(false);
  const withTable = manifestFor(build, { sha256: hash, size: 5 }, TREE);
  expect(parseManifest(JSON.stringify(withTable)).tree).toEqual(TREE);
  // What a client from before the table reads is the same top of it.
  const { tree: _tree, ...top } = withTable;
  expect(top).toEqual(plain);
});

test("a file table that cannot be used leaves the manifest usable, without the table", () => {
  const build = { version: "0.2.0", platform: "darwin", arch: "arm64" };
  const bad = {
    ...manifestFor(build, { sha256: hash, size: 5 }),
    tree: [{ path: "../x", kind: "dir" }],
  };
  const parsed = parseManifest(JSON.stringify(bad));
  expect(parsed.tree).toBeUndefined();
  expect(parsed.treeProblem).toMatch(/not plain/);
  expect(parsed.sha256).toBe(hash);
});

test("a file table may only describe the inside of the bundle", () => {
  const dir = (path: string): TreeEntry => ({ path, kind: "dir" });
  const file = (path: string, over: object = {}) => ({
    path,
    kind: "file",
    mode: 0o644,
    size: 1,
    sha256: hash,
    ...over,
  });
  expect(parseTree(TREE)).toEqual(TREE);
  const refused: [unknown, RegExp][] = [
    [[], /empty/],
    [[dir("/etc")], /relative/],
    [[dir("a/../b")], /not plain/],
    [[dir("a//b")], /not plain/],
    [[dir("..")], /not plain/],
    [[dir("a"), dir("a")], /twice/],
    [[file("a/b")], /before its folder/],
    [[{ path: "a", kind: "link", target: "b" }, file("a/b")], /before its folder/],
    [[dir("a"), { path: "a/l", kind: "link", target: "../../outside" }], /outside the bundle/],
    [[{ path: "l", kind: "link", target: "/etc/passwd" }], /not relative/],
    // ".." after a name goes up from wherever that name leads, which may be another link.
    [
      [dir("a"), dir("a/b"), { path: "a/b/l", kind: "link", target: "x/../../.." }],
      /outside the bundle/,
    ],
    [[file("a", { mode: 0o4755 })], /mode/],
    [[file("a", { mode: -1 })], /mode/],
    [[file("a", { size: -1 })], /size/],
    [[file("a", { sha256: "zz" })], /SHA-256/],
    [[{ path: "a", kind: "device" }], /device/],
    [["a"], /not an object/],
  ];
  for (const [value, message] of refused) expect(() => parseTree(value)).toThrow(message);
});

test("the least daemon is a version no later than the app's own: an app cannot ask for what it is not", async () => {
  const { version } = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    version: string;
  };
  expect(parseVersion(MIN_DAEMON_VERSION)).toBeDefined();
  expect(isNewer(MIN_DAEMON_VERSION, version)).toBe(false);
});

test("a daemon is too old below the least, and not for a development build or a version it cannot read", () => {
  expect(daemonTooOld("0.0.1")).toBe(true);
  expect(daemonTooOld(MIN_DAEMON_VERSION)).toBe(false);
  expect(daemonTooOld("99.0.0")).toBe(false);
  expect(daemonTooOld("dev")).toBe(false);
});

test("a command is one word for the shell, whatever it holds", () => {
  expect(shellQuote("a b")).toBe("'a b'");
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
});

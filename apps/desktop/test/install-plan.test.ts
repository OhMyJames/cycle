import { expect, test } from "bun:test";
import {
  type InstallPlan,
  type RunningProcess,
  destinationIn,
  inBundle,
  parseInstallArgs,
  parseProcessList,
  planInstall,
  treeDifferences,
} from "../src/install/plan";

test("installs to /Applications unless told otherwise", () => {
  expect(parseInstallArgs([])).toEqual({ to: "/Applications", force: false });
  expect(parseInstallArgs(["--to", "/x", "--force"])).toEqual({ to: "/x", force: true });
});

test.each([[["--to"]], [["--nope"]], [["/Applications"]]])("rejects the arguments %j", (argv) => {
  expect(() => parseInstallArgs(argv)).toThrow("Usage");
});

test.each(["/Applications", "/Applications/", "/Users/me/Applications"])(
  "the destination in %s is this app's own bundle, never old-cycle's",
  (directory) => {
    const destination = destinationIn(directory);
    expect(destination.endsWith("/Cycle Codex.app")).toBe(true);
    expect(destination).not.toContain("//");
  },
);

const BUNDLE = "/Applications/Cycle Codex.app";
const APP = `${BUNDLE}/Contents/Resources/app`;
const processes = parseProcessList(
  [
    `  10 ${BUNDLE}/Contents/MacOS/Electron`,
    `  11 ${BUNDLE}/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer`,
    `  12 ${APP}/bin/cycle-daemon`,
    `  13 ${APP}/codex/bin/codex app-server`,
    "  20 /Applications/Cycle.app/Contents/MacOS/Electron",
    "  21 /Applications/Cycle.app/Contents/Resources/app/bun daemon.js",
    "  22 /Applications/Cycle Codex.app.backup/Contents/MacOS/Electron",
    `  23 /usr/bin/vim ${BUNDLE}/Contents/Info.plist`,
  ].join("\n"),
);

test("matches only processes running from exactly this bundle", () => {
  expect(inBundle(processes, BUNDLE).map(({ pid }) => pid)).toEqual([10, 11, 12, 13]);
});

const plan = (
  over: Partial<Parameters<typeof planInstall>[0]> = {},
): ReturnType<typeof planInstall> =>
  planInstall({
    platform: "darwin",
    directory: "/Applications",
    directoryExists: true,
    existing: undefined,
    processes: [],
    force: false,
    ...over,
  });

test("installs where nothing is, and over an earlier build of this app", () => {
  const fresh: InstallPlan = { kind: "install", destination: BUNDLE, stop: [], wait: [] };
  expect(plan()).toEqual(fresh);
  expect(plan({ existing: { identifier: "dev.cycle.codex" } })).toEqual(fresh);
});

test.each([
  ["old-cycle", "dev.clawdot.cycle", "another app (dev.clawdot.cycle"],
  ["something unreadable", undefined, "no readable bundle identifier"],
])("does not replace %s at the destination, even with --force", (_name, identifier, reason) => {
  const result = plan({ existing: { identifier }, force: true });
  expect(result.kind).toBe("refuse");
  expect(result).toHaveProperty("reason", expect.stringContaining(reason));
});

test("is for macOS only, and needs the folder to be there", () => {
  expect(plan({ platform: "linux" })).toHaveProperty("reason", expect.stringContaining("macOS"));
  expect(plan({ directoryExists: false })).toHaveProperty(
    "reason",
    expect.stringContaining("does not exist"),
  );
});

test("refuses while the installed app runs, and names what is running", () => {
  const result = plan({ existing: { identifier: "dev.cycle.codex" }, processes });
  expect(result.kind).toBe("refuse");
  expect(result).toHaveProperty("reason", expect.stringContaining("pid 10, 11, 12, 13"));
});

test("with --force asks only the app to quit, and waits for all that ran from the bundle", () => {
  expect(plan({ processes, force: true })).toEqual({
    kind: "install",
    destination: BUNDLE,
    stop: [10],
    wait: [10, 11, 12, 13],
  });
});

test("with --force stops a daemon left behind by an app that is gone", () => {
  const left: RunningProcess[] = processes.filter(({ pid }) => pid === 12 || pid === 13);
  expect(plan({ processes: left, force: true })).toMatchObject({ stop: [12, 13], wait: [12, 13] });
});

test("old-cycle running is no reason to refuse, and is never asked to stop", () => {
  const others = processes.filter(({ pid }) => pid >= 20);
  expect(plan({ processes: others })).toMatchObject({ kind: "install", stop: [], wait: [] });
  expect(plan({ processes: others, force: true })).toMatchObject({ stop: [], wait: [] });
});

const entry = { path: "a", size: 1, mode: 0o755 };

test.each([
  ["nothing for a faithful copy", [entry], [entry], []],
  ["a missing file", [entry], [], ["a is missing"]],
  ["an extra file", [], [entry], ["a is extra"]],
  ["a changed size", [entry], [{ ...entry, size: 2 }], ["a has a different size"]],
  ["a lost execute bit", [entry], [{ ...entry, mode: 0o644 }], ["a has a different mode"]],
])("reports %s", (_name, source, copy, expected) => {
  expect(treeDifferences(source, copy)).toEqual(expected);
});

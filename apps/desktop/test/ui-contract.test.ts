// What the page may rely on the app for (shared/contract.ts, docs/desktop.md "界面更新"): the snapshot is the one the
// source makes, its types resolve, the check of a change sorts additions from breaks, the script that moves the snapshot
// refuses what it cannot judge, and a page on an older app finds the methods that app lacks filled in.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONTRACT_DIR,
  committedFacts,
  factsNow,
  makeSnapshot,
  refusal,
  type SnapshotFacts,
  snapshotFiles,
} from "../scripts/ui-contract.ts";
import { completeBridge, notInThisApp } from "../src/renderer/bridge.ts";
import type { EventsBreak, Incompatible, NotPromised } from "./ui-contract/compat.ts";

test("the committed snapshot is the one the source makes (else: bun run --cwd apps/desktop ui-contract)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ui-contract-test-"));
  try {
    await makeSnapshot(dir);
    expect(snapshotFiles(CONTRACT_DIR)).toEqual(snapshotFiles(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("every import of the snapshot resolves: one that does not would pass every check, as an error type", () => {
  const root = join(CONTRACT_DIR, "snapshot");
  const files: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);
  let imports = 0;
  for (const file of files) {
    for (const [, spec] of readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)) {
      imports++;
      if ((spec as string).startsWith(".")) {
        const target = join(dirname(file), (spec as string).replace(/\.ts$/, ".d.ts"));
        expect(existsSync(target), `${file}: ${spec}`).toBe(true);
      } else expect(() => Bun.resolveSync(spec as string, dirname(file))).not.toThrow();
    }
  }
  expect(imports).toBeGreaterThan(2);
});

// The check itself, on small APIs: `bun run typecheck` holds each line below to be exactly `true`.
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Old = {
  list(): Promise<{ items: string[] }>;
  open(id: string): Promise<void>;
  gone(): Promise<void>;
};
const sorts: Record<string, true> = {
  // Added: a method, an optional argument, a field of the answer. Removed: a method. None breaks.
  additions: true as Same<
    Incompatible<
      Old,
      {
        list(): Promise<{ items: string[]; more?: boolean; total?: number }>;
        open(id: string, options?: { focus: boolean }): Promise<void>;
        added(): Promise<void>;
      }
    >,
    never
  >,
  // A required argument the older app does not take.
  newArgument: true as Same<
    Incompatible<Old, { open(id: string, force: boolean): Promise<void>; gone(): Promise<void> }>,
    "open"
  >,
  // An answer the older app does not give: a field it does not send.
  newAnswer: true as Same<
    Incompatible<Old, { list(): Promise<{ items: string[]; total: number }> }>,
    "list"
  >,
  // A union the page sends that grew: the older app does not know the new member.
  widened: true as Same<
    Incompatible<
      { open(id: "a" | "b"): Promise<void> },
      { open(id: "a" | "b" | "c"): Promise<void> }
    >,
    "open"
  >,
  // Events: a variant added is one the older app never sends; one removed is one it still does.
  eventAdded: true as Same<EventsBreak<{ type: "a" }, { type: "a" } | { type: "b" }>, false>,
  eventRemoved: true as Same<EventsBreak<{ type: "a" } | { type: "b" }, { type: "a" }>, true>,
  notPromised: true as Same<NotPromised<{ later(): Promise<void>; now(): number }>, "now">,
};

test("the check sorts additions from breaks (typecheck holds the lines above)", () => {
  expect(Object.values(sorts).every((v) => v)).toBe(true);
});

test("the snapshot moves forward only over what it can judge, or with a new major", () => {
  const before: SnapshotFacts = { major: 2, sdk: "2.7.0", preload: "a" };
  expect(refusal(before, before, true, undefined)).toBeUndefined();
  expect(refusal(before, before, false, undefined)).toContain("Raise CONTRACT_MAJOR");
  expect(refusal(before, { ...before, major: 3 }, false, undefined)).toBeUndefined();
  expect(refusal(before, { ...before, major: 1 }, true, undefined)).toContain("went down");
  expect(refusal(before, { ...before, sdk: "2.8.0" }, true, undefined)).toContain("SDK");
  expect(refusal(before, { ...before, preload: "b" }, true, undefined)).toContain("preload");
  expect(refusal(before, { ...before, preload: "b" }, true, "only a comment")).toBeUndefined();
  // Said or not, a break of the types needs a new major.
  expect(refusal(before, { ...before, sdk: "2.8.0" }, false, "fine")).toContain("Raise");
});

test("the committed snapshot is of this source's major, SDK and preload", async () => {
  expect(await committedFacts()).toEqual(factsNow());
});

test("a page on an older app finds the methods it lacks, failing as a refused call does", async () => {
  const calls: string[] = [];
  const onEvent = () => () => {};
  const { bridge, missing } = completeBridge(
    {
      onEvent,
      locations: async () => {
        calls.push("locations");
        return { locations: [], status: [], sessions: {} };
      },
    },
    ["locations", "workspaceRepo"],
  );
  expect(missing).toEqual(["workspaceRepo"]);
  await bridge.locations();
  expect(calls).toEqual(["locations"]);
  expect(bridge.onEvent).toBe(onEvent);
  await expect(
    (bridge as unknown as { workspaceRepo: () => Promise<unknown> }).workspaceRepo(),
  ).rejects.toThrow(notInThisApp("workspaceRepo").message);
});

test("an app with every method is left as it is", () => {
  const { missing } = completeBridge({ onEvent: () => () => {} }, []);
  expect(missing).toEqual([]);
});

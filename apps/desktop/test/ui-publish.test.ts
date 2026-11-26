import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetsToDelete, type Gh, publish } from "../scripts/ui-publish.ts";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-12-01T00:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const shellAssets = (shell: string, versions: number[], age: number) => [
  { name: `ui-${shell}.json`, updatedAt: ago(age) },
  { name: `ui-${shell}.json.sig`, updatedAt: ago(age) },
  ...versions.map((v) => ({ name: `ui-${shell}-${v}.zip`, updatedAt: ago(age) })),
];

test("of a shell in use only the three newest archives stay, and the manifest and signature always do", () => {
  const doomed = assetsToDelete(shellAssets(A, [1, 2, 10, 3, 4], 0), {
    keepShells: new Set([A]),
    now: NOW,
  });
  expect(doomed.sort()).toEqual([`ui-${A}-1.zip`, `ui-${A}-2.zip`]);
});

test("a shell that no recent release has stays for a week after its last bundle, and then goes whole", () => {
  const assets = [
    ...shellAssets(A, [5], 0),
    ...shellAssets(B, [3, 4], 2),
    ...shellAssets(C, [1], 8),
  ];
  const doomed = assetsToDelete(assets, { keepShells: new Set([A]), now: NOW });
  expect(doomed.sort()).toEqual([`ui-${C}-1.zip`, `ui-${C}.json`, `ui-${C}.json.sig`].sort());
  // One a release was built with stays however old.
  expect(assetsToDelete(shellAssets(C, [1], 100), { keepShells: new Set([C]), now: NOW })).toEqual(
    [],
  );
});

test("assets that are not bundles are left alone", () => {
  const assets = [
    { name: "notes.txt", updatedAt: ago(100) },
    { name: "ui-latest.json", updatedAt: ago(100) },
  ];
  expect(assetsToDelete(assets, { keepShells: new Set(), now: NOW })).toEqual([]);
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ui-publish-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const manifestText = (uiVersion: number, shell = A) =>
  JSON.stringify({
    v: 1,
    shell,
    uiVersion,
    keyId: "k1",
    file: `ui-${shell}-${uiVersion}.zip`,
    size: 5,
    sha256: "a".repeat(64),
    files: { "index.html": "a".repeat(64) },
  });
const prepare = async (uiVersion: number) => {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `ui-${A}.json`), manifestText(uiVersion));
  await writeFile(join(dir, `ui-${A}.json.sig`), "sig");
  await writeFile(join(dir, `ui-${A}-${uiVersion}.zip`), "zip");
};

/** A fake `gh` that remembers the calls, over a release that may exist, with a manifest already published, and others. */
const fakeGh = (state: {
  exists: boolean;
  published?: string;
  assets?: object[];
  releases?: Record<string, string>;
}) => {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === "release" && b === "view") {
      if (!state.exists) throw new Error("not found");
      return JSON.stringify({ assets: state.assets ?? [] });
    }
    if (a === "release" && b === "create") {
      state.exists = true;
      return "";
    }
    if (a === "release" && b === "download") {
      const tag = args[2] as string;
      if (tag === "ui-latest") {
        if (state.published === undefined) throw new Error("no such asset");
        return state.published;
      }
      const text = state.releases?.[tag];
      if (text === undefined) throw new Error("no such asset");
      return text;
    }
    if (a === "release" && b === "list")
      return JSON.stringify(Object.keys(state.releases ?? {}).map((tagName) => ({ tagName })));
    return "";
  };
  return { gh, calls };
};
const names = (calls: string[][], verb: string) => calls.filter((c) => c[1] === verb);

test("the first time the release is made as a pre-release that is not the latest, and the manifest goes up last", async () => {
  await prepare(100);
  const f = fakeGh({ exists: false });
  const result = await publish({
    gh: f.gh,
    repo: "o/r",
    outDir: dir,
    sha: "abc",
    now: NOW,
    log: () => {},
  });
  expect(result.published).toBe(true);
  const create = names(f.calls, "create")[0] ?? [];
  expect(create).toContain("--prerelease");
  expect(create).toContain("--latest=false");
  const uploads = names(f.calls, "upload").map((c) => (c[3] as string).split("/").pop());
  expect(uploads).toEqual([`ui-${A}-100.zip`, `ui-${A}.json.sig`, `ui-${A}.json`]);
});

test("a bundle that is not newer than the one published is not published", async () => {
  await prepare(100);
  const f = fakeGh({ exists: true, published: manifestText(100) });
  expect(
    (await publish({ gh: f.gh, repo: "o/r", outDir: dir, sha: "abc", now: NOW, log: () => {} }))
      .published,
  ).toBe(false);
  const g = fakeGh({ exists: true, published: manifestText(150) });
  expect(
    (await publish({ gh: g.gh, repo: "o/r", outDir: dir, sha: "abc", now: NOW, log: () => {} }))
      .published,
  ).toBe(false);
  expect(names(g.calls, "upload")).toEqual([]);
  const h = fakeGh({ exists: true, published: manifestText(99) });
  expect(
    (await publish({ gh: h.gh, repo: "o/r", outDir: dir, sha: "abc", now: NOW, log: () => {} }))
      .published,
  ).toBe(true);
});

test("after publishing, old archives and the bundles of shells no recent release has are removed", async () => {
  await prepare(100);
  const f = fakeGh({
    exists: true,
    published: manifestText(90),
    releases: {
      "v0.3.32": JSON.stringify({ shell: B }),
      "v0.3.31": JSON.stringify({ version: "0.3.31" }),
    },
    assets: [
      ...shellAssets(A, [1, 2, 3, 100], 0),
      ...shellAssets(B, [7], 30),
      ...shellAssets(C, [8], 30),
    ],
  });
  const result = await publish({
    gh: f.gh,
    repo: "o/r",
    outDir: dir,
    sha: "abc",
    now: NOW,
    log: () => {},
  });
  expect(result.deleted.sort()).toEqual(
    [`ui-${A}-1.zip`, `ui-${C}-8.zip`, `ui-${C}.json`, `ui-${C}.json.sig`].sort(),
  );
  expect(names(f.calls, "delete-asset")).toHaveLength(4);
});

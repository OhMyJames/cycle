import { expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FILE_SEARCH_LIMITS, searchFiles } from "../src/files.ts";
import { eachTempDir } from "./support.ts";

let root: string;
let outside: string;
eachTempDir((made) => {
  root = made;
});
eachTempDir((made) => {
  outside = made;
});

const touch = async (path: string, where = root) => {
  await mkdir(join(where, path, ".."), { recursive: true });
  await writeFile(join(where, path), "x");
};
const paths = (found: { entries: { path: string }[] }) => found.entries.map((e) => e.path);

test("with nothing typed, the top of the tree: folders, then files, the shorter names first", async () => {
  await touch("README.md");
  await touch("src/index.ts");
  await touch("src/deep/inner.ts");
  await touch("docs/a.md");
  const found = await searchFiles(root, "");
  expect(found.entries).toEqual([
    { path: "src", kind: "folder" },
    { path: "docs", kind: "folder" },
    { path: "README.md", kind: "file" },
  ]);
  expect(found.truncated).toBe(false);
});

test("names that start with the query come first, then names that hold it, then paths", async () => {
  await touch("src/app.ts");
  await touch("src/lib/apple.ts");
  await touch("src/main.ts");
  await touch("app/other.ts");
  await touch("notes/snapshot.md");
  expect(paths(await searchFiles(root, "app"))).toEqual([
    "app",
    "src/app.ts",
    "src/lib/apple.ts",
    "app/other.ts",
  ]);
  // A query with a slash is looked for in the path, not the name.
  expect(paths(await searchFiles(root, "src/lib"))).toEqual(["src/lib", "src/lib/apple.ts"]);
  expect(paths(await searchFiles(root, "APP.TS"))).toEqual(["src/app.ts"]);
});

test("a folder is found as a folder", async () => {
  await touch("packages/ui/index.ts");
  expect((await searchFiles(root, "ui")).entries).toContainEqual({
    path: "packages/ui",
    kind: "folder",
  });
});

test("a symbolic link is neither followed nor listed, so nothing outside the root is reached", async () => {
  await touch("secret.txt", outside);
  await touch("inside.txt");
  await symlink(outside, join(root, "link-to-outside"));
  await symlink(join(outside, "secret.txt"), join(root, "link-to-file"));
  await symlink(root, join(root, "link-to-self"));
  const found = await searchFiles(root, "");
  expect(paths(found)).toEqual(["inside.txt"]);
  expect(paths(await searchFiles(root, "secret"))).toEqual([]);
  expect(paths(await searchFiles(root, "link"))).toEqual([]);
});

test("a root that is itself a link is searched at what it points to", async () => {
  await touch("a.txt");
  const link = join(outside, "root-link");
  await symlink(root, link);
  expect(paths(await searchFiles(link, "a.txt"))).toEqual(["a.txt"]);
});

test(".git and node_modules are not entered, and a dot name is shown only to a query with a dot", async () => {
  await touch(".git/config");
  await touch("node_modules/pkg/index.js");
  await touch(".env.local");
  await touch("src/.hidden/x.ts");
  await touch("src/visible.ts");
  expect(paths(await searchFiles(root, "index"))).toEqual([]);
  expect(paths(await searchFiles(root, "config"))).toEqual([]);
  expect(paths(await searchFiles(root, "env"))).toEqual([]);
  expect(paths(await searchFiles(root, ".env"))).toEqual([".env.local"]);
  expect(paths(await searchFiles(root, "x.ts"))).toEqual(["src/.hidden/x.ts"]);
  expect(paths(await searchFiles(root, "visible"))).toEqual(["src/visible.ts"]);
});

test("the answer is as long as it was asked for, and no longer than the most", async () => {
  for (let i = 0; i < 60; i++) await touch(`f${i}.txt`);
  expect((await searchFiles(root, "f", 5)).entries).toHaveLength(5);
  expect((await searchFiles(root, "f", 500)).entries).toHaveLength(FILE_SEARCH_LIMITS.results);
});

test("a tree larger than the budget gives what was found, and says it stopped", async () => {
  for (let i = 0; i < 30; i++) await touch(`d${i}/f.txt`);
  const found = await searchFiles(root, "f", 20, { entries: 10, ms: 2_000 });
  expect(found.truncated).toBe(true);
  const none = await searchFiles(root, "f", 20, { entries: 1_000, ms: -1 });
  expect(none.truncated).toBe(true);
  expect(none.entries).toEqual([]);
});

test("a folder that is not there has nothing in it, and is not an error", async () => {
  expect(await searchFiles(join(root, "missing"), "a")).toEqual({ entries: [], truncated: false });
});

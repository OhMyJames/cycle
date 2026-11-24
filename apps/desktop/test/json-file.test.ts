import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonFile, KeptEntries } from "../src/main/json-file.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-json-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a file is written whole, one save after another, with its mode, and nothing is left beside it", async () => {
  const path = join(dir, "data", "file.json");
  const file = jsonFile(path, { mode: 0o600 });
  expect(await file.read()).toBeUndefined();
  await Promise.all([file.write({ n: 1 }), file.write({ n: 2 }), file.write({ n: 3 })]);
  expect(await file.read()).toEqual({ n: 3 });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(join(dir, "data"))).toEqual(["file.json"]);
});

test("a file that is not JSON is kept beside and read as none; JSON that is not an object reads as an empty one", async () => {
  const path = join(dir, "file.json");
  await writeFile(path, "{ broken");
  expect(await jsonFile(path).read()).toBeUndefined();
  const kept = (await readdir(dir)).filter((f) => f.startsWith("file.json.broken-"));
  expect(kept).toHaveLength(1);
  expect(await readFile(join(dir, kept[0] ?? ""), "utf8")).toBe("{ broken");
  await writeFile(path, "[1, 2]");
  expect(await jsonFile(path).read()).toEqual({});
});

test("entries it cannot read, and fields it does not know, are written back; a changed one is written as it is now", () => {
  type Item = { id: string; n: number };
  const entries = new KeptEntries<Item>({
    parse: (e) => {
      const { id, n } = (e ?? {}) as { id?: unknown; n?: unknown };
      return typeof id === "string" && typeof n === "number" ? { id, n } : undefined;
    },
    idOf: (item) => item.id,
  });
  const withExtra = { id: "a", n: 1, extra: true };
  const values = entries.read([withExtra, { id: "b", n: "two" }, { id: "a", n: 9 }, "x"]);
  expect(values).toEqual([{ id: "a", n: 1 }]);
  // The second "a" would be two of one: the one read wins.
  expect(entries.write(values)).toEqual([withExtra, { id: "b", n: "two" }, "x"]);
  // A value with the id of one it could not read replaces it.
  expect(
    entries.write([
      { id: "a", n: 2 },
      { id: "b", n: 2 },
    ]),
  ).toEqual([{ id: "a", n: 2 }, { id: "b", n: 2 }, "x"]);
});

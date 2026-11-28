import { expect, test } from "bun:test";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IndexUnreadableError, SessionIndex } from "../src/index.ts";
import { eachTempDir } from "./support.ts";

let dir: string;
eachTempDir((made) => {
  dir = made;
});

const entry = {
  agent: "claude",
  agentSessionId: "a1",
  cwd: "/work",
  createdAt: "2026-11-18T00:00:00.000Z",
};

test("starts empty when there is no file", async () => {
  const index = await SessionIndex.load(join(dir, "index.json"));
  expect(index.list()).toEqual([]);
});

test("keeps what is put in it across a reload", async () => {
  const path = join(dir, "index.json");
  const index = await SessionIndex.load(path);
  await index.put("s1", entry);
  await index.update("s1", { title: "hello", archived: true });
  const again = await SessionIndex.load(path);
  expect(again.get("s1")).toEqual({ ...entry, title: "hello", archived: true });
  await again.delete("s1");
  expect((await SessionIndex.load(path)).list()).toEqual([]);
});

test("leaves no temporary file behind", async () => {
  const index = await SessionIndex.load(join(dir, "index.json"));
  await index.put("s1", entry);
  expect(await readdir(dir)).toEqual(["index.json"]);
});

test("refuses an index it cannot read, and does not touch it", async () => {
  const path = join(dir, "index.json");
  await writeFile(path, "{ not json");
  await expect(SessionIndex.load(path)).rejects.toBeInstanceOf(IndexUnreadableError);
  expect(await Bun.file(path).text()).toBe("{ not json");
});

test("refuses an index of the wrong shape", async () => {
  const path = join(dir, "index.json");
  await writeFile(path, JSON.stringify({ version: 2, sessions: {} }));
  await expect(SessionIndex.load(path)).rejects.toBeInstanceOf(IndexUnreadableError);
});

test("a change that fails leaves the index as it was", async () => {
  const index = await SessionIndex.load(join(dir, "index.json"));
  await index.put("s1", entry);
  await expect(index.update("missing", { title: "x" })).rejects.toBeDefined();
  expect(index.list().map(([id]) => id)).toEqual(["s1"]);
});

test("the index is private even when a crash left a temporary file with looser permissions", async () => {
  const path = join(dir, "index.json");
  await writeFile(`${path}.${process.pid}.tmp`, "stale", { mode: 0o644 });
  const index = await SessionIndex.load(path);
  await index.put("s1", {
    ...entry,
    mcpServers: [{ name: "x", env: [{ name: "T", value: "secret" }] }],
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("an index from before readSeq and attentionSeq loads, and keeps them once they are set", async () => {
  const path = join(dir, "index.json");
  await writeFile(path, JSON.stringify({ version: 1, sessions: { s1: entry } }));
  const index = await SessionIndex.load(path);
  expect(index.get("s1")?.readSeq).toBeUndefined();
  await index.update("s1", { attentionSeq: 7, readSeq: 3 });
  expect((await SessionIndex.load(path)).get("s1")).toMatchObject({ attentionSeq: 7, readSeq: 3 });
});

test("an index persists session origin and stays backward-compatible with entries without origin (CYC-534)", async () => {
  const path = join(dir, "index.json");
  await writeFile(path, JSON.stringify({ version: 1, sessions: { legacy: entry } }));
  const index = await SessionIndex.load(path);
  expect(index.get("legacy")?.origin).toBeUndefined();
  await index.put("loop-1", {
    ...entry,
    origin: { kind: "loop", project: "CYC", run: "CYC-534", role: "shape" },
  });
  const reloaded = await SessionIndex.load(path);
  expect(reloaded.get("legacy")?.origin).toBeUndefined();
  expect(reloaded.get("loop-1")?.origin).toEqual({
    kind: "loop",
    project: "CYC",
    run: "CYC-534",
    role: "shape",
  });
});

import { expect, test } from "bun:test";
import { appendFile, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { BLOB_META, BLOB_MISSING_META, BlobLogStore, JsonlLogStore } from "../src/index.ts";
import { eachTempDir } from "./support.ts";

let dir: string;
eachTempDir((made) => {
  dir = made;
});

const stores = () => {
  const inner = new JsonlLogStore({ dir: join(dir, "sessions") });
  return new BlobLogStore(inner, join(dir, "blobs"));
};
const big = (fill: string) => fill.repeat(40_000); // base64 text: size is what counts here
const prompt = (data: string) => ({
  sessionUpdate: "user_message",
  content: [
    { type: "text", text: "look" },
    { type: "image", mimeType: "image/png", data },
  ],
});

test("a big image is a reference in the file and bytes again when read", async () => {
  const log = await stores().open("s1");
  const data = big("QUJD");
  const stored = await log.append({ kind: "update", data: prompt(data) });
  expect(JSON.stringify(stored.data)).toContain(data); // what append returns has the bytes
  const [record] = await log.read();
  expect(record?.data).toEqual(prompt(data));
  const line = await readFile(join(dir, "sessions", "s1.jsonl"), "utf8");
  expect(line.length).toBeLessThan(1000);
  expect(line).toContain(BLOB_META);
  const files = await readdir(join(dir, "blobs", "s1"));
  expect(files).toHaveLength(1);
  expect((await stat(join(dir, "blobs", "s1", files[0] as string))).mode & 0o777).toBe(0o600);
  await log.close();
});

test("a small image stays in the log", async () => {
  const log = await stores().open("s1");
  await log.append({ kind: "update", data: prompt("QUJD") });
  expect(await readFile(join(dir, "sessions", "s1.jsonl"), "utf8")).toContain('"QUJD"');
  await expect(readdir(join(dir, "blobs", "s1"))).rejects.toThrow();
  await log.close();
});

test("subscribers get the bytes, in order", async () => {
  const log = await stores().open("s1");
  const seen: unknown[] = [];
  log.subscribe((record) => seen.push(record.data));
  await log.append({ kind: "update", data: prompt(big("QUJD")) });
  await log.append({ kind: "update", data: { sessionUpdate: "plain" } });
  await log.close();
  expect(seen).toEqual([prompt(big("QUJD")), { sessionUpdate: "plain" }]);
});

test("an embedded resource's blob and the block's own _meta are kept", async () => {
  const log = await stores().open("s1");
  const resource = {
    uri: "file:///a.pdf",
    mimeType: "application/pdf",
    blob: big("UERG"),
    _meta: { x: 1 },
  };
  await log.append({ kind: "update", data: { content: [{ type: "resource", resource }] } });
  expect((await log.read())[0]?.data).toEqual({ content: [{ type: "resource", resource }] });
  await log.close();
});

test("a log written before blobs, with the bytes inline, still reads", async () => {
  const old = new JsonlLogStore({ dir: join(dir, "sessions") });
  const first = await old.open("s1");
  await first.append({ kind: "update", data: prompt(big("QUJD")) });
  await first.close();
  const log = await stores().open("s1");
  expect((await log.read())[0]?.data).toEqual(prompt(big("QUJD")));
  await log.close();
});

test("a missing blob marks that block and leaves the log readable", async () => {
  const log = await stores().open("s1");
  await log.append({ kind: "update", data: prompt(big("QUJD")) });
  await log.append({ kind: "update", data: { sessionUpdate: "plain" } });
  await rm(join(dir, "blobs", "s1"), { recursive: true });
  await log.close();
  const again = await stores().open("s1"); // a new store: nothing held in memory
  const [first, second] = await again.read();
  const image = (
    (first?.data ?? {}) as { content?: { data?: string; _meta?: Record<string, unknown> }[] }
  ).content?.[1];
  expect(image?.data).toBe("");
  expect(image?._meta).toEqual({ [BLOB_MISSING_META]: true });
  expect(second?.data).toEqual({ sessionUpdate: "plain" });
  await again.close();
});

test("a reference that is not a hash does not reach for a file", async () => {
  const path = join(dir, "sessions", "s1.jsonl");
  const log = await stores().open("s1");
  await log.close();
  const forged = {
    type: "image",
    data: "",
    mimeType: "image/png",
    _meta: { [BLOB_META]: { field: "data", sha256: "../../index.json" } },
  };
  await appendFile(
    path,
    `${JSON.stringify({ seq: 1, ts: "2026-11-18T00:00:00Z", kind: "update", data: forged })}\n`,
  );
  const again = await stores().open("s1");
  const forgedBack = (await again.read())[0]?.data as { _meta?: unknown } | undefined;
  expect(forgedBack?._meta).toEqual({ [BLOB_MISSING_META]: true });
  await again.close();
});

test("removing a session removes its blobs and only its own", async () => {
  const store = stores();
  for (const id of ["s1", "s2"]) {
    const log = await store.open(id);
    await log.append({ kind: "update", data: prompt(big("QUJD")) });
    await log.close();
  }
  await store.remove("s1");
  await expect(readdir(join(dir, "blobs", "s1"))).rejects.toThrow();
  expect(await readdir(join(dir, "blobs", "s2"))).toHaveLength(1);
  expect(await store.exists("s1")).toBe(false);
});

test("the same big image twice in one record is stored once, and both come back", async () => {
  const log = await stores().open("s1");
  const data = big("QUJD");
  const twice = {
    sessionUpdate: "user_message",
    content: [
      { type: "image", mimeType: "image/png", data },
      { type: "image", mimeType: "image/png", data },
    ],
  };
  await log.append({ kind: "update", data: twice });
  expect((await log.read())[0]?.data).toEqual(twice);
  expect(await readdir(join(dir, "blobs", "s1"))).toHaveLength(1);
  await log.close();
});

import { expect, test } from "bun:test";
import { RemoteStore, type TextFile } from "../src/remote/store";

function disk(initial?: string) {
  const state = { text: initial, writes: 0 };
  const file: TextFile = {
    read: async () => state.text,
    write: async (text) => {
      state.text = text;
      state.writes++;
    },
  };
  let n = 0;
  return { state, store: new RemoteStore(file, () => `id${++n}`) };
}

test("servers are added, changed and removed, and kept for the next start", async () => {
  const { state, store } = disk();
  const added = await store.add({ name: "Box", target: "me@box" });
  expect(added).toEqual({ ok: true, value: { id: "id1", name: "Box", target: "me@box" } });
  await store.add({ name: "Two", target: "two", home: "~/c" });
  expect(await store.update("id1", { name: "Box 2", target: "me@box2" })).toEqual({
    ok: true,
    value: { id: "id1", name: "Box 2", target: "me@box2" },
  });
  await store.remove("id2");

  const again = new RemoteStore({ read: async () => state.text, write: async () => {} }, () => "x");
  expect(await again.list()).toEqual([{ id: "id1", name: "Box 2", target: "me@box2" }]);
});

test("an input that is refused changes nothing and writes nothing", async () => {
  const { state, store } = disk();
  expect(await store.add({ name: "x", target: "-bad" })).toMatchObject({ ok: false });
  expect(await store.update("nope", { name: "x", target: "ok" })).toMatchObject({ ok: false });
  expect(state.writes).toBe(0);
  expect(await store.list()).toEqual([]);
});

test("a file that is not readable starts an empty list", async () => {
  const { store } = disk("{broken");
  expect(await store.list()).toEqual([]);
  expect(await store.get("id1")).toBeUndefined();
});

test("two quick additions both land", async () => {
  const { store } = disk();
  await Promise.all([store.add({ name: "A", target: "a" }), store.add({ name: "B", target: "b" })]);
  expect((await store.list()).map((r) => r.name)).toEqual(["A", "B"]);
});

test("a write that fails leaves the list as it was", async () => {
  let failing = false;
  const file: TextFile = {
    read: async () => undefined,
    write: async () => {
      if (failing) throw new Error("disk full");
    },
  };
  const store = new RemoteStore(file, () => "id");
  await store.add({ name: "A", target: "a" });
  failing = true;
  await expect(store.add({ name: "B", target: "b" })).rejects.toThrow("disk full");
  await expect(store.remove("id")).rejects.toThrow("disk full");
  expect((await store.list()).map((r) => r.name)).toEqual(["A"]);
});

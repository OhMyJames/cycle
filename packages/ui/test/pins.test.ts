import { expect, test } from "bun:test";
import { createPinStore, PINS_KEY } from "../src/pins.ts";

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
};

test("nothing is pinned until something is, and a pin is read back by the next run", () => {
  expect(createPinStore(undefined).all().size).toBe(0);
  const storage = memory();
  const store = createPinStore(storage);
  store.set("local:a", true);
  expect(store.all().has("local:a")).toBe(true);
  const next = createPinStore(storage);
  expect([...next.all()]).toEqual(["local:a"]);
  next.set("local:a", false);
  expect(JSON.parse(storage.data.get(PINS_KEY) ?? "")).toEqual([]);
});

test("the set is the same object until it changes, and a change is heard", () => {
  const store = createPinStore(memory());
  const before = store.all();
  let heard = 0;
  store.subscribe(() => heard++);
  store.set("local:a", false);
  expect(store.all()).toBe(before);
  expect(heard).toBe(0);
  store.set("local:a", true);
  expect(store.all()).not.toBe(before);
  expect(heard).toBe(1);
});

test("storage that holds something else pins nothing", () => {
  expect(createPinStore(memory({ [PINS_KEY]: "{not json" })).all().size).toBe(0);
  expect(createPinStore(memory({ [PINS_KEY]: '{"a":1}' })).all().size).toBe(0);
  expect([...createPinStore(memory({ [PINS_KEY]: '["x",2]' })).all()]).toEqual(["x"]);
});

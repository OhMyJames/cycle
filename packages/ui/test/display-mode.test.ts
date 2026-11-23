import { expect, test } from "bun:test";
import { createDisplayModeStore, DISPLAY_MODE_KEY } from "../src/display-mode.ts";

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
};

test("a session is in normal mode until it is set otherwise", () => {
  expect(createDisplayModeStore(memory()).get("e:s")).toBe("normal");
  expect(createDisplayModeStore(undefined).get("e:s")).toBe("normal");
});

test("the choice is kept for its session alone, and read back by the next run", () => {
  const storage = memory();
  const store = createDisplayModeStore(storage);
  store.set("e:a", "detailed");
  expect(store.get("e:a")).toBe("detailed");
  expect(store.get("e:b")).toBe("normal");
  const next = createDisplayModeStore(storage);
  expect(next.get("e:a")).toBe("detailed");
  expect(next.get("e:b")).toBe("normal");
  // Back to normal: nothing is kept for it.
  next.set("e:a", "normal");
  expect(JSON.parse(storage.data.get(DISPLAY_MODE_KEY) ?? "")).toEqual({});
});

test("what is stored and is not a mode is ignored", () => {
  const store = createDisplayModeStore(
    memory({ [DISPLAY_MODE_KEY]: JSON.stringify({ "e:a": "loud", "e:b": "detailed" }) }),
  );
  expect(store.get("e:a")).toBe("normal");
  expect(store.get("e:b")).toBe("detailed");
  expect(createDisplayModeStore(memory({ [DISPLAY_MODE_KEY]: "not json" })).get("e:b")).toBe(
    "normal",
  );
});

test("a listener hears a change once, and not a choice that is the same", () => {
  const store = createDisplayModeStore(memory());
  let heard = 0;
  const stop = store.subscribe(() => {
    heard += 1;
  });
  store.set("e:a", "detailed");
  store.set("e:a", "detailed");
  store.set("e:b", "normal");
  expect(heard).toBe(1);
  stop();
  store.set("e:a", "normal");
  expect(heard).toBe(1);
});

test("storage that cannot be read or written leaves the choice to this run", () => {
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("full");
    },
  };
  const store = createDisplayModeStore(broken);
  expect(store.get("e:a")).toBe("normal");
  store.set("e:a", "detailed");
  expect(store.get("e:a")).toBe("detailed");
});

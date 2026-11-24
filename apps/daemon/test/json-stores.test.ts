import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentDefaults, DefaultsUnreadableError } from "../src/defaults-file.ts";
import { IndexUnreadableError, SessionIndex } from "../src/index-file.ts";
import { AgentOptionsCache } from "../src/options-cache.ts";
import { FolderTrust, TrustUnreadableError } from "../src/trust-file.ts";
import { tempDir } from "./support.ts";

// What the daemon's small JSON files have in common (the session index, the agent defaults, the options cache, the
// folder trust): each is written whole, one change at a time, so a crash leaves the old file or the new one; a change
// that cannot be written is undone in memory too; and each is private to the account.

let dir: string;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(() => dispose());

const entry = {
  agent: "claude",
  agentSessionId: "a1",
  cwd: "/w",
  createdAt: "2026-11-18T00:00:00Z",
};

/** Each store, driven the same way: a change named by a word, and what it holds read back as words. */
/** `held`: which of these words it holds, in the order given. */
type Store = { change(word: string): Promise<unknown>; held(words: string[]): string[] };
const stores: Record<string, (path: string) => Promise<Store>> = {
  index: async (path) => {
    const index = await SessionIndex.load(path);
    return {
      change: (word) => index.put(word, entry),
      held: (words) => words.filter((word) => index.get(word) !== undefined),
    };
  },
  defaults: async (path) => {
    const defaults = await AgentDefaults.load(path);
    return {
      change: async (word) => {
        await defaults.set(word, { model: word });
      },
      held: (words) => words.filter((word) => defaults.get(word).model === word),
    };
  },
  cache: async (path) => {
    const cache = await AgentOptionsCache.load(path);
    const schema = { properties: { model: { type: "string" } } };
    return {
      change: async (word) => {
        await cache.update(word, "model", [{ const: word, title: word }]);
      },
      held: (words) => words.filter((word) => cache.apply(word, schema) !== schema),
    };
  },
  trust: async (path) => {
    const trust = await FolderTrust.load(path);
    return {
      change: async (word) => {
        await trust.set(`/${word}`, true);
      },
      held: (words) => words.filter((word) => trust.of(`/${word}`).trusted === true),
    };
  },
};

for (const [name, open] of Object.entries(stores)) {
  test(`${name}: what is changed is kept across a reload, in the order the changes were made`, async () => {
    const path = join(dir, "sub", `${name}.json`);
    const store = await open(path);
    await Promise.all(["a", "b", "c"].map((word) => store.change(word)));
    expect(store.held(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    const again = await open(path);
    expect(again.held(["a", "b", "c", "d"])).toEqual(["a", "b", "c"]);
    expect((await readdir(join(dir, "sub"))).sort()).toEqual([`${name}.json`]);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });

  test(`${name}: a change that cannot be written is undone, and the next one is written`, async () => {
    const path = join(dir, `${name}.json`);
    const store = await open(path);
    await store.change("a");
    const before = await readFile(path, "utf8");
    // A folder where the file goes: the rename over it fails.
    await Bun.file(path).delete();
    await mkdir(path);
    await expect(store.change("b")).rejects.toBeDefined();
    expect(store.held(["a", "b"])).toEqual(["a"]);
    await rmdir(path);
    await store.change("c");
    expect(store.held(["a", "b", "c"])).toEqual(["a", "c"]);
    expect((await open(path)).held(["a", "b", "c"])).toEqual(["a", "c"]);
    // What is written is the change that was, not the one undone.
    const written = await readFile(path, "utf8");
    expect(written).not.toBe(before);
    expect(written).not.toContain('"b"');
  });

  test(`${name}: the file is private to the account, though a crash left a looser temporary file`, async () => {
    const path = join(dir, `${name}.json`);
    await writeFile(`${path}.${process.pid}.tmp`, "stale", { mode: 0o644 });
    const store = await open(path);
    await store.change("a");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
}

test("a file that cannot be read stops the index, the defaults and the trust, and is not replaced", async () => {
  for (const [name, load, Unreadable] of [
    ["index", SessionIndex.load, IndexUnreadableError],
    ["defaults", AgentDefaults.load, DefaultsUnreadableError],
    ["trust", FolderTrust.load, TrustUnreadableError],
  ] as const) {
    const path = join(dir, `${name}.json`);
    await writeFile(path, "{not json");
    await expect(load(path)).rejects.toBeInstanceOf(Unreadable);
    expect(await readFile(path, "utf8")).toBe("{not json");
  }
});

test("a cache that cannot be read is started again empty", async () => {
  const path = join(dir, "cache.json");
  await writeFile(path, "{not json");
  const cache = await AgentOptionsCache.load(path);
  const schema = { properties: { model: {} } };
  expect(cache.apply("claude", schema)).toBe(schema);
});

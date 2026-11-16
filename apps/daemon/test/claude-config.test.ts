import { expect, test } from "bun:test";
import { type ClaudeConfig, emptyConfig } from "@cycle/harness-claude";
import { JsonStore, claudeConfigBook } from "../src/index.ts";

async function open(kept: string | null) {
  const written: string[] = [];
  const store = await JsonStore.open<ClaudeConfig>(
    {
      read: async () => kept,
      write: async (text) => {
        written.push(text);
      },
    },
    emptyConfig(),
    () => () => {},
  );
  return { book: claudeConfigBook(store), written };
}

test("a home with no claude.json has an empty configuration", async () => {
  const { book } = await open(null);
  expect(book.read()).toEqual(emptyConfig());
});

test("a file kept before a key existed reads that key as empty", async () => {
  const { book } = await open(JSON.stringify({ skillsOff: ["review"] }));
  expect(book.read()).toEqual({ ...emptyConfig(), skillsOff: ["review"] });
});

test("a change is on disk before it is said done, since the next process reads it there", async () => {
  const { book, written } = await open(null);
  await book.write({ ...emptyConfig(), ownerHooks: false });
  expect(JSON.parse(written.at(-1) ?? "{}").ownerHooks).toBe(false);
  expect(book.read().ownerHooks).toBe(false);
});

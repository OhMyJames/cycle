import { expect, test } from "bun:test";
import type { TerminalInfo } from "../src/api.ts";
import {
  HELD_LIMIT,
  inputPieces,
  mergeTerminals,
  neighbourOf,
  TerminalFeed,
  tabKind,
  terminalCount,
  terminalOfTab,
  terminalTab,
} from "../src/terminals.ts";

const info = (terminalId: string, extra: Partial<TerminalInfo> = {}): TerminalInfo => ({
  terminalId,
  sessionId: "s1",
  title: "zsh",
  cols: 80,
  rows: 24,
  status: "running",
  ...extra,
});

/** A feed whose screen is a list of what was drawn. */
const feed = () => {
  const drawn: string[] = [];
  const f = new TerminalFeed(
    (data) => drawn.push(data),
    (screen) => drawn.push(`[screen ${screen}]`),
  );
  return { f, drawn };
};

test("output that comes before the screen is held, and what the screen already holds is dropped", () => {
  const { f, drawn } = feed();
  f.wait();
  f.output(2, "b");
  f.output(3, "c");
  f.output(4, "d");
  expect(drawn).toEqual([]);
  f.screen(3, "abc", 80, 24);
  expect(drawn).toEqual(["[screen abc]", "d"]);
  f.output(4, "d");
  f.output(5, "e");
  expect(drawn).toEqual(["[screen abc]", "d", "e"]);
});

test("a reset draws again and drops what it holds; an attach answer older than it is not drawn", () => {
  const { f, drawn } = feed();
  f.wait();
  f.screen(10, "ten", 80, 24);
  f.screen(7, "seven", 80, 24);
  f.output(9, "old");
  f.output(11, "new");
  expect(drawn).toEqual(["[screen ten]", "new"]);
});

test("held output has a ceiling: the oldest goes first", () => {
  const { f, drawn } = feed();
  f.wait();
  const big = "x".repeat(HELD_LIMIT / 2 + 1);
  f.output(1, big);
  f.output(2, big);
  f.output(3, "tail");
  f.screen(0, "", 80, 24);
  expect(drawn.slice(1)).toEqual([big, "tail"]);
});

test("a session's terminals, told again after a reconnect, keep the ones that went as ended", () => {
  const known = [info("t1"), info("t2")];
  const after = mergeTerminals(known, [info("t1")], "kept");
  expect(after.map((t) => [t.terminalId, t.ended ?? false])).toEqual([
    ["t1", false],
    ["t2", true],
  ]);
  // Told while connected (closed elsewhere): it goes; one that had ended stays until its tab is closed.
  const later = mergeTerminals(after, [], "dropped");
  expect(later.map((t) => [t.terminalId, t.ended ?? false])).toEqual([["t2", true]]);
});

test("closing the tab shown shows the one before it, or the first", () => {
  const tabs = ["overview", "diff", terminalTab("a"), terminalTab("b")] as const;
  expect(neighbourOf(tabs, terminalTab("b"))).toBe(terminalTab("a"));
  expect(neighbourOf(tabs, "overview")).toBe("diff");
  expect(neighbourOf(["overview"], "overview")).toBeUndefined();
});

test("a tab's terminal, its kind for analytics, and how many terminals in four words", () => {
  expect(terminalOfTab(terminalTab("t:1"))).toBe("t:1");
  expect(terminalOfTab("files")).toBeUndefined();
  expect(tabKind(terminalTab("x"))).toBe("terminal");
  expect(tabKind("diff")).toBe("diff");
  expect([0, 1, 2, 3, 4, 9].map(terminalCount)).toEqual([
    "none",
    "one",
    "few",
    "few",
    "many",
    "many",
  ]);
});

test("a paste goes in pieces under the daemon's limit, never between the halves of a character", () => {
  expect(inputPieces("")).toEqual([]);
  expect(inputPieces("abc", 2)).toEqual(["ab", "c"]);
  expect(inputPieces("😀😀", 1)).toEqual(["😀", "😀"]);
  const emoji = "a😀b";
  // Cut at 2 would split the surrogate pair: the piece ends before it.
  expect(inputPieces(emoji, 2)).toEqual(["a", "😀", "b"]);
  const big = "é".repeat(40_000);
  const pieces = inputPieces(big);
  expect(pieces.join("")).toBe(big);
  for (const piece of pieces)
    expect(new TextEncoder().encode(piece).length).toBeLessThanOrEqual(64 * 1024);
});

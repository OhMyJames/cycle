import { expect, test } from "bun:test";
import { FIRST_TITLE_LIMIT, firstTitle } from "../src/first-title.ts";

const text = (value: string) => ({ type: "text", text: value });
const image = { type: "image", data: "AAAA", mimeType: "image/png" };

test("the first line with words in it, trimmed, its whitespace made one space", () => {
  expect(firstTitle([text("  Fix   the\tlogin  bug  \nand then the tests")])).toBe(
    "Fix the login bug",
  );
  expect(firstTitle([text("\n \r\n  look at this\r\nsecond")])).toBe("look at this");
});

test("what a terminal or bidi marks would make of a name is taken out", () => {
  expect(firstTitle([text("\u001b[31merror\u001b[0m: \u202Ebad\u202C thing")])).toBe(
    "[31merror [0m: bad thing",
  );
});

test("a line of megabytes is not read whole, and its name says it goes on", () => {
  expect(firstTitle([text(`short ${" ".repeat(5_000_000)}x`)])).toBe("short…");
  expect(firstTitle([text(`${"x".repeat(5_000_000)}`)])).toBe(
    `${"x".repeat(FIRST_TITLE_LIMIT - 1)}…`,
  );
});

test("only the words: images, files and links are not part of the name", () => {
  expect(
    firstTitle([
      image,
      text("what is in this picture?"),
      { type: "resource_link", name: "a.ts", uri: "file:///a.ts" },
    ]),
  ).toBe("what is in this picture?");
});

test("a message without words gives no name", () => {
  expect(firstTitle([image])).toBeUndefined();
  expect(
    firstTitle([image, { type: "resource", resource: { uri: "file:///a.txt", text: "x" } }]),
  ).toBeUndefined();
  expect(firstTitle([text("  \n\t ")])).toBeUndefined();
  expect(firstTitle([])).toBeUndefined();
});

test("a long line is cut, ending with an ellipsis, without splitting a character", () => {
  const exact = "a".repeat(FIRST_TITLE_LIMIT);
  expect(firstTitle([text(exact)])).toBe(exact);
  const long = firstTitle([text(`${"word ".repeat(40)}end`)]);
  expect(long?.endsWith("…")).toBe(true);
  expect(long).toBe(`${"word ".repeat(12).trimEnd()}…`);
  // The cut is not left with a space before the ellipsis.
  const atSpace = `${"a".repeat(FIRST_TITLE_LIMIT - 2)} ${"b".repeat(10)}`;
  expect(firstTitle([text(atSpace)])).toBe(`${"a".repeat(FIRST_TITLE_LIMIT - 2)}…`);
  const emoji = firstTitle([text("👩‍👩‍👧".repeat(FIRST_TITLE_LIMIT + 5))]);
  expect(emoji).toBe(`${"👩‍👩‍👧".repeat(FIRST_TITLE_LIMIT - 1)}…`);
});

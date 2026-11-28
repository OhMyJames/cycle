import { expect, test } from "bun:test";
import { draftHasText } from "../src/react/use-has-draft.ts";

test("only non-blank text counts as an unsent draft", () => {
  expect(draftHasText({ text: "hello" })).toBe(true);
  expect(draftHasText({ text: "" })).toBe(false);
  expect(draftHasText({ text: "  \n " })).toBe(false);
});

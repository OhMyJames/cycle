import { expect, test } from "bun:test";
import { startedAt } from "../src/started.ts";

test("a step's start is the first time it was asked about, however often it is asked again", () => {
  expect(startedAt("tool:x", 1_000)).toBe(1_000);
  expect(startedAt("tool:x", 9_000)).toBe(1_000);
  expect(startedAt("tool:y", 5_000)).toBe(5_000);
});

test("only the latest are kept", () => {
  for (let n = 0; n < 250; n++) startedAt(`many:${n}`, n);
  // The oldest went: asked again, it starts now.
  expect(startedAt("many:0", 99_999)).toBe(99_999);
  expect(startedAt("many:249", 99_999)).toBe(249);
});

test("one still asked about is kept, however many newer ones come", () => {
  startedAt("long:run", 7);
  for (let n = 0; n < 250; n++) {
    startedAt(`newer:${n}`, n);
    startedAt("long:run", 99_999);
  }
  expect(startedAt("long:run", 99_999)).toBe(7);
});

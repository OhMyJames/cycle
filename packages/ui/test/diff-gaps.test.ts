import { expect, test } from "bun:test";
import { skippedLines } from "../src/diff-gaps.ts";
import { diffLines } from "../src/model/index.ts";

test("a change says how many lines of the file are left out above its first part and between its parts", () => {
  const lines = diffLines(
    [
      "@@ -4,3 +4,4 @@",
      " four",
      "-five",
      "+five!",
      "+five and a half",
      " six",
      "@@ -20,2 +21,2 @@",
      " twenty",
      "-twenty-one",
      "+twenty-one!",
    ].join("\n"),
  );
  const hunks = lines.filter((line) => line.kind === "hunk");
  // Lines 1 to 3 above the first part; the new file's 8 to 20 between the two.
  expect(hunks.map((hunk) => skippedLines(lines).get(hunk.id))).toEqual([3, 13]);
});

test("a part with nothing left out before it, or a marker that says no numbers, has no count", () => {
  const whole = diffLines("@@ -0,0 +1,2 @@\n+one\n+two\n");
  expect(skippedLines(whole).size).toBe(0);
  expect(skippedLines([{ kind: "hunk", text: "", id: "h0" }]).size).toBe(0);
});

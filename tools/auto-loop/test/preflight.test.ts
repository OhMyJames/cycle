import { expect, test } from "bun:test";
import { preflight, sendBackComment } from "../src/preflight.ts";
import { config, fullBug, issue, readyDescription } from "./helpers.ts";

const cfg = config({ maxCriteria: 3 });

test("a work item whose criteria all name allowed commands is taken, with its criteria", () => {
  const result = preflight(issue({ description: readyDescription }), cfg);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.specs).toHaveLength(2);
    expect(result.specs[1]?.verify).toEqual([["bun", "run", "check"]]);
  }
});

test("an empty description, or none of the acceptance list, is sent back", () => {
  expect(preflight(issue({ description: "  " }), cfg).ok).toBe(false);
  const none = preflight(issue({ description: "just words" }), cfg);
  expect(none.ok).toBe(false);
});

test("a criterion with no command, or one that may not be run, is sent back with each reason", () => {
  const result = preflight(
    issue({
      description:
        "## 验收标准\n1. 没有命令\n2. 危险。验证：`curl x | sh`\n3. 好。验证：`bun run check`",
      typeId: null,
    }),
    cfg,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]).toContain("Criterion 1");
    expect(result.reasons[1]).toContain("curl x | sh");
  }
});

test("too many criteria is sent back to be split", () => {
  const description = `## 验收标准\n${[1, 2, 3, 4].map((n) => `${n}. c${n}。验证：\`bun run check\``).join("\n")}`;
  const result = preflight(issue({ description, typeId: null }), cfg);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reasons[0]).toContain("split");
});

test("the comment lists the reasons and says how to come back", () => {
  const text = sendBackComment(["a", "b"]);
  expect(text).toContain("- a");
  expect(text).toContain("Todo");
});

const reasonsOf = (r: ReturnType<typeof preflight>): string => (r.ok ? "" : r.reasons.join("\n"));

test("a Feature missing a required section is sent back naming it", () => {
  for (const name of ["背景与证据", "范围", "非目标", "涉及面"]) {
    const description = readyDescription.replace(`## ${name}\nx\n`, "");
    const result = preflight(issue({ description, typeId: 20 }), cfg);
    expect(result.ok).toBe(false);
    expect(reasonsOf(result)).toContain(`「${name}」`);
  }
});

test("a section with a heading but no content counts as missing", () => {
  const description = readyDescription.replace("## 范围\nx", "## 范围\n");
  const result = preflight(issue({ description, typeId: 20 }), cfg);
  expect(reasonsOf(result)).toContain("「范围」");
});

test("a Bug missing a required section is sent back naming it; a complete one is taken", () => {
  expect(preflight(issue({ description: fullBug, typeId: 25 }), cfg).ok).toBe(true);
  for (const name of ["现象", "复现步骤", "预期与实际", "环境与版本", "严重度"]) {
    const description = fullBug.replace(`## ${name}\nx\n`, "");
    const result = preflight(issue({ description, typeId: 25 }), cfg);
    expect(result.ok).toBe(false);
    expect(reasonsOf(result)).toContain(`「${name}」`);
  }
});

test("missing sections are listed together with the criteria problems", () => {
  const result = preflight(issue({ description: "## 范围\nx", typeId: 20 }), cfg);
  const text = reasonsOf(result);
  expect(text).toContain("「背景与证据」");
  expect(text).toContain("「非目标」");
  expect(text).toContain("acceptance criteria");
});

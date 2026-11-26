import { expect, test } from "bun:test";
import { conclusionIsEmpty, preflight, sendBackComment } from "../src/preflight.ts";
import { config, fullBug, issue, readyDescription } from "./helpers.ts";

const cfg = config({ maxCriteria: 3 });

test("a work item whose criteria all name allowed commands is taken, with its criteria", () => {
  const result = preflight(issue({ description: readyDescription }), cfg);
  expect(result.ok && result.kind).toBe("dev");
  if (result.ok && result.kind === "dev") {
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

const RESEARCH = 30;
const research = config({
  maxCriteria: 3,
  research: {
    typeId: RESEARCH,
    backlogColumn: 21,
    folderId: 7,
    readRoots: ["/repo"],
    maxFollowups: 5,
  },
});

const readyResearch = `## 背景
x

## 要回答的问题

1. worktree 占多少空间？
2. 哪些可以删？

## 方法与范围
只读 \`repoRoot/.agents/worktree\`。

## 产出形式
一份报告。

## 结论
（做完后回填）
`;

test("Feature and Bug results are the same whether research is on or off", () => {
  const items = [
    issue({ description: readyDescription }),
    issue({ description: fullBug, typeId: 25 }),
    issue({ description: readyDescription.replace("## 范围\nx\n", ""), typeId: 20 }),
    issue({ description: "## 验收标准\n1. 没有命令", typeId: null }),
    issue({ description: "  " }),
  ];
  for (const item of items) expect(preflight(item, research)).toEqual(preflight(item, cfg));
});

test("with research off, a research-shaped item is judged as before, whatever its type", () => {
  for (const typeId of [null, RESEARCH]) {
    const result = preflight(issue({ description: readyResearch, typeId }), cfg);
    expect(reasonsOf(result)).toContain("acceptance criteria");
  }
});

test("a research item with numbered questions, method, output and an empty conclusion is taken, with its questions", () => {
  const result = preflight(issue({ description: readyResearch, typeId: RESEARCH }), research);
  expect(result).toEqual({
    ok: true,
    kind: "research",
    questions: ["worktree 占多少空间？", "哪些可以删？"],
  });
});

const researchReasons = (description: string): string =>
  reasonsOf(preflight(issue({ description, typeId: RESEARCH }), research));

test("a research item is sent back for each thing it lacks, with its own reason", () => {
  const noQuestions = readyResearch.replace(/## 要回答的问题\n\n1\. .*\n2\. .*\n/, "");
  expect(researchReasons(noQuestions)).toContain("no list of questions");
  expect(researchReasons(readyResearch.replace("1. worktree", "- worktree"))).toContain(
    "must be a numbered list",
  );
  const four = researchReasons(readyResearch.replace("2. 哪些可以删？", "2. b\n3. c\n4. d"));
  expect(four).toContain("4 questions");
  expect(four).toContain("Please split it");
  const noMethod = readyResearch.replace("## 方法与范围\n只读 `repoRoot/.agents/worktree`。\n", "");
  expect(researchReasons(noMethod)).toContain("「方法与范围」");
  expect(researchReasons(readyResearch.replace("一份报告。", ""))).toContain("「产出形式」");
  const answered = readyResearch.replace("（做完后回填）", "已经查过了，结论是 x。");
  expect(researchReasons(answered)).toContain("「结论」");
  expect(researchReasons("   ")).toContain("no description");
});

test("a research item's conclusion may be absent, empty or a placeholder", () => {
  for (const conclusion of ["## 结论\n", "## 结论\n\n待回填\n", "## 结论\n(TBD)\n", ""]) {
    const description = readyResearch.replace("## 结论\n（做完后回填）\n", conclusion);
    expect(preflight(issue({ description, typeId: RESEARCH }), research).ok).toBe(true);
  }
});

test("conclusionIsEmpty reads only the 「结论」 section, up to the next heading of its level", () => {
  expect(conclusionIsEmpty("## 背景\nx")).toBe(true);
  expect(conclusionIsEmpty("## 结论\n\n## 附录\n很多字")).toBe(true);
  expect(conclusionIsEmpty("## 结论\n（ 做完后回填 ）\n## 附录\n很多字")).toBe(true);
  expect(conclusionIsEmpty("## 结论\n### 小结\n")).toBe(false);
  expect(conclusionIsEmpty("## 结论\n能删。")).toBe(false);
});

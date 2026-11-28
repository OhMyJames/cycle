import { expect, test } from "bun:test";
import {
  ALLOWED_COMMANDS,
  conclusionIsEmpty,
  preflight,
  sendBackComment,
  UI_CRITERIA_GUIDE,
} from "../src/preflight.ts";
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

test("maxCriteria defaults to 12: 9–12 criteria pass, 13 are sent back (CYC-509)", () => {
  const dflt = config();
  expect(dflt.maxCriteria).toBe(12);
  const body = (n: number) =>
    `## 验收标准\n${Array.from({ length: n }, (_, i) => `${i + 1}. c${i + 1}。验证：\`bun run check\``).join("\n")}`;
  for (const n of [9, 12]) {
    expect(preflight(issue({ description: body(n), typeId: null }), dflt).ok).toBe(true);
  }
  const result = preflight(issue({ description: body(13), typeId: null }), dflt);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reasons[0]).toContain("at most 12");
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

test("a 「结论」 that is one bracketed note is empty; text outside it, or a second paragraph, is written", () => {
  // CYC-445's, and the Research issue template's.
  expect(conclusionIsEmpty("## 结论\n\n（未完成）\n")).toBe(true);
  expect(
    conclusionIsEmpty("## 结论\n（做完后回填：对每个问题的回答和依据。未完成时留空）\n## 附录\nx"),
  ).toBe(true);
  expect(conclusionIsEmpty("## 结论\n(not done yet)")).toBe(true);
  expect(conclusionIsEmpty("## 结论\n（未完成）能删一半。")).toBe(false);
  expect(conclusionIsEmpty("## 结论\n能删一半（见报告）")).toBe(false);
  expect(conclusionIsEmpty("## 结论\n（能删一半）\n\n（见报告）")).toBe(false);
  expect(conclusionIsEmpty("## 结论\n（能删一半\n\n详见报告）")).toBe(false);
  const template = readyResearch.replace(
    "（做完后回填）",
    "（做完后回填：对每个问题的回答和依据。未完成时留空）",
  );
  expect(preflight(issue({ description: template, typeId: RESEARCH }), research).ok).toBe(true);
});

test("UI_CRITERIA_GUIDE names the three ways, the ./ rule and test:real; ALLOWED_COMMANDS lists every form", () => {
  for (const word of [
    "bun run test:integration web",
    "bun run test:browser",
    "bun test ./",
    "必须以 `./` 开头",
    "test:real",
  ]) {
    expect(UI_CRITERIA_GUIDE).toContain(word);
  }
  for (const form of [
    "bun run check",
    "bun run test:browser",
    "bun run test:integration [suite]",
    "bun test <path>",
  ]) {
    expect(ALLOWED_COMMANDS).toContain(form);
  }
});

const DESIGN = 31;
const design = config({
  maxCriteria: 3,
  design: {
    typeId: DESIGN,
    backlogColumn: 21,
    folderId: 8,
    readRoots: ["/repo"],
    maxFollowups: 5,
  },
});
const readyDesign = `## 背景与约束
现有 Loop 只存 JSON。

## 要回答的问题

1. 用哪种存储？
2. 怎么迁移？

## 结论
（做完后回填）
`;
const designReasons = (description: string): string =>
  reasonsOf(preflight(issue({ description, typeId: DESIGN }), design));

test("a design item with numbered questions, its background and an empty conclusion is taken as design", () => {
  expect(preflight(issue({ description: readyDesign, typeId: DESIGN }), design)).toEqual({
    ok: true,
    kind: "design",
    questions: ["用哪种存储？", "怎么迁移？"],
  });
});

test("with design off, a Design-typed item is not judged as design", () => {
  const result = preflight(issue({ description: readyDesign, typeId: DESIGN }), research);
  expect(result.ok === true && result.kind === "design").toBe(false);
});

test("a design item is sent back for each thing it lacks", () => {
  expect(designReasons(readyDesign.replace(/1\. .*\n2\. .*\n/, ""))).toContain(
    "no list of questions",
  );
  expect(designReasons(readyDesign.replace("1. 用哪种", "- 用哪种"))).toContain("numbered list");
  expect(designReasons(readyDesign.replace("2. 怎么迁移？", "2. b\n3. c\n4. d"))).toContain(
    "at most 3",
  );
  expect(designReasons(readyDesign.replace("现有 Loop 只存 JSON。", ""))).toContain(
    "「背景与约束」",
  );
  expect(designReasons(readyDesign.replace("（做完后回填）", "已有结论。"))).toContain("「结论」");
  expect(designReasons("   ")).toContain("no description");
});

test("a design item's conclusion may be absent, empty or one bracketed note", () => {
  for (const tail of ["", "## 结论\n", "## 结论\n\n（待定）\n"]) {
    const description = readyDesign.split("## 结论")[0] + tail;
    expect(preflight(issue({ description, typeId: DESIGN }), design).ok).toBe(true);
  }
});

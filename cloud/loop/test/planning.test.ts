import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  backlogFingerprint,
  bodyHash,
  candidates,
  checkShape,
  checkTriage,
  integrationSuites,
  latestCommentAt,
  MAX_BODY,
  openingParagraph,
  type PlanState,
  parseShape,
  parseTriage,
  type ShapeRules,
  shapeKind,
  shouldPlan,
  workflowRules,
} from "../src/planning.ts";
import { ALLOWED_COMMANDS, UI_CRITERIA_GUIDE } from "../src/preflight.ts";
import {
  type CandidateSummary,
  parseVerdict,
  shapeBrief,
  shapeFixBrief,
  shapeQaBrief,
  triageBrief,
  triageFixBrief,
} from "../src/prompts/index.ts";
import type { PlanMemory } from "../src/store.ts";
import type { Issue, IssueComment, PlanningConfig } from "../src/types.ts";
import { config, fullBug, issue } from "./helpers.ts";

const BACKLOG = 21;
const FEATURE = 20;
const BUG = 25;
const planning: PlanningConfig = {
  labels: { pending: 40, awaitingAnswer: 41, skip: 42, fullProcess: 12 },
  backlogColumn: BACKLOG,
  epicTypeId: 17,
  templates: { feature: "## 背景与证据\n", bug: "## 现象\n" },
  maxPending: 5,
  intervalMinutes: 30,
  maxSplit: 3,
};
const rules = { ...config(), planning };

const item = (n: number, over: Partial<Issue> = {}): Issue =>
  issue({
    id: n,
    number: n,
    key: `CYC-${n}`,
    title: `work item ${n}`,
    description: `body ${n}`,
    columnId: BACKLOG,
    labelIds: [],
    typeId: FEATURE,
    ...over,
  });

// ---------------------------------------------------------------------------------------------------------------
// bodyHash and the Backlog fingerprint

test("bodyHash ignores line endings, trailing blanks and blank lines, which the tracker reflows", () => {
  const base = bodyHash("Title", "第一段。\n\n## 范围\n- a\n- b\n");
  expect(bodyHash("Title", "第一段。\r\n\r\n## 范围\r\n- a\r\n- b\r\n")).toBe(base);
  expect(bodyHash("Title", "第一段。  \n\n## 范围\t\n- a\n- b")).toBe(base);
  expect(bodyHash("Title", "第一段。\n\n\n\n## 范围\n\n- a\n- b\n\n\n")).toBe(base);
  // A blank line taken away counts as unchanged too: the tracker adds and drops them around headings.
  expect(bodyHash("Title", "第一段。\n## 范围\n- a\n- b")).toBe(base);
  expect(bodyHash(" Title ", "第一段。\n\n## 范围\n- a\n- b\n")).toBe(base);
});

test("bodyHash changes with the words, and keeps the title and body apart", () => {
  const base = bodyHash("Title", "第一段。\n## 范围\n- a");
  expect(bodyHash("Title", "第一段。\n## 范围\n- b")).not.toBe(base);
  expect(bodyHash("Title!", "第一段。\n## 范围\n- a")).not.toBe(base);
  expect(bodyHash("a", "b")).not.toBe(bodyHash("a\nb", ""));
  expect(bodyHash("Title", "a b")).not.toBe(bodyHash("Title", "ab"));
});

const comment = (createdAt: string): IssueComment => ({
  id: 1,
  replyToId: null,
  authorId: "u",
  authorName: "A",
  body: "x",
  createdAt,
});

test("latestCommentAt is the newest comment's time, or null with none", () => {
  expect(latestCommentAt([])).toBeNull();
  expect(
    latestCommentAt([
      comment("2026-11-25T10:00:00.000Z"),
      comment("2026-11-26T09:00:00.000Z"),
      comment("2026-11-24T00:00:00.000Z"),
    ]),
  ).toBe("2026-11-26T09:00:00.000Z");
});

test("backlogFingerprint changes for a new, edited, relabelled or commented work item, not for the order", () => {
  const backlog = [item(1, { labelIds: [41] }), item(2)];
  const base = backlogFingerprint(backlog, { "CYC-1": null });
  expect(backlogFingerprint([...backlog].reverse(), {})).toBe(base);
  expect(backlogFingerprint([...backlog, item(3)], {})).not.toBe(base);
  expect(backlogFingerprint([backlog[0] as Issue, item(2, { description: "new" })], {})).not.toBe(
    base,
  );
  // 待回答 taken off.
  expect(backlogFingerprint([item(1), item(2)], {})).not.toBe(base);
  expect(backlogFingerprint(backlog, { "CYC-2": "2026-11-26T00:00:00.000Z" })).not.toBe(base);
  // Only blank lines changed: the same.
  expect(
    backlogFingerprint([backlog[0] as Issue, item(2, { description: "body 2\n\n" })], {}),
  ).toBe(base);
});

// ---------------------------------------------------------------------------------------------------------------
// Candidates

test("candidates are the Backlog's Feature and Bug leaves without any of the five labels", () => {
  const backlog = [
    item(1),
    item(2, { typeId: BUG }),
    item(3, { typeId: 17 }), // Epic
    item(4, { typeId: 30 }), // Research
    item(5, { subtaskCount: 2 }),
    item(6, { subtaskCount: null }),
    item(7, { columnId: 22 }), // Todo
    item(8, { labelIds: [11] }), // auto
    item(9, { labelIds: [40] }), // 待批准
    item(10, { labelIds: [41] }), // 待回答
    item(11, { labelIds: [42] }), // Loop 跳过
    item(12, { labelIds: [3, 12] }), // 完整流程
    item(13, { labelIds: [3] }), // another label
  ];
  expect(candidates(backlog, rules, {}, {}).map((i) => i.key)).toEqual([
    "CYC-1",
    "CYC-2",
    "CYC-13",
  ]);
});

test("a project without a 完整流程 label still filters the rest", () => {
  const without = {
    ...config(),
    planning: { ...planning, labels: { ...planning.labels, fullProcess: null } },
  };
  const backlog = [item(1, { labelIds: [12] }), item(2, { labelIds: [42] })];
  expect(candidates(backlog, without, {}, {}).map((i) => i.key)).toEqual(["CYC-1"]);
});

const memoryOf = (i: Issue, over: Partial<PlanMemory[string]> = {}): PlanMemory => ({
  [i.key]: {
    category: "不适合",
    bodyHash: bodyHash(i.title, i.description),
    lastCommentAt: "2026-11-25T00:00:00.000Z",
    stopped: false,
    ...over,
  },
});

test("an unchanged 不适合, or one whose shaping stopped, is left out until its body or comments change", () => {
  const one = item(1);
  const seen = { "CYC-1": "2026-11-25T00:00:00.000Z" };
  const keys = (backlog: Issue[], memory: PlanMemory, latest: Record<string, string | null>) =>
    candidates(backlog, rules, memory, latest).map((i) => i.key);
  expect(keys([one], memoryOf(one), seen)).toEqual([]);
  expect(keys([one], memoryOf(one, { category: "能做", stopped: true }), seen)).toEqual([]);
  // Edited, retitled, commented on, or its comments not read: looked at again.
  expect(keys([item(1, { description: "more" })], memoryOf(one), seen)).toEqual(["CYC-1"]);
  expect(keys([item(1, { title: "new" })], memoryOf(one), seen)).toEqual(["CYC-1"]);
  expect(keys([one], memoryOf(one), { "CYC-1": "2026-11-26T00:00:00.000Z" })).toEqual(["CYC-1"]);
  expect(keys([one], memoryOf(one), {})).toEqual(["CYC-1"]);
  // A blank line the tracker added is not a change.
  expect(keys([item(1, { description: "body 1\n\n" })], memoryOf(one), seen)).toEqual([]);
  // Other categories that did not stop are looked at every round.
  expect(keys([one], memoryOf(one, { category: "能做" }), seen)).toEqual(["CYC-1"]);
  expect(keys([one], memoryOf(one, { category: "要问" }), seen)).toEqual(["CYC-1"]);
  const none = memoryOf(one, { lastCommentAt: null });
  expect(keys([one], none, { "CYC-1": null })).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// When to plan

const now = new Date("2026-11-26T12:00:00.000Z");
const ready: PlanState = {
  freeWorker: true,
  todoTakeable: false,
  pending: 2,
  maxPending: 5,
  roundRunning: false,
  lastEndedAt: new Date(now.getTime() - 31 * 60_000),
  intervalMinutes: 30,
  now,
  backlogChanged: false,
};

test("shouldPlan when every condition holds, and never before the first round has ended", () => {
  expect(shouldPlan(ready)).toBe(true);
  expect(shouldPlan({ ...ready, lastEndedAt: null })).toBe(true);
  expect(shouldPlan({ ...ready, lastEndedAt: new Date(now.getTime() - 30 * 60_000) })).toBe(true);
});

test("shouldPlan is false when any one condition fails", () => {
  expect(shouldPlan({ ...ready, freeWorker: false })).toBe(false);
  expect(shouldPlan({ ...ready, todoTakeable: true })).toBe(false);
  expect(shouldPlan({ ...ready, pending: 5 })).toBe(false);
  expect(shouldPlan({ ...ready, pending: 6 })).toBe(false);
  expect(shouldPlan({ ...ready, roundRunning: true })).toBe(false);
  expect(shouldPlan({ ...ready, roundRunning: true, lastEndedAt: null })).toBe(false);
  const recent = { ...ready, lastEndedAt: new Date(now.getTime() - 29 * 60_000) };
  expect(shouldPlan(recent)).toBe(false);
});

test("a Backlog change starts a round before the interval, but no other condition is waived", () => {
  const recent = { ...ready, lastEndedAt: new Date(now.getTime() - 60_000), backlogChanged: true };
  expect(shouldPlan(recent)).toBe(true);
  expect(shouldPlan({ ...recent, todoTakeable: true })).toBe(false);
  expect(shouldPlan({ ...recent, pending: 5 })).toBe(false);
  expect(shouldPlan({ ...recent, roundRunning: true })).toBe(false);
  expect(shouldPlan({ ...recent, freeWorker: false })).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------
// Triage

const keys = ["CYC-1", "CYC-2", "CYC-3", "CYC-4"];
const lines = {
  1: '{"key": "CYC-1", "category": "能做", "priority": "high", "reason": "范围清楚。"}',
  2: '{"key": "CYC-2", "category": "要问", "priority": "medium", "reason": "两种读法。", "questions": ["是 A 还是 B？"]}',
  3: '{"key": "CYC-3", "category": "要拆", "priority": "low", "reason": "两块。"}',
  4: '{"key": "CYC-4", "category": "不适合", "priority": "low", "reason": "要真实账号。"}',
};
const triageReply = (body = Object.values(lines).join("\n"), order = "CYC-3 CYC-1"): string =>
  `Thinking...\n<triage>\ndraft\n</triage>\nFinal:\n<triage>\n${body}\n</triage>\n<order>\n${order}\n</order>`;
const findingsOf = (text: string): string => {
  const result = checkTriage(parseTriage(text), keys);
  return result.ok ? "" : result.findings.join("\n");
};

test("a complete triage reply is read into categories, priorities, reasons, questions and order", () => {
  const result = checkTriage(parseTriage(triageReply()), keys);
  expect(result).toEqual({
    ok: true,
    triage: {
      categories: { "CYC-1": "能做", "CYC-2": "要问", "CYC-3": "要拆", "CYC-4": "不适合" },
      priorities: { "CYC-1": "high", "CYC-2": "medium", "CYC-3": "low", "CYC-4": "low" },
      reasons: {
        "CYC-1": "范围清楚。",
        "CYC-2": "两种读法。",
        "CYC-3": "两块。",
        "CYC-4": "要真实账号。",
      },
      questions: { "CYC-2": ["是 A 还是 B？"] },
      order: ["CYC-3", "CYC-1"],
    },
  });
  // Commas, new lines or a numbered list in the order read the same; so do fences around the lines.
  expect(findingsOf(triageReply(undefined, "CYC-3,\nCYC-1"))).toBe("");
  expect(findingsOf(triageReply(undefined, "1. CYC-3\n2. CYC-1"))).toBe("");
  const fenced = `\`\`\`json\n${Object.values(lines).join("\n")}\n\`\`\``;
  expect(findingsOf(triageReply(fenced))).toBe("");
});

test("an empty order is fine when nothing is 能做 or 要拆", () => {
  const body = [lines[2], lines[4]].join("\n");
  const result = checkTriage(parseTriage(triageReply(body, "")), ["CYC-2", "CYC-4"]);
  expect(result.ok && result.triage.order).toEqual([]);
});

test("missing blocks are findings", () => {
  expect(findingsOf("nothing")).toBe(
    "There is no <triage>...</triage> block.\nThere is no <order>...</order> block. Give it even when nothing is to be shaped, empty.",
  );
});

test("a missing, repeated or unknown candidate line is a finding", () => {
  expect(findingsOf(triageReply([lines[1], lines[2], lines[3]].join("\n")))).toBe(
    "There is no line for 「CYC-4」; give every candidate exactly one.",
  );
  expect(findingsOf(triageReply([...Object.values(lines), lines[1]].join("\n")))).toBe(
    "CYC-1 has more than one line; give each candidate exactly one.",
  );
  const unknown = lines[1].replace("CYC-1", "CYC-9");
  expect(findingsOf(triageReply([...Object.values(lines), unknown].join("\n")))).toBe(
    "Line 5 of <triage> is for CYC-9, which is not a candidate.",
  );
  const text = findingsOf(
    triageReply(
      [lines[2], lines[3], lines[4], "CYC-1 能做 high", '{"category": "能做"}'].join("\n"),
    ),
  );
  expect(text).toContain("Line 4 of <triage> is not one JSON object: CYC-1 能做 high");
  expect(text).toContain('Line 5 of <triage> has no "key".');
  expect(text).toContain("There is no line for 「CYC-1」");
});

test("an illegal category or priority, or a missing or multi-line reason, is a finding", () => {
  const swap = (from: string, to: string) =>
    findingsOf(triageReply(Object.values(lines).join("\n").replace(from, to), "CYC-3"));
  expect(swap('"category": "能做"', '"category": "可以做"')).toBe(
    'CYC-1: "category" is "可以做"; it must be one of 能做, 要问, 要拆, 不适合.',
  );
  expect(swap('"priority": "high"', '"priority": "p1"')).toContain(
    'CYC-1: "priority" is "p1"; it must be one of urgent, high, medium, low.',
  );
  expect(swap(', "priority": "high"', "")).toContain('CYC-1: "priority" is null');
  expect(swap('"reason": "范围清楚。"', '"reason": " "')).toContain('CYC-1 has no "reason".');
  expect(swap('"reason": "范围清楚。"', '"reason": "一。\\n二。"')).toContain(
    'CYC-1: "reason" must be one sentence on one line.',
  );
});

test("要问 without questions is a finding", () => {
  for (const questions of [
    ', "questions": []',
    "",
    ', "questions": "是 A？"',
    ', "questions": ["", "x"]',
  ]) {
    const body = Object.values(lines)
      .join("\n")
      .replace(', "questions": ["是 A 还是 B？"]', questions);
    expect(findingsOf(triageReply(body))).toBe(
      'CYC-2 is 要问 but has no "questions": give a list of the questions, each non-empty.',
    );
  }
});

test("an order with a non-candidate, a repeat, a 要问 or 不适合, or a 能做 left out, is a finding", () => {
  expect(findingsOf(triageReply(undefined, "CYC-3 CYC-1 CYC-9"))).toBe(
    "<order> lists CYC-9, which is not a candidate.",
  );
  expect(findingsOf(triageReply(undefined, "CYC-3 CYC-1 CYC-3"))).toBe(
    "<order> lists CYC-3 more than once.",
  );
  expect(findingsOf(triageReply(undefined, "CYC-3 CYC-1 CYC-2 CYC-4"))).toBe(
    "<order> lists CYC-2, which is 要问; list only 能做 and 要拆.\n<order> lists CYC-4, which is 不适合; list only 能做 and 要拆.",
  );
  expect(findingsOf(triageReply(undefined, "CYC-1"))).toBe(
    "<order> leaves out 「CYC-3」; list every 能做 and 要拆 candidate.",
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Shaping

const featureBody = (
  criteria = "1. 开关可用。验证：`bun test ./cloud/loop/test/planning.test.ts`\n2. 门禁通过。验证：`bun run check`",
): string => `Loop 在空闲时整理 Backlog。做完后待批准里有可以批的工单。

## 背景与证据
x

## 范围
x

## 非目标
x

## 涉及面
x

## 验收标准

${criteria}
`;
const bugBody = `设置页打开时闪一下。修好后不再闪。\n\n${fullBug}`;
const epicBody = "把 Backlog 整理成可批准的工单。\n\n## 目标\nx\n\n## 完成标准\nx\n";

const files = new Set([
  "cloud/loop/test/planning.test.ts",
  "cloud/loop/test",
  "apps/desktop/test",
  "package.json",
]);
const shapeRules: ShapeRules = {
  ...rules,
  maxSplit: 3,
  exists: (path) => files.has(path),
  suites: ["node", "adapter", "backend", "package", "web"],
};
const original = item(7, { parentId: 100, typeId: FEATURE });
const standalone = item(7, { parentId: null, typeId: FEATURE });

const rewrite = (
  title = "Loop 在空闲时整理 Backlog",
  body = featureBody(),
  notes = "补了验收标准。",
) => `<title>${title}</title>\n<description>\n${body}\n</description>\n<notes>\n${notes}\n</notes>`;
const part = (title: string, body = featureBody(), type = "Feature") =>
  `<part type="${type}" title="${title}">\n${body}\n</part>`;
const split = (parts: string[], extra = "") =>
  `<split>\n${parts.join("\n")}\n</split>\n${extra}<notes>\n拆成两张。\n</notes>`;
const epic = (title = "规划 Loop：整理 Backlog", body = epicBody) =>
  `<epic title="${title}">\n${body}\n</epic>\n`;
const shape = (text: string, on: Issue = original) => checkShape(parseShape(text), on, shapeRules);
const shapeText = (text: string, on: Issue = original) => shape(text, on).join("\n");

test("a rewrite is read and passes", () => {
  const output = parseShape(`draft <title>old</title>\n${rewrite()}`);
  expect(shapeKind(output)).toBe("rewrite");
  expect(output.title).toBe("Loop 在空闲时整理 Backlog");
  expect(output.description).toBe(featureBody().trim());
  expect(output.notes).toBe("补了验收标准。");
  expect(checkShape(output, original, shapeRules)).toEqual([]);
  // A Bug is judged by the Bug sections.
  expect(shape(rewrite("设置页打开时不再闪烁", bugBody), item(8, { typeId: BUG }))).toEqual([]);
});

test("a split under a parent is read and passes; the first part keeps the original's type", () => {
  const text = split([part("Loop 整理 Backlog"), part("设置页不再闪烁", bugBody, "Bug")]);
  const output = parseShape(text);
  expect(shapeKind(output)).toBe("split");
  expect(output.split?.map((p) => [p.type, p.title])).toEqual([
    ["Feature", "Loop 整理 Backlog"],
    ["Bug", "设置页不再闪烁"],
  ]);
  expect(output.epic).toBeNull();
  expect(checkShape(output, original, shapeRules)).toEqual([]);
  expect(shapeText(split([part("A 功能", bugBody, "Bug"), part("B 功能")]))).toBe(
    'Part 1 ("A 功能") is a Bug, but it replaces CYC-7, which is a Feature; keep its type.',
  );
});

test("a split of a work item with no parent needs an Epic, which is not held to a Feature's preflight", () => {
  const text = split([part("A 功能", bugBody, "Bug"), part("B 功能")], epic());
  const output = parseShape(text);
  expect(output.epic).toEqual({ title: "规划 Loop：整理 Backlog", description: epicBody.trim() });
  // Every part is new, so the first may change type.
  expect(checkShape(output, standalone, shapeRules)).toEqual([]);
  expect(shapeText(split([part("A 功能"), part("B 功能")]), standalone)).toBe(
    'CYC-7 has no parent, so a split turns it into an Epic: give <epic title="...">, its body as an Epic.',
  );
  expect(shapeText(split([part("A 功能"), part("B 功能")], epic()), original)).toBe(
    "CYC-7 already has a parent: leave out <epic>; the first part replaces CYC-7 and the others are its siblings.",
  );
  const bad = shapeText(
    split([part("A 功能"), part("B 功能")], epic("Epic：整理", "## 目标\nx")),
    standalone,
  );
  expect(bad).toContain("The epic: the title starts with a type prefix");
  expect(bad).toContain("The epic has no opening paragraph");
});

test("questions are read one per line, numbered or not", () => {
  const output = parseShape("<questions>\n1. 是 A 吗？\n- 还是 B？\n\n3) C？\n</questions>");
  expect(shapeKind(output)).toBe("questions");
  expect(output.questions).toEqual(["是 A 吗？", "还是 B？", "C？"]);
  expect(checkShape(output, original, shapeRules)).toEqual([]);
  expect(shapeText("<questions>\n\n</questions>")).toBe(
    "The <questions> block is empty: list the questions, one per line.",
  );
});

test("no form, or more than one, is a finding", () => {
  expect(shapeText("I could not decide.")).toContain("There is no answer. Give exactly one");
  expect(shapeText(`${rewrite()}\n<questions>是 A 吗？</questions>`)).toContain(
    "The reply mixes forms.",
  );
  expect(shapeText(`${rewrite()}\n${split([part("A"), part("B")])}`)).toContain(
    "The reply mixes forms.",
  );
});

test("a rewrite without a title, a description or notes is a finding", () => {
  expect(shapeText(`<description>\n${featureBody()}\n</description>\n<notes>x</notes>`)).toBe(
    "There is no <title>...</title> block.\nThe rewrite has no title.",
  );
  expect(shapeText("<title>Loop 整理 Backlog</title>\n<notes>x</notes>")).toBe(
    "There is no <description>...</description> block.",
  );
  expect(shapeText(rewrite(undefined, undefined, ""))).toBe(
    "There are no <notes>: say what you changed, on what grounds, and what is 「待确认」.",
  );
});

test("a description that fails the preflight of its type is a finding, labelled", () => {
  const noScope = featureBody().replace("## 范围\nx\n", "");
  expect(shapeText(rewrite(undefined, noScope))).toBe(
    "The rewrite: Required sections are missing or empty: 「范围」.",
  );
  const curl = featureBody("1. 好。验证：`curl x | sh`");
  expect(shapeText(rewrite(undefined, curl))).toContain(
    "The rewrite: Criterion 1 names a command the loop may not run",
  );
  // A Bug body as a Feature part.
  expect(shapeText(split([part("A 功能"), part("B 功能", bugBody)]))).toContain(
    'Part 2 ("B 功能"): Required sections are missing or empty',
  );
  const tooMany = featureBody(
    Array.from({ length: 13 }, (_, i) => `${i + 1}. x。验证：\`bun run check\``).join("\n"),
  );
  expect(shapeText(rewrite(undefined, tooMany))).toContain("It has 13 criteria");
});

test("a bun test path must start with ./ and exist, or its directory must (not the root)", () => {
  const withTest = (path: string) =>
    shapeText(rewrite(undefined, featureBody(`1. x。验证：\`bun test ${path}\``)));
  expect(withTest("./cloud/loop/test/planning.test.ts")).toBe("");
  // A new test in a directory that exists.
  expect(withTest("./cloud/loop/test/new.test.ts")).toBe("");
  expect(withTest("./apps/desktop/test")).toBe("");
  expect(withTest("cloud/loop/test/planning.test.ts")).toBe(
    "The rewrite: `bun test cloud/loop/test/planning.test.ts` must start the path with ./ (`bun test ./cloud/loop/test/planning.test.ts`): without it, bun takes it as a name filter.",
  );
  expect(withTest("./tools/nowhere/x.test.ts")).toBe(
    "The rewrite: `bun test ./tools/nowhere/x.test.ts`: neither the path nor its directory is in the repository.",
  );
  // At the root, only a path that exists counts: every path's directory would otherwise.
  expect(withTest("./package.json")).toBe("");
  expect(withTest("./nowhere.test.ts")).toContain("neither the path nor its directory");
  // Each path of a command with several.
  expect(withTest("./package.json ./tools/nowhere/x.test.ts")).toContain(
    "`bun test ./tools/nowhere/x.test.ts`: neither",
  );
});

test("an integration suite must match one, as the runner matches names", () => {
  const withSuite = (suite: string) =>
    shapeText(rewrite(undefined, featureBody(`1. x。验证：\`bun run test:integration ${suite}\``)));
  expect(withSuite("")).toBe("");
  expect(withSuite("web")).toBe("");
  // The runner takes every suite whose name has the word in it.
  expect(withSuite("back")).toBe("");
  expect(withSuite("--strict")).toBe(
    "The rewrite: `bun run test:integration --strict` takes a suite name, not an option; the loop adds --strict itself.",
  );
  expect(withSuite("e2e")).toBe(
    "The rewrite: `bun run test:integration e2e` matches no suite; the suites are node, adapter, backend, package, web.",
  );
});

test("integrationSuites reads the runner's list", () => {
  const names = integrationSuites();
  expect(names).toContain("web");
  expect(names).toContain("backend");
});

test("every description needs an opening paragraph before its first heading", () => {
  expect(openingParagraph(featureBody())).toBe(
    "Loop 在空闲时整理 Backlog。做完后待批准里有可以批的工单。",
  );
  expect(openingParagraph("\n\n## 范围\nx")).toBe("");
  const noOpening = featureBody().replace(/^.*\n\n/, "");
  expect(shapeText(rewrite(undefined, noOpening))).toBe(
    "The rewrite has no opening paragraph: start with two or three sentences for a person (what, why, what done looks like), before the first heading.",
  );
  expect(shapeText(split([part("A 功能"), part("B 功能", noOpening)]))).toContain(
    'Part 2 ("B 功能") has no opening paragraph',
  );
});

test("a title with a type prefix or a work item number is a finding", () => {
  for (const title of [
    "feat(loop): 整理 Backlog",
    "fix: 设置页闪烁",
    "Epic：规划 Loop",
    "调研：Backlog 能不能自动整理",
    "Step 1.1：整理",
    "[Bug] 设置页闪烁",
    "【功能】整理 Backlog",
  ]) {
    expect(shapeText(rewrite(title))).toBe(
      "The rewrite: the title starts with a type prefix; the type is a field, write the action and its object.",
    );
  }
  for (const title of [
    "CYC-123 整理 Backlog",
    "整理 Backlog（接 CYCL-57）",
    "整理 Backlog cyc-9",
  ]) {
    expect(shapeText(rewrite(title))).toBe(
      "The rewrite: the title has a work item number; leave it out.",
    );
  }
  // Words that only look near one.
  for (const title of ["修复 UTF-8 文件名", "Fixture 整理", "设计 Loop 页面的 feature flag"]) {
    expect(shapeText(rewrite(title))).toBe("");
  }
  expect(shapeText(split([part(""), part("B 功能")]))).toContain("Part 1 has no title.");
});

test("a description over 20000 characters is a finding", () => {
  const long = `${featureBody()}\n${"字".repeat(MAX_BODY)}`;
  expect(shapeText(rewrite(undefined, long))).toContain(
    `The rewrite is ${[...long.trim()].length} characters long; it must be at most ${MAX_BODY}.`,
  );
});

test("a split of one part, or more than maxSplit, or with a part that is not a Feature or Bug, is a finding", () => {
  expect(shapeText(split([part("A 功能")]))).toBe(
    "The split has 1 part(s); it must have 2 to 3. With one, give a rewrite instead.",
  );
  expect(shapeText(split(["A", "B", "C", "D"].map((t) => part(`${t} 功能`))))).toBe(
    "The split has 4 part(s); it must have 2 to 3. With one, give a rewrite instead.",
  );
  expect(shapeText(split([part("A 功能"), part("B 功能", epicBody, "Epic")]))).toBe(
    'Part 2 ("B 功能") has no type="Feature" or type="Bug".',
  );
  expect(shapeText("<split>\n</split>\n<notes>x</notes>")).toContain("The split has 0 part(s)");
  expect(
    shapeText(split([part("A 功能"), part("B 功能")]).replace(/<notes>[\s\S]*<\/notes>/, "")),
  ).toBe("There are no <notes>: say what you changed, on what grounds, and what is 「待确认」.");
});

// ---------------------------------------------------------------------------------------------------------------
// The work item rules and the prompts

const skillPath = join(import.meta.dir, "../../../.claude/skills/cycle-workflow/SKILL.md");

test("workflowRules takes 标题, 正文 (with 验收标准) and 拆分一张工单 from the skill as written", async () => {
  const skill = await readFile(skillPath, "utf8");
  const text = workflowRules(skill);
  expect(text.startsWith("## 标题")).toBe(true);
  expect(text).toContain("## 正文");
  expect(text).toContain("### 验收标准");
  expect(text).toContain("### 拆分一张工单");
  expect(text).not.toContain("## 类型\n");
  expect(text).not.toContain("## 标签与优先级");
  expect(() => workflowRules(skill.replace("### 拆分一张工单", "### 拆"))).toThrow(
    "the work item rules have no section 「拆分一张工单」",
  );
});

test("workflowRules carries the Initiative / Level-1 / Level-2 Task Graph boundaries and Plan fenced json graph spec (CYC-511)", async () => {
  const skill = await readFile(skillPath, "utf8");
  const text = workflowRules(skill);
  for (const keyword of [
    "Initiative",
    "一级业务单",
    "二级 Task Graph",
    "1 单 = 1 分支 = 1 个完整 PR",
    "## 执行图",
    "## Task Graph",
    "fenced `json`",
    "dependsOn",
    "filesHint",
    "verify",
    "### 拆分一张工单",
    "超过单 PR 承载量",
    "独立排期上线",
  ]) {
    expect(text).toContain(keyword);
  }
});

test("triage brief only splits beyond 1-PR capacity or independent shipping and puts 1-PR full-stack work under 能做 (CYC-511)", () => {
  const brief = triageBrief({
    candidates: [summary("CYC-1")],
    board: { todo: [], inProgress: [], pending: [], epics: [] },
    bodiesDir: "/state/plans/x/bodies",
    readRoots: ["/state/plans/x/bodies"],
    maxCriteria: 8,
  });
  expect(brief).toContain(
    "full-stack or cross-module requirement that ships cleanly in 1 PR belongs under 能做",
  );
  expect(brief).toContain("Level-2 Task Graph");
  expect(brief).toContain(
    "ONLY when it exceeds what one PR can reasonably carry OR consists of parts that can be scheduled and shipped independently",
  );
  expect(brief).not.toContain(
    "more than one session's work, or its criteria belong to different parts of the product",
  );
});

test("standalone shape brief keeps 1-PR work as one Level-1 item and requires split parts to be independently shippable Level-1 items (CYC-511)", () => {
  const work = item(7, { description: "ORIGINAL BODY", parentId: null });
  const top = shapeBrief(work, {
    ...shapeInput,
    parent: null,
    format: { key: "CYC-7", type: "Feature", standalone: true, maxSplit: 3 },
  });
  expect(top).toContain(
    "Keep it as one Level-1 work item (Form 1 rewrite) whenever it can ship in 1 PR",
  );
  expect(top).toContain("do not turn a 1-PR requirement into an Epic of technical sub-tickets");
  expect(top).toContain("independently shippable Level-1 work item");
  expect(top).not.toContain("one session's work");
});

const summary = (key: string): CandidateSummary => ({
  key,
  title: `title of ${key}`,
  type: "Feature",
  priority: null,
  parent: "CYC-381 Loop",
  links: ["blocks CYC-12"],
  opening: `opening of ${key}`,
  length: 120,
});

test("the triage brief lists every candidate, the board, the bodies directory and the commands", () => {
  const brief = triageBrief({
    candidates: [summary("CYC-1"), summary("CYC-2")],
    board: {
      todo: ["CYC-5 todo item"],
      inProgress: [],
      pending: ["CYC-6 pending item"],
      epics: [{ key: "CYC-381", title: "Loop", opening: "Loop 的总目标。" }],
    },
    bodiesDir: "/state/plans/x/bodies",
    readRoots: ["/state/plans/x/bodies"],
    maxCriteria: 8,
  });
  for (const text of [
    "### CYC-1 — Feature, no priority: title of CYC-1",
    "opening of CYC-2",
    "blocks CYC-12",
    "/state/plans/x/bodies",
    "CYC-5 todo item",
    "CYC-6 pending item",
    "CYC-381 Loop: Loop 的总目标。",
    ALLOWED_COMMANDS,
    "`bun test ./",
    "at most 8 items",
    UI_CRITERIA_GUIDE,
    "<triage>",
    "<order>",
  ])
    expect(brief).toContain(text);
  const empty = triageBrief({
    candidates: [],
    board: { todo: [], inProgress: [], pending: [], epics: [] },
    bodiesDir: "/b",
    readRoots: [],
    maxCriteria: 8,
  });
  expect(empty).toContain("Todo (approved, waiting to be built):\n(none)");
  const fix = triageFixBrief(2, ["There is no line for 「CYC-4」."]);
  expect(fix).toContain("fix round 2");
  expect(fix).toContain("- There is no line for 「CYC-4」.");
  expect(fix).toContain("<order>");
});

const shapeInput = {
  comments: [comment("2026-11-25T00:00:00.000Z")],
  parent: { key: "CYC-381", title: "Loop", description: "Loop 的总目标。" },
  related: ["blocks CYC-12 sibling"],
  template: "TEMPLATE TEXT",
  triage: { category: "能做" as const, reason: "范围清楚。" },
  rules: "RULES TEXT",
  maxCriteria: 6,
  readRoots: ["/state/plans/x/bodies"],
};

test("the shape brief carries the work item, its context, the rules and the form for its place", () => {
  const work = item(7, { description: "ORIGINAL BODY", parentId: 100 });
  const brief = shapeBrief(work, {
    ...shapeInput,
    format: { key: "CYC-7", type: "Feature", standalone: false, maxSplit: 3 },
  });
  for (const text of [
    "CYC-7: work item 7",
    "ORIGINAL BODY",
    "Its parent, CYC-381: Loop",
    "blocks CYC-12 sibling",
    "能做: 范围清楚。",
    "TEMPLATE TEXT",
    "RULES TEXT",
    ALLOWED_COMMANDS,
    "`bun test ./",
    "at most 6 items",
    UI_CRITERIA_GUIDE,
    "「待确认」",
    "合并后由人验收（不进 Loop）",
    "2 to 3 parts",
    "keeps its type (Feature)",
    "<questions>",
  ])
    expect(brief).toContain(text);
  expect(brief).not.toContain("<epic title");
  const top = shapeBrief(work, {
    ...shapeInput,
    parent: null,
    format: { key: "CYC-7", type: "Feature", standalone: true, maxSplit: 3 },
  });
  expect(top).toContain("It has no parent.");
  expect(top).toContain('<epic title="...">');
  expect(top).toContain(UI_CRITERIA_GUIDE);
  const fix = shapeFixBrief(1, "1. [major] 范围: x\n   fix: y", {
    key: "CYC-7",
    type: "Bug",
    standalone: false,
    maxSplit: 3,
  });
  expect(fix).toContain("fix round 1");
  expect(fix).toContain("1. [major] 范围: x");
  expect(fix).toContain("keeps its type (Bug)");
});

test("the shape QA brief has the original, the comments and the result, and asks for a verdict", () => {
  const work = item(7, { title: "OLD TITLE", description: "ORIGINAL BODY" });
  const output = parseShape(split([part("A 功能"), part("B 功能", bugBody, "Bug")], epic()));
  const brief = shapeQaBrief(work, { ...shapeInput, output });
  for (const text of [
    "OLD TITLE",
    "ORIGINAL BODY",
    "2026-11-25T00:00:00.000Z",
    "The work item becomes an Epic: 规划 Loop：整理 Backlog",
    "Part 2: Bug — B 功能",
    "拆成两张。",
    "RULES TEXT",
    "「待确认」",
    "合并后由人验收（不进 Loop）",
    "What I checked",
    "<verdict>",
  ])
    expect(brief).toContain(text);
  const rewritten = shapeQaBrief(work, { ...shapeInput, output: parseShape(rewrite()) });
  expect(rewritten).toContain("### Title\n\nLoop 在空闲时整理 Backlog");
  // QA's verdict is read as Dev's QA's is.
  expect(parseVerdict('<verdict>{"pass":true,"findings":[]}</verdict>')?.pass).toBe(true);
});

test("要问 with more than two questions is a finding: ask only what a person must decide", () => {
  const body = Object.values(lines)
    .join("\n")
    .replace('"questions": ["是 A 还是 B？"]', '"questions": ["一？", "二？", "三？"]');
  expect(findingsOf(triageReply(body))).toBe(
    "CYC-2 is 要问 with 3 questions; ask at most 2, the ones only a person can decide.",
  );
});

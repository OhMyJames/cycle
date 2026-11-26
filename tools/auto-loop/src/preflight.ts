import { type CriterionSpec, listUnder, parseCriteria, verifyArgv } from "./criteria.ts";
import type { Config, Issue } from "./types.ts";

export type Preflight =
  | { ok: true; kind: "dev"; specs: CriterionSpec[] }
  | { ok: true; kind: "research"; questions: string[] }
  | { ok: false; reasons: string[] };

/** `research` is optional so that a caller that only knows Feature and Bug (such as scout) still type-checks. */
export type PreflightConfig = Pick<Config, "maxCriteria" | "featureTypeId" | "bugTypeId"> &
  Partial<Pick<Config, "research">>;

/** The verify commands a criterion may name (`parseVerify`), as a person or a session reads them. */
export const ALLOWED_COMMANDS =
  "bun run check, bun run test:browser, bun run test:integration [suite], bun test <path>";

/**
 * How to write a user-interface behaviour as an acceptance command, for whoever writes the work item and for the
 * planning loop. Only the commands in `ALLOWED_COMMANDS` exist; none is added for this.
 */
export const UI_CRITERIA_GUIDE = [
  "界面现象用现有的验证命令写，三种写法：",
  "1. 整页流程（打包后的应用、浏览器里的端到端）：`bun run test:integration web`，约 8 秒。Loop 运行时会补 `--strict`，所以没 build、没 Chromium 而整个跳过的会判失败；不要自己写 `--strict`。",
  "2. 组件：`bun run test:browser`，在无界面的 Chromium 里跑，约 78 秒。",
  "3. 其他测试文件：`bun test ./路径`，如 `bun test ./apps/desktop/test/integration/web.integration.ts`。路径可以带 `./`，不能以 `/` 开头、不能含 `..`、不能带 `--` 选项。Loop 会读汇总行：通过数为 0（全部跳过）或读不出汇总行，判未通过；有通过也有跳过算通过。",
  "不能写 `test:real` 系列：没有 token 时它整个跳过、退回码是 0，不能当验收。",
].join("\n");

/** Required sections per type, as in the project's templates. 「验收标准」 is checked by the criteria rules below. */
const FEATURE_SECTIONS = ["背景与证据", "范围", "非目标", "涉及面"];
const BUG_SECTIONS = ["现象", "复现步骤", "预期与实际", "环境与版本", "严重度"];
/** 「要回答的问题」 and 「结论」 are checked by their own rules below. */
const RESEARCH_SECTIONS = ["方法与范围", "产出形式"];

const QUESTIONS = /^(#{1,6})\s*要回答的问题/;
export const CONCLUSION = "结论";
/** What a template leaves in 「结论」 until the research is done, compared with blanks and brackets taken out. */
const PLACEHOLDERS = new Set(["做完后回填", "待回填", "tbd"]);

/** Whether a heading of this name is in the description with some content under it (until the next heading of the same or a higher level). */
const hasSection = (description: string, name: string): boolean => {
  const lines = description.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s*(.*)$/.exec((lines[i] ?? "").trim());
    if (heading === null || !(heading[2] ?? "").startsWith(name)) continue;
    const level = (heading[1] ?? "").length;
    for (const line of lines.slice(i + 1)) {
      const next = /^(#{1,6})\s/.exec(line.trim());
      if (next !== null && (next[1] ?? "").length <= level) break;
      if (line.trim() !== "" && next === null) return true;
    }
  }
  return false;
};

/**
 * The first section headed `name`, as line indexes into `description.split("\n")`: the heading, and the line after
 * its last line (the next heading of the same or a higher level, or the end). Checking 「结论」 and replacing it both go
 * through this, so what is judged empty is what gets replaced.
 */
export const findSection = (
  description: string,
  name: string,
): { heading: number; end: number } | undefined => {
  const lines = description.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s*(.*)$/.exec((lines[i] ?? "").trim());
    if (heading === null || !(heading[2] ?? "").startsWith(name)) continue;
    const level = (heading[1] ?? "").length;
    let end = i + 1;
    while (end < lines.length) {
      const next = /^(#{1,6})\s/.exec((lines[end] ?? "").trim());
      if (next !== null && (next[1] ?? "").length <= level) break;
      end++;
    }
    return { heading: i, end };
  }
  return undefined;
};

/**
 * One bracketed note and nothing else, such as the template's 「（做完后回填：…）」 or 「（未完成）」: a note to the
 * person filling it in, not a conclusion. A blank line inside means more than one paragraph, which is written text.
 */
const BRACKETED_NOTE = /^[（(][^（）()]*[）)]$/;

/** Whether 「结论」 is still to be written: absent, empty, or only a placeholder. */
export const conclusionIsEmpty = (description: string): boolean => {
  const section = findSection(description, CONCLUSION);
  if (section === undefined) return true;
  const text = description
    .split("\n")
    .slice(section.heading + 1, section.end)
    .join("\n")
    .trim();
  if (BRACKETED_NOTE.test(text) && !/\n\s*\n/.test(text)) return true;
  const body = text.replace(/[\s()（）]/g, "").toLowerCase();
  return body === "" || PLACEHOLDERS.has(body);
};

const missingSections = (
  issue: Issue,
  config: Pick<Config, "featureTypeId" | "bugTypeId">,
): string[] => {
  const required =
    issue.typeId === config.featureTypeId
      ? FEATURE_SECTIONS
      : issue.typeId === config.bugTypeId
        ? BUG_SECTIONS
        : [];
  return required.filter((name) => !hasSection(issue.description, name));
};

const missingSectionsReason = (missing: string[]): string =>
  `Required sections are missing or empty: ${missing.map((n) => `「${n}」`).join(", ")}.`;

/**
 * Whether a work item is fit to be taken, decided by rules and not by a model: it must say what is wanted, every
 * criterion must name a command the loop may run, and it must not be more than one session can do. A research work
 * item has questions instead of criteria, and is judged by `researchPreflight`.
 */
export const preflight = (issue: Issue, config: PreflightConfig): Preflight => {
  if (config.research != null && issue.typeId === config.research.typeId) {
    return researchPreflight(issue, config);
  }
  const reasons: string[] = [];
  if (issue.description.trim() === "") {
    return { ok: false, reasons: ["The work item has no description."] };
  }
  const missing = missingSections(issue, config);
  if (missing.length > 0) reasons.push(missingSectionsReason(missing));
  const parsed = parseCriteria(issue.description);
  if (parsed.length === 0) {
    reasons.push("There is no list of acceptance criteria (a list under a 「验收标准」 heading).");
    return { ok: false, reasons };
  }
  if (parsed.length > config.maxCriteria) {
    reasons.push(
      `It has ${parsed.length} criteria, more than one session can finish (at most ${config.maxCriteria}). Please split it.`,
    );
  }
  const specs: CriterionSpec[] = [];
  parsed.forEach((criterion, index) => {
    const label = `Criterion ${index + 1}`;
    if (criterion.commands.length === 0) {
      reasons.push(`${label} names no command to check it. Add 「验证：\`bun test <path>\`」.`);
      return;
    }
    const argv = verifyArgv(criterion.commands);
    if (!argv.ok) {
      reasons.push(
        `${label} names a command the loop may not run: ${argv.rejected.map((c) => `\`${c}\``).join(", ")}. Allowed: ${ALLOWED_COMMANDS}.`,
      );
      return;
    }
    specs.push({ text: criterion.text, verify: argv.argv });
  });
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, kind: "dev", specs };
};

/**
 * A research work item is fit to be taken when it says what to answer (a numbered list, no more than one session can
 * answer), how and in what form, and its conclusion is not written yet: a written one means someone has already
 * answered it, and publishing would have nowhere to put the summary.
 */
export const researchPreflight = (issue: Issue, config: Pick<Config, "maxCriteria">): Preflight => {
  if (issue.description.trim() === "") {
    return { ok: false, reasons: ["The work item has no description."] };
  }
  const reasons: string[] = [];
  const items = listUnder(issue.description, QUESTIONS);
  if (items.length === 0) {
    reasons.push(
      "There is no list of questions (a numbered list under a 「要回答的问题」 heading).",
    );
  } else if (items.some((item) => !item.numbered)) {
    reasons.push("The questions under 「要回答的问题」 must be a numbered list (1. 2. 3.).");
  }
  if (items.length > config.maxCriteria) {
    reasons.push(
      `It has ${items.length} questions, more than one session can answer (at most ${config.maxCriteria}). Please split it.`,
    );
  }
  const missing = RESEARCH_SECTIONS.filter((name) => !hasSection(issue.description, name));
  if (missing.length > 0) reasons.push(missingSectionsReason(missing));
  if (!conclusionIsEmpty(issue.description)) {
    reasons.push(
      "The 「结论」 section is already written. Research is taken only while it is empty or holds 「（做完后回填）」.",
    );
  }
  return reasons.length > 0
    ? { ok: false, reasons }
    : { ok: true, kind: "research", questions: items.map((item) => item.text) };
};

/** The comment that sends a work item back, in the words a person reads in the tracker. */
export const sendBackComment = (reasons: string[]): string =>
  `自动化暂时不能领取这张工单：\n${reasons.map((reason) => `- ${reason}`).join("\n")}\n\n补充后把它放回 Todo，自动化会重新检查。`;

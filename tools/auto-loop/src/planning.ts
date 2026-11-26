// The planning node's rules (CYC-322): which Backlog work items it may look at, when a round starts, and what the
// triage and shaping sessions must hand back before anything is written. Pure: the tracker, the clock and the
// worktree reach here only as plain values or the functions passed in, so every rule can be tested without them.
// Like research (research.ts), the sessions answer in tag blocks, and a finding is phrased to be sent back to the
// session as it is.

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { suites } from "../../../scripts/integration-suites.ts";
import { parseCriteria, parseVerify } from "./criteria.ts";
import { findSection, type PreflightConfig, preflight } from "./preflight.ts";
import type { PlanMemory } from "./store.ts";
import type { Config, Issue, IssueComment, PlanningConfig, Priority } from "./types.ts";

/** What triage decides about a candidate. 能做 and 要拆 are shaped; 要问 is asked about; 不适合 is left alone. */
export const CATEGORIES = ["能做", "要问", "要拆", "不适合"] as const;
export type Category = (typeof CATEGORIES)[number];
export const PRIORITIES = [
  "urgent",
  "high",
  "medium",
  "low",
] as const satisfies readonly Priority[];

/** The categories shaping takes, in triage's order. */
const SHAPED: readonly Category[] = ["能做", "要拆"];
/** What memory says to skip until the work item changes. */
const UNFIT: Category = "不适合";

/** Characters, as a person counts them; below the tracker's 50k for a description, with room for what is added. */
export const MAX_BODY = 20_000;

// ---------------------------------------------------------------------------------------------------------------
// Hashes and fingerprints

/**
 * A description as compared for change: line endings as `\n`, no trailing blanks, no blank lines. The tracker reflows
 * blank lines on its own (around headings and lists), so a blank line is not a change a person made.
 */
const normalise = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line !== "")
    .join("\n");

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Hash of a work item's title and body, as kept in memory and when shaping begins, to see whether a person changed it. */
export const bodyHash = (title: string, description: string): string =>
  sha256(JSON.stringify([title.trim(), normalise(description)]));

/** The time of the latest comment, or null when there is none. */
export const latestCommentAt = (comments: IssueComment[]): string | null =>
  comments.reduce<string | null>(
    (latest, c) => (latest === null || c.createdAt > latest ? c.createdAt : latest),
    null,
  );

/**
 * One string that changes when the Backlog does in a way that matters to planning: a work item added or gone, its
 * title or body edited, a label put on or taken off (such as 待回答), or a new comment. `latestComments` is by key;
 * a key not in it counts as having no comment. Taken after a round has written everything, so the round's own
 * comments and labels are not a change the next round sees.
 */
export const backlogFingerprint = (
  backlog: Issue[],
  latestComments: Record<string, string | null>,
): string =>
  sha256(
    JSON.stringify(
      backlog
        .map((i) => [
          i.key,
          bodyHash(i.title, i.description),
          [...i.labelIds].sort((a, b) => a - b),
          latestComments[i.key] ?? null,
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  );

// ---------------------------------------------------------------------------------------------------------------
// Candidates and when to plan

export type CandidateRules = Pick<Config, "autoLabelId" | "featureTypeId" | "bugTypeId"> & {
  planning: Pick<PlanningConfig, "labels" | "backlogColumn">;
};

/**
 * The Backlog work items triage may look at: Feature and Bug leaves without `完整流程`, `auto`, 待批准, 待回答 or
 * Loop 跳过. One that memory says was 不适合, or whose shaping stopped, is left out while its title, body and latest
 * comment are as they were then. `latestComments` needs only the keys memory has; a key not in it counts as changed,
 * so an unread thread never hides a work item.
 */
export const candidates = (
  backlog: Issue[],
  rules: CandidateRules,
  memory: PlanMemory,
  latestComments: Record<string, string | null>,
): Issue[] => {
  const { labels, backlogColumn } = rules.planning;
  const excluded = [
    rules.autoLabelId,
    labels.pending,
    labels.awaitingAnswer,
    labels.skip,
    labels.fullProcess,
  ].filter((id): id is number => id !== null);
  return backlog.filter((issue) => {
    if (issue.columnId !== backlogColumn) return false;
    if (issue.typeId !== rules.featureTypeId && issue.typeId !== rules.bugTypeId) return false;
    // Null is a reply that did not say: not known to be a leaf.
    if (issue.subtaskCount !== 0) return false;
    if (issue.labelIds.some((id) => excluded.includes(id))) return false;
    const seen = memory[issue.key];
    if (seen === undefined || (seen.category !== UNFIT && !seen.stopped)) return true;
    const unchanged =
      seen.bodyHash === bodyHash(issue.title, issue.description) &&
      issue.key in latestComments &&
      latestComments[issue.key] === seen.lastCommentAt;
    return !unchanged;
  });
};

export type PlanState = {
  /** A worker is free to take a round. */
  freeWorker: boolean;
  /** Todo has a work item the loop could take: approved work comes first. */
  todoTakeable: boolean;
  /** Backlog work items carrying 待批准. */
  pending: number;
  maxPending: number;
  /** A round has started and not ended (only one at a time). */
  roundRunning: boolean;
  /** When the last round ended, or null when there has been none. */
  lastEndedAt: Date | null;
  intervalMinutes: number;
  now: Date;
  /** The Backlog changed since the last round ended (see `backlogFingerprint`). */
  backlogChanged: boolean;
};

/** Whether to start a planning round now: only when every condition holds. */
export const shouldPlan = (state: PlanState): boolean => {
  if (!state.freeWorker || state.todoTakeable) return false;
  if (state.pending >= state.maxPending) return false;
  if (state.roundRunning) return false;
  if (state.lastEndedAt === null || state.backlogChanged) return true;
  return state.now.getTime() - state.lastEndedAt.getTime() >= state.intervalMinutes * 60_000;
};

// ---------------------------------------------------------------------------------------------------------------
// Reading tag blocks

const last = (text: string, tag: string): string | null => {
  const found = Array.from(text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))).at(-1);
  return found === undefined ? null : (found[1] as string).trim();
};

const attribute = (attributes: string, name: string): string | undefined =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attributes)?.[1];

/** The first paragraph of a description, before its first heading: what a person reads first. Empty when there is none. */
export const openingParagraph = (description: string): string => {
  const lines = description.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() !== "");
  if (start === -1 || /^#{1,6}\s/.test((lines[start] as string).trim())) return "";
  const end = lines.findIndex(
    (line, i) => i > start && (line.trim() === "" || /^#{1,6}\s/.test(line.trim())),
  );
  return lines
    .slice(start, end === -1 ? undefined : end)
    .join("\n")
    .trim();
};

// ---------------------------------------------------------------------------------------------------------------
// Triage

/**
 * The triage reply as written: each line of the last `<triage>` block (one JSON object per candidate, or null where
 * the line is not one), and the keys in the last `<order>` block. A block that is missing is null. Code fence lines
 * around the JSON, and numbers or commas around the keys, are what a model often adds: they are read past, not sent
 * back.
 */
export type TriageReply = {
  lines: { text: string; value: Record<string, unknown> | null }[] | null;
  order: string[] | null;
};

export const parseTriage = (text: string): TriageReply => {
  const block = last(text, "triage");
  const order = last(text, "order");
  return {
    lines:
      block === null
        ? null
        : block
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "" && !line.startsWith("```"))
            .map((line) => {
              try {
                const value: unknown = JSON.parse(line);
                return {
                  text: line,
                  value:
                    typeof value === "object" && value !== null && !Array.isArray(value)
                      ? (value as Record<string, unknown>)
                      : null,
                };
              } catch {
                return { text: line, value: null };
              }
            }),
    order:
      order === null ? null : Array.from(order.matchAll(/[A-Za-z][A-Za-z0-9]*-\d+/g), (m) => m[0]),
  };
};

/** Triage once it passed the checks. `categories`, `priorities` and `order` are as a round's record keeps them. */
export type Triage = {
  categories: Record<string, Category>;
  priorities: Record<string, Priority>;
  reasons: Record<string, string>;
  /** Only for 要问. */
  questions: Record<string, string[]>;
  /** The 能做 and 要拆 candidates, each once, in the order to shape them. */
  order: string[];
};

const listOf = (keys: string[]): string => keys.map((k) => `「${k}」`).join(", ");
const short = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}…` : text);

/**
 * Whether the triage reply is complete and legal for these candidates: what is wrong, in words sent back to the
 * session as they are, or the triage to act on.
 */
export const checkTriage = (
  reply: TriageReply,
  candidateKeys: string[],
): { ok: true; triage: Triage } | { ok: false; findings: string[] } => {
  const findings: string[] = [];
  const triage: Triage = { categories: {}, priorities: {}, reasons: {}, questions: {}, order: [] };
  if (reply.lines === null) findings.push("There is no <triage>...</triage> block.");
  const seen = new Set<string>();
  for (const [index, { text, value }] of (reply.lines ?? []).entries()) {
    const at = `Line ${index + 1} of <triage>`;
    if (value === null) {
      findings.push(`${at} is not one JSON object: ${short(text)}`);
      continue;
    }
    const key = value.key;
    if (typeof key !== "string" || key.trim() === "") {
      findings.push(`${at} has no "key".`);
      continue;
    }
    if (!candidateKeys.includes(key)) {
      findings.push(`${at} is for ${key}, which is not a candidate.`);
      continue;
    }
    if (seen.has(key)) {
      findings.push(`${key} has more than one line; give each candidate exactly one.`);
      continue;
    }
    seen.add(key);
    const { category, priority, reason, questions } = value;
    if (!CATEGORIES.includes(category as Category)) {
      findings.push(
        `${key}: "category" is ${JSON.stringify(category ?? null)}; it must be one of ${CATEGORIES.join(", ")}.`,
      );
    } else triage.categories[key] = category as Category;
    if (!PRIORITIES.includes(priority as Priority)) {
      findings.push(
        `${key}: "priority" is ${JSON.stringify(priority ?? null)}; it must be one of ${PRIORITIES.join(", ")}.`,
      );
    } else triage.priorities[key] = priority as Priority;
    if (typeof reason !== "string" || reason.trim() === "") {
      findings.push(`${key} has no "reason".`);
    } else if (reason.includes("\n")) {
      findings.push(`${key}: "reason" must be one sentence on one line.`);
    } else triage.reasons[key] = reason.trim();
    if (category === "要问") {
      const asked = Array.isArray(questions)
        ? questions.filter((q): q is string => typeof q === "string" && q.trim() !== "")
        : [];
      if (asked.length === 0 || asked.length !== (questions as unknown[]).length) {
        findings.push(
          `${key} is 要问 but has no "questions": give a list of the questions, each non-empty.`,
        );
      } else triage.questions[key] = asked.map((q) => q.trim());
    }
  }
  const missing = candidateKeys.filter((key) => !seen.has(key));
  if (reply.lines !== null && missing.length > 0) {
    findings.push(`There is no line for ${listOf(missing)}; give every candidate exactly one.`);
  }
  if (reply.order === null) {
    findings.push(
      "There is no <order>...</order> block. Give it even when nothing is to be shaped, empty.",
    );
  } else {
    const ordered = new Set<string>();
    for (const key of reply.order) {
      if (!candidateKeys.includes(key)) {
        findings.push(`<order> lists ${key}, which is not a candidate.`);
      } else if (ordered.has(key)) {
        findings.push(`<order> lists ${key} more than once.`);
      } else {
        const category = triage.categories[key];
        if (category !== undefined && !SHAPED.includes(category)) {
          findings.push(`<order> lists ${key}, which is ${category}; list only 能做 and 要拆.`);
        }
        ordered.add(key);
      }
    }
    const left = Object.entries(triage.categories)
      .filter(([key, category]) => SHAPED.includes(category) && !ordered.has(key))
      .map(([key]) => key);
    if (left.length > 0) {
      findings.push(`<order> leaves out ${listOf(left)}; list every 能做 and 要拆 candidate.`);
    }
    triage.order = [...ordered];
  }
  return findings.length > 0 ? { ok: false, findings } : { ok: true, triage };
};

// ---------------------------------------------------------------------------------------------------------------
// Shaping

export type PartType = "Feature" | "Bug";

export type ShapePart = {
  /** Null when `type` is missing or not Feature or Bug: a finding, not a part to drop. */
  type: PartType | null;
  title: string;
  description: string;
};

/**
 * What a shaping session handed back, block by block; a block that is missing is null. Exactly one of three forms
 * is legal: a rewrite (`<title>`, `<description>`, `<notes>`), a split (`<split>` of `<part>`s, `<epic>` when the
 * work item has no parent, `<notes>`), or `<questions>`.
 */
export type ShapeOutput = {
  title: string | null;
  description: string | null;
  notes: string | null;
  split: ShapePart[] | null;
  epic: { title: string; description: string } | null;
  questions: string[] | null;
};

/** The last of each block. Parts are read from the last `<split>` only: an earlier one is a draft it replaced. */
export const parseShape = (text: string): ShapeOutput => {
  const split = last(text, "split");
  const epic = Array.from(text.matchAll(/<epic\b([^>]*)>([\s\S]*?)<\/epic>/g)).at(-1);
  const questions = last(text, "questions");
  return {
    title: last(text, "title"),
    description: last(text, "description"),
    notes: last(text, "notes"),
    split:
      split === null
        ? null
        : Array.from(split.matchAll(/<part\b([^>]*)>([\s\S]*?)<\/part>/g), (m) => {
            const attributes = m[1] as string;
            const type = attribute(attributes, "type");
            return {
              type: type === "Feature" || type === "Bug" ? type : null,
              title: (attribute(attributes, "title") ?? "").trim(),
              description: (m[2] as string).trim(),
            };
          }),
    epic:
      epic === undefined
        ? null
        : {
            title: (attribute(epic[1] as string, "title") ?? "").trim(),
            description: (epic[2] as string).trim(),
          },
    questions:
      questions === null
        ? null
        : questions
            .split("\n")
            .map((line) => line.replace(/^\s*(?:\d+[.)、]|[-*+])\s*/, "").trim())
            .filter((line) => line !== ""),
  };
};

/** Which form the reply took, or null when it took none or more than one. */
export const shapeKind = (output: ShapeOutput): "rewrite" | "split" | "questions" | null => {
  const forms = [
    output.title !== null || output.description !== null ? "rewrite" : null,
    output.split !== null || output.epic !== null ? "split" : null,
    output.questions !== null ? "questions" : null,
  ].filter((form) => form !== null);
  return forms.length === 1 ? (forms[0] as "rewrite" | "split" | "questions") : null;
};

export type ShapeRules = Pick<Config, "maxCriteria" | "featureTypeId" | "bugTypeId"> & {
  maxSplit: number;
  /** Whether a path, relative to the worktree's root and without `./`, is a file or directory there. */
  exists: (path: string) => boolean;
  /** The integration suites' names (`scripts/integration-suites.ts`, see `integrationSuites`). */
  suites: string[];
};

/** The integration suites' names, as `bun run test:integration <name>` matches them. */
export const integrationSuites = (): string[] => suites.map((s) => s.name);

const TYPE_PREFIX = [
  /^\s*(?:epic|feat|feature|fix|bug|bugfix|design|research|chore|docs|refactor|test|perf|task)\s*(?:\(|[:：])/i,
  /^\s*(?:epic|调研|设计|研究|功能|缺陷|需求|任务|step\s*[\d.]+)\s*[:：]/i,
  /^\s*[[【](?:epic|feat|feature|fix|bug|design|research|调研|设计|功能|缺陷)[\]】]/i,
];

const titleFindings = (title: string, label: string, issue: Issue): string[] => {
  if (title === "") return [`${label} has no title.`];
  const findings: string[] = [];
  if (TYPE_PREFIX.some((prefix) => prefix.test(title))) {
    findings.push(
      `${label}: the title starts with a type prefix; the type is a field, write the action and its object.`,
    );
  }
  // The project's key, and keys that extend it (CYC- and the older CYCL- are the same tracker).
  const project = issue.key.split("-")[0] ?? "";
  if (project !== "" && new RegExp(`\\b${project}[A-Z]*-\\d+\\b`, "i").test(title)) {
    findings.push(`${label}: the title has a work item number; leave it out.`);
  }
  return findings;
};

/** The checks every description goes through, Epic's included: an opening paragraph and the length. */
const bodyFindings = (description: string, label: string): string[] => {
  const findings: string[] = [];
  if (description.trim() === "") return [`${label} has no description.`];
  if (openingParagraph(description) === "") {
    findings.push(
      `${label} has no opening paragraph: start with two or three sentences for a person (what, why, what done looks like), before the first heading.`,
    );
  }
  const length = [...description].length;
  if (length > MAX_BODY) {
    findings.push(`${label} is ${length} characters long; it must be at most ${MAX_BODY}.`);
  }
  return findings;
};

/** `bun test` paths and integration suites the criteria name, beyond what `preflight` checks. */
const commandFindings = (description: string, label: string, rules: ShapeRules): string[] => {
  const findings: string[] = [];
  for (const criterion of parseCriteria(description)) {
    for (const command of criterion.commands) {
      const argv = parseVerify(command);
      if (argv === undefined) continue;
      const [, verb, script, ...rest] = argv;
      if (verb === "test") {
        for (const path of argv.slice(2)) {
          if (!path.startsWith("./")) {
            findings.push(
              `${label}: \`bun test ${path}\` must start the path with ./ (\`bun test ./${path}\`): without it, bun takes it as a name filter.`,
            );
            continue;
          }
          const relative = posix.normalize(path);
          const dir = posix.dirname(relative);
          // The directory counts only when it is not the root: a test may be new, but not anywhere at all.
          if (!rules.exists(relative) && (dir === "." || !rules.exists(dir))) {
            findings.push(
              `${label}: \`bun test ${path}\`: neither the path nor its directory is in the repository.`,
            );
          }
        }
      } else if (script === "test:integration" && rest.length > 0) {
        const suite = rest[0] as string;
        if (suite.startsWith("-")) {
          findings.push(
            `${label}: \`bun run test:integration ${suite}\` takes a suite name, not an option; the loop adds --strict itself.`,
          );
        } else if (!rules.suites.some((name) => name.includes(suite))) {
          findings.push(
            `${label}: \`bun run test:integration ${suite}\` matches no suite; the suites are ${rules.suites.join(", ")}.`,
          );
        }
      }
    }
  }
  return findings;
};

const typeIdOf = (type: PartType, rules: ShapeRules): number =>
  type === "Feature" ? rules.featureTypeId : rules.bugTypeId;

/** A Feature or a Bug as it would be written: its title, its body, its criteria and their commands. */
const workItemFindings = (
  piece: { title: string; description: string; typeId: number },
  label: string,
  issue: Issue,
  rules: ShapeRules,
): string[] => {
  const findings = [...titleFindings(piece.title, label, issue)];
  const body = bodyFindings(piece.description, label);
  findings.push(...body);
  if (piece.description.trim() === "") return findings;
  const pre = preflight(
    { ...issue, title: piece.title, description: piece.description, typeId: piece.typeId },
    { ...rules, research: null } satisfies PreflightConfig,
  );
  if (!pre.ok) for (const reason of pre.reasons) findings.push(`${label}: ${reason}`);
  findings.push(...commandFindings(piece.description, label, rules));
  return findings;
};

const typeName = (typeId: number | null, rules: ShapeRules): PartType | null =>
  typeId === rules.featureTypeId ? "Feature" : typeId === rules.bugTypeId ? "Bug" : null;

/**
 * What is wrong with the shaping reply for `issue`, in words the loop sends back to the session as they are; empty
 * when it may go to QA. Every Feature and Bug in it must pass the same preflight as a work item the loop takes, so a
 * person who approves it finds it ready.
 */
export const checkShape = (output: ShapeOutput, issue: Issue, rules: ShapeRules): string[] => {
  const kind = shapeKind(output);
  if (kind === null) {
    const any =
      output.title !== null ||
      output.description !== null ||
      output.split !== null ||
      output.epic !== null ||
      output.questions !== null;
    return [
      any
        ? "The reply mixes forms. Give exactly one: a rewrite (<title>, <description>, <notes>), a split (<split>, <notes>, and <epic> when asked for), or <questions>."
        : "There is no answer. Give exactly one: a rewrite (<title>, <description>, <notes>), a split (<split>, <notes>, and <epic> when asked for), or <questions>.",
    ];
  }
  if (kind === "questions") {
    return (output.questions ?? []).length === 0
      ? ["The <questions> block is empty: list the questions, one per line."]
      : [];
  }
  const findings: string[] = [];
  if (output.notes === null || output.notes === "") {
    findings.push(
      "There are no <notes>: say what you changed, on what grounds, and what is 「待确认」.",
    );
  }
  const original = typeName(issue.typeId, rules);
  if (kind === "rewrite") {
    if (output.title === null) findings.push("There is no <title>...</title> block.");
    if (output.description === null) {
      findings.push("There is no <description>...</description> block.");
      return findings;
    }
    findings.push(
      ...workItemFindings(
        {
          title: output.title ?? "",
          description: output.description,
          typeId: issue.typeId ?? rules.featureTypeId,
        },
        "The rewrite",
        issue,
        rules,
      ),
    );
    return findings;
  }
  const parts = output.split ?? [];
  if (output.split === null) findings.push("There is no <split>...</split> block.");
  else if (parts.length < 2 || parts.length > rules.maxSplit) {
    findings.push(
      `The split has ${parts.length} part(s); it must have 2 to ${rules.maxSplit}. With one, give a rewrite instead.`,
    );
  }
  const standalone = issue.parentId === null;
  if (standalone && output.epic === null) {
    findings.push(
      `${issue.key} has no parent, so a split turns it into an Epic: give <epic title="...">, its body as an Epic.`,
    );
  }
  if (!standalone && output.epic !== null) {
    findings.push(
      `${issue.key} already has a parent: leave out <epic>; the first part replaces ${issue.key} and the others are its siblings.`,
    );
  }
  if (standalone && output.epic !== null) {
    findings.push(...titleFindings(output.epic.title, "The epic", issue));
    findings.push(...bodyFindings(output.epic.description, "The epic"));
  }
  parts.forEach((part, index) => {
    const label = `Part ${index + 1}${part.title === "" ? "" : ` ("${part.title}")`}`;
    if (part.type === null) {
      findings.push(`${label} has no type="Feature" or type="Bug".`);
      return;
    }
    // Under a parent, the first part is written over the work item itself, whose type the planner cannot change.
    if (index === 0 && !standalone && original !== null && part.type !== original) {
      findings.push(
        `${label} is a ${part.type}, but it replaces ${issue.key}, which is a ${original}; keep its type.`,
      );
    }
    findings.push(
      ...workItemFindings(
        { title: part.title, description: part.description, typeId: typeIdOf(part.type, rules) },
        label,
        issue,
        rules,
      ),
    );
  });
  return findings;
};

// ---------------------------------------------------------------------------------------------------------------
// The work item rules given to shaping

/** The sections of the work item rules (`.claude/skills/cycle-workflow/SKILL.md`) shaping is told, by heading. */
export const WORKFLOW_SECTIONS = ["标题", "正文", "拆分一张工单"] as const;

/**
 * Those sections from the skill's text, as written there, so the prompt follows the rules a person reads. A section
 * that is gone is an error: the planner does not shape by rules it was not given.
 */
export const workflowRules = (skill: string): string => {
  const lines = skill.replace(/\r\n?/g, "\n").split("\n");
  return WORKFLOW_SECTIONS.map((name) => {
    const section = findSection(skill.replace(/\r\n?/g, "\n"), name);
    if (section === undefined) throw new Error(`the work item rules have no section 「${name}」`);
    return lines.slice(section.heading, section.end).join("\n").trim();
  }).join("\n\n");
};

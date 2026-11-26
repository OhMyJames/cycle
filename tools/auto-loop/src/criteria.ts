// The acceptance criteria of one work item, as a list the loop keeps and judges (CYC-318).
//
// The point of this file: whether a criterion is met is decided by a command's exit code, run by this code, and by
// nothing else. A session saying "done" changes nothing here. `CriteriaBook.verify` is the only thing that sets a
// status to `passed`.

import { z } from "zod";
import { summarizeFailure } from "./failure.ts";
import type { Exec } from "./types.ts";

export const CriterionSchema = z.object({
  id: z.number().int().positive(),
  text: z.string(),
  /** Each is an argv the loop may run (see `parseVerify`). */
  verify: z.array(z.array(z.string()).min(1)).min(1),
  status: z.enum(["pending", "passed", "failed"]),
  evidence: z.string().nullable(),
  checkedAt: z.string().nullable(),
});
export type Criterion = z.infer<typeof CriterionSchema>;

export type CriterionSpec = { text: string; verify: string[][] };

/** What a criterion in the work item's text says before it is checked: its words and the commands it names. */
export type ParsedCriterion = { text: string; commands: string[] };

const HEADING = /^(#{1,6})\s*(验收标准|验收|acceptance criteria|acceptance)(?!\w)/i;
const ITEM = /^([ \t]*)(\d+[.)]|[-*+])\s+(?:\[[ xX]\]\s+)?(.+)$/;
const MARKER = /(?:验证|verify)\s*[:：]/i;

const indentOf = (prefix: string): number => {
  let width = 0;
  for (const ch of prefix) {
    width = ch === "\t" ? width + 4 - (width % 4) : width + 1;
  }
  return width;
};

export type ListItem = { text: string; numbered: boolean };

/**
 * The top-level list items under the first heading `heading` matches, up to the next heading. Deeper items and
 * indented lines are folded into the item above them.
 */
export const listUnder = (description: string, heading: RegExp): ListItem[] => {
  const lines = description.split("\n");
  const start = lines.findIndex((line) => heading.test(line.trim()));
  if (start === -1) return [];
  const items: ListItem[] = [];
  let baseIndent: number | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line.trim())) break;
    const item = ITEM.exec(line);
    if (item !== null) {
      const indent = indentOf(item[1] ?? "");
      if (baseIndent === undefined || indent <= baseIndent) {
        baseIndent ??= indent;
        items.push({ text: (item[3] ?? "").trim(), numbered: /^\d/.test(item[2] ?? "") });
        continue;
      }
    }
    const last = items.at(-1);
    if (line.trim() !== "" && /^\s+/.test(line) && last !== undefined) {
      last.text += ` ${line.trim()}`;
    }
  }
  return items;
};

/** The criteria in the work item's description: the list items under a heading such as `## 验收标准`. */
export const parseCriteria = (description: string): ParsedCriterion[] =>
  listUnder(description, HEADING).map(({ text }) => {
    const marker = MARKER.exec(text);
    const rest = marker === null ? "" : text.slice(marker.index + marker[0].length);
    const commands = Array.from(rest.matchAll(/`([^`]+)`/g), (m) => (m[1] as string).trim());
    return { text, commands };
  });

const SAFE_WORD = /^[\w.:/@=+-]+$/;
const SAFE_PATH = /^(?!-)(?!\/)[\w./-]+$/;

/**
 * The commands a criterion may name, as argv, or undefined when it is not one of them.
 *
 * Whoever wrote the work item (or a session that drafted it) wrote the command, and this loop runs it with no one
 * watching. So it is not a shell line: it is one of a few forms, with plain words and no shell syntax, and a test path
 * that stays inside the repository.
 */
export const parseVerify = (command: string): string[] | undefined => {
  const words = command.trim().split(/\s+/);
  if (words.length === 0 || words.some((word) => !SAFE_WORD.test(word))) return undefined;
  const [bun, verb, ...rest] = words;
  if (bun !== "bun") return undefined;
  if (verb === "run") {
    const [script, ...more] = rest;
    if (script === "check" || script === "test:browser")
      return more.length === 0 ? words : undefined;
    if (script === "test:integration") {
      return more.every((word) => /^[\w.-]+$/.test(word)) && more.length <= 1 ? words : undefined;
    }
    return undefined;
  }
  if (verb === "test") {
    if (rest.length === 0) return undefined;
    const ok = rest.every((word) => SAFE_PATH.test(word) && !word.split("/").includes(".."));
    return ok ? words : undefined;
  }
  return undefined;
};

/** `parseVerify` for a criterion's commands, or why one of them is not allowed. */
export const verifyArgv = (
  commands: string[],
): { ok: true; argv: string[][] } | { ok: false; rejected: string[] } => {
  const argv: string[][] = [];
  const rejected: string[] = [];
  for (const command of commands) {
    const parsed = parseVerify(command);
    if (parsed === undefined) rejected.push(command);
    else argv.push(parsed);
  }
  return rejected.length > 0 ? { ok: false, rejected } : { ok: true, argv };
};

const tail = (text: string, max: number): string =>
  text.length <= max ? text : `…${text.slice(text.length - max)}`;

export class CriteriaBook {
  #items: Criterion[];

  private constructor(items: Criterion[]) {
    this.#items = items;
  }

  /** A new list: every criterion pending, however it was written. */
  static fromSpecs(specs: CriterionSpec[]): CriteriaBook {
    return new CriteriaBook(
      specs.map((spec, index) => ({
        id: index + 1,
        text: spec.text,
        verify: spec.verify,
        status: "pending",
        evidence: null,
        checkedAt: null,
      })),
    );
  }

  /** A list read back from the run directory. */
  static restore(json: unknown): CriteriaBook {
    return new CriteriaBook(z.array(CriterionSchema).parse(json));
  }

  /** A copy: changing it does not change the book. */
  get items(): Criterion[] {
    return structuredClone(this.#items);
  }

  get allPassed(): boolean {
    return this.#items.length > 0 && this.#items.every((item) => item.status === "passed");
  }

  /**
   * Runs the commands of one criterion. It passes when every command exits 0 in time; otherwise it fails, with the end
   * of the output as its evidence. The only way a status becomes `passed`.
   */
  async verify(
    id: number,
    run: {
      exec: Exec;
      cwd: string;
      env: Record<string, string>;
      timeoutMs: number;
      now: () => Date;
    },
  ): Promise<Criterion> {
    const item = this.#items.find((candidate) => candidate.id === id);
    if (item === undefined) throw new Error(`no criterion ${id}`);
    const evidence: string[] = [];
    let passed = true;
    for (const argv of item.verify) {
      const result = await run.exec(argv, {
        cwd: run.cwd,
        env: run.env,
        timeoutMs: run.timeoutMs,
      });
      const outcome = result.timedOut ? "timed out" : `exit ${result.code}`;
      const failed = result.code !== 0 || result.timedOut;
      const shown = failed ? summarizeFailure(result.output) : tail(result.output, 1500);
      evidence.push(`$ ${argv.join(" ")}\n${outcome}\n${shown}`);
      if (failed) {
        passed = false;
        break;
      }
    }
    item.status = passed ? "passed" : "failed";
    item.evidence = evidence.join("\n\n");
    item.checkedAt = run.now().toISOString();
    return structuredClone(item);
  }

  /** Back to pending, before the next round checks everything again. */
  reset(): void {
    for (const item of this.#items) {
      item.status = "pending";
      item.evidence = null;
      item.checkedAt = null;
    }
  }
}

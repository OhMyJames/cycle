import { type CriterionSpec, parseCriteria, verifyArgv } from "./criteria.ts";
import type { Config, Issue } from "./types.ts";

export type Preflight = { ok: true; specs: CriterionSpec[] } | { ok: false; reasons: string[] };

/**
 * Whether a work item is fit to be taken, decided by rules and not by a model: it must say what is wanted, every
 * criterion must name a command the loop may run, and it must not be more than one session can do.
 */
export const preflight = (issue: Issue, config: Pick<Config, "maxCriteria">): Preflight => {
  const reasons: string[] = [];
  if (issue.description.trim() === "") {
    return { ok: false, reasons: ["The work item has no description."] };
  }
  const parsed = parseCriteria(issue.description);
  if (parsed.length === 0) {
    return {
      ok: false,
      reasons: ["There is no list of acceptance criteria (a list under a 「验收标准」 heading)."],
    };
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
        `${label} names a command the loop may not run: ${argv.rejected.map((c) => `\`${c}\``).join(", ")}. Allowed: bun run check, bun run test:browser, bun run test:integration [suite], bun test <path>.`,
      );
      return;
    }
    specs.push({ text: criterion.text, verify: argv.argv });
  });
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, specs };
};

/** The comment that sends a work item back, in the words a person reads in the tracker. */
export const sendBackComment = (reasons: string[]): string =>
  `自动化暂时不能领取这张工单：\n${reasons.map((reason) => `- ${reason}`).join("\n")}\n\n补充后把它放回 Todo，自动化会重新检查。`;

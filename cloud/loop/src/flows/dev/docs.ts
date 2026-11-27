import { Blocked } from "../../engine/flow.ts";
import {
  changedReason,
  DocsChanged,
  docChanges,
  NEEDS_SPEC,
  readFullFlowDocs,
  readFullFlowTexts,
} from "../../full-flow.ts";
import type { Issue } from "../../types.ts";
import type { DevRun, FlowHost, Save } from "./context.ts";

/** 大档 (CYC-453): the named documents as the run recorded them; a change since blocks the run. */
export async function docTexts<N extends "Spec" | "Design" | "Plan">(
  h: FlowHost,
  run: DevRun,
  issue: Issue,
  names: readonly N[],
): Promise<Record<Lowercase<N>, string> | undefined> {
  try {
    return await readFullFlowTexts(run.dev.fullFlowDocs, h.d.tracker, names, async () =>
      docChanges(run.dev.fullFlowDocs, await h.d.tracker.listIssueDocuments(issue)),
    );
  } catch (error) {
    if (error instanceof DocsChanged) throw new Blocked(changedReason(error.message));
    throw error;
  }
}

/**
 * 大档 (CYC-328): the four documents must still be as the run began. A change blocks, for a person to say whether
 * the plan changed or a document was touched by mistake. When a person has put the run back (`rebase`), what they
 * left, if all four are present and locked, becomes the new baseline.
 */
export async function checkDocs(
  h: FlowHost,
  run: DevRun,
  issue: Issue,
  save: Save,
  rebase: boolean,
): Promise<void> {
  const linked = await h.d.tracker.listIssueDocuments(issue);
  if (rebase) {
    const read = readFullFlowDocs(issue, linked);
    if (!read.ok) throw new Blocked(`${NEEDS_SPEC} ${read.reasons.join(" ")}`);
    const changes = docChanges(run.dev.fullFlowDocs, linked);
    if (changes !== undefined) {
      await save({ dev: { fullFlowDocs: read.docs } });
      await h.d.store.event(run.key, "docs_rebaselined", { changes });
    }
    return;
  }
  const changes = docChanges(run.dev.fullFlowDocs, linked);
  if (changes !== undefined) throw new Blocked(changedReason(changes));
}

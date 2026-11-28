// Merge gate: the single decision "may Loop merge this PR at this commit". Sits inside the path floor, so a PR
// changing it must be merged by a person. Both the dev flow and the human-PR flow merge only through this.

import { floorHits } from "./floor.ts";

export type GateVerdict = "merge" | "reject" | "escalate" | "system_error";
export type GateCi = "passed" | "failed" | "pending" | "unreadable";

export interface MergeGateInput {
  verdict: GateVerdict;
  reviewedSha: string;
  headNow: string;
  ciAtHead: GateCi;
  /** Paths changed by the PR; null when they could not be read. */
  changedPaths: string[] | null;
  /** Present only for PRs opened by humans. */
  author?: { permission: string; crossRepository: boolean };
}

export type MergeGateResult = { ok: true } | { ok: false; reasons: string[]; floorHits: string[] };

const WRITE_PERMISSIONS = new Set(["write", "maintain", "admin"]);

export const mayMerge = (input: MergeGateInput): MergeGateResult => {
  const reasons: string[] = [];
  let hits: string[] = [];
  if (input.verdict !== "merge") reasons.push(`review verdict is ${input.verdict}, not merge`);
  if (input.reviewedSha === "" || input.reviewedSha !== input.headNow)
    reasons.push(`reviewed commit ${input.reviewedSha} is not the current head ${input.headNow}`);
  if (input.ciAtHead !== "passed")
    reasons.push(`required CI at the head is ${input.ciAtHead}, not passed`);
  if (input.changedPaths === null) reasons.push("changed paths could not be read");
  else {
    hits = floorHits(input.changedPaths);
    if (hits.length > 0) reasons.push(`touches the path floor: ${hits.join(", ")}`);
  }
  if (input.author) {
    if (input.author.crossRepository) reasons.push("PR comes from a fork");
    if (!WRITE_PERMISSIONS.has(input.author.permission))
      reasons.push(`author permission is ${input.author.permission || "none"}, needs write`);
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons, floorHits: hits };
};

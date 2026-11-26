// The dev flow: a Feature or a Bug, from the claim to a merged pull request. Its phases are `Pipeline`'s own steps,
// which share the PR guard, conflict handling and CI state with it; this says which they are and what is particular
// to a dev run.

import { readPrState } from "../pr.ts";
import type { Flow, FlowHost, PhaseDef } from "./flow.ts";
import { blockTicket, ticketStillWanted } from "./ticket.ts";

export type DevSteps = Record<
  "claim" | "dev" | "verify" | "qa" | "deliver" | "ci" | "review",
  PhaseDef["step"]
>;

export const devFlow = (host: FlowHost, steps: DevSteps): Flow => ({
  kind: "dev",
  phases: {
    claimed: { field: "dev", step: steps.claim },
    dev: { field: "dev", step: steps.dev, announces: true },
    verify: { field: "verify", step: steps.verify },
    qa: { field: "qa", step: steps.qa },
    delivering: { field: "ci", step: steps.deliver },
    ci: { field: "ci", step: steps.ci },
    review: { field: "review", step: steps.review },
  },
  firstPhase: "dev",
  qa: {
    role: "qa",
    title: (key) => `[${key}] QA`,
    subject: "代码",
    readRoots: () => undefined,
  },

  enabled: () => true,

  open(accepted) {
    if (accepted.kind !== "dev") throw new Error(`a ${accepted.kind} work item is not a dev run`);
    // A dev run's `claimed` event stays as it always was: no `runKind`, which `stats` reads as dev.
    return {
      specs: accepted.specs,
      ...(accepted.docs === undefined ? {} : { fullFlowDocs: accepted.docs }),
      research: null,
      claimed: {
        criteria: accepted.specs.length,
        ...(accepted.docs === undefined ? {} : { fullFlow: true }),
      },
    };
  },

  wouldTake(issue, accepted) {
    if (accepted.kind !== "dev") throw new Error(`a ${accepted.kind} work item is not a dev run`);
    return { status: "would-take", key: issue.key, criteria: accepted.specs.length };
  },

  stillWanted: (run) => ticketStillWanted(host, run),

  // What the checks said is held in memory only: going on from QA or the delivery, they are run again. A human resume
  // from `ci` or `review` also re-runs verify/QA/push in case they committed a fix locally; a crash recovery in `ci`
  // or `review` continues directly from there.
  recheck: (run, byPerson) =>
    run.phase === "qa" ||
    run.phase === "delivering" ||
    (byPerson && (run.phase === "ci" || run.phase === "review"))
      ? "verify"
      : undefined,

  block: (args) =>
    blockTicket(host, args, {
      firstPhase: "dev",
      session: `Dev 会话「[${args.run.key}] Dev」`,
      redact: (said) => said,
    }),

  // Done is not enough: the pull request must be merged. One closed without merging is left for a person.
  async whenDone(run) {
    const { config } = host.d;
    if (run.prUrl === null) return "keep";
    const read = await readPrState({
      prRef: run.prUrl,
      exec: host.d.exec,
      cwd: config.repoRoot,
      env: host.d.env,
      timeoutMs: config.commandTimeoutMs,
    });
    if (!read.ok) return "keep";
    if (read.state === "CLOSED") return { note: "cleanup_skipped_unmerged" };
    if (read.state !== "MERGED") return "keep";
    return "remove";
  },
});

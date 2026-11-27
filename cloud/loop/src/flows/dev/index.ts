// The dev flow: a Feature or a Bug, from the claim to a merged pull request (CYC-479). It holds what is particular to
// a dev run: the pull request and its guard, CI, the review, a conflict with the base, `node_modules` released while
// waiting. What every run shares (the lock, the workers, the retries, the loop from phase to phase) is the engine's.

import { CriteriaBook } from "../../criteria.ts";
import type { Flow, FlowHost, StepResult } from "../../engine/flow.ts";
import { buildGraph } from "../../graph.ts";
import { preflight } from "../../preflight.ts";
import { DevStateSchema } from "../../store.ts";
import type { Issue } from "../../types.ts";
import { blockTicket, sendBack, ticketStillMine, ticketStillWanted } from "../ticket.ts";
import { ci } from "./ci.ts";
import { claim } from "./claim.ts";
import { rollbackMerge } from "./conflict.ts";
import { asDev, type Dev } from "./context.ts";
import { deliver } from "./deliver.ts";
import { dev } from "./dev.ts";
import { checkDocs } from "./docs.ts";
import { graphPlan, resetBlockedNodeOnResume } from "./graph.ts";
import { guardPr } from "./guard.ts";
import { DEV_QA, qa } from "./qa.ts";
import { review } from "./review.ts";
import { verify } from "./verify.ts";

/** What says the body is the one the criteria were read from. */
const bodyHashOf = (issue: Issue): string =>
  new Bun.CryptoHasher("sha256").update(issue.description).digest("hex").slice(0, 16);

export const devFlow = (host: FlowHost): Flow => {
  const x: Dev = { h: host, kept: new Set(), greenSeen: new Map() };
  return {
    kind: "dev",
    phases: {
      claimed: {
        field: "dev",
        step: ({ run, issue, save }) => claim(host, asDev(run), issue, save),
      },
      graph_plan: {
        field: "dev",
        step: ({ run, issue, save }) => graphPlan(host, asDev(run), issue, save),
      },
      dev: {
        field: "dev",
        step: ({ run, issue, book, announce, save }) =>
          dev(host, asDev(run), issue, book, announce, save),
        announces: true,
      },
      verify: {
        field: "verify",
        step: ({ run, book, save }) => verify(host, asDev(run), book, save),
      },
      qa: {
        field: "qa",
        step: ({ run, issue, book, save }) => qa(host, asDev(run), issue, book, save),
      },
      delivering: {
        field: "ci",
        step: ({ run, issue, book, save }) => deliver(host, asDev(run), issue, book, save),
      },
      ci: { field: "ci", step: ({ run, save }) => ci(x, asDev(run), save) },
      review: {
        field: "review",
        step: async ({ run, issue, book, save }): Promise<StepResult | undefined> => {
          const done = await review(x, asDev(run), issue, book, save);
          if (done === undefined) return undefined;
          await host.clear(run, issue);
          return {
            status: "delivered",
            key: run.key,
            prUrl: done.prUrl,
            autoMerge: done.autoMerge,
          };
        },
      },
    },
    firstPhase: "dev",
    qa: DEV_QA,

    enabled: () => true,

    open(accepted, issue) {
      if (accepted.kind !== "dev") throw new Error(`a ${accepted.kind} work item is not a dev run`);
      const graph =
        accepted.graphSpecs !== undefined
          ? buildGraph(issue.key, "plan_doc", accepted.graphSpecs, host.d.clock.now().toISOString())
          : undefined;
      // A dev run's `claimed` event stays as it always was: no `runKind`, which `stats` reads as dev.
      return {
        specs: accepted.specs,
        state: {
          kind: "dev",
          dev: DevStateSchema.parse({
            fullFlowDocs: accepted.docs ?? [],
            bodyHash: bodyHashOf(issue),
          }),
        },
        claimed: {
          criteria: accepted.specs.length,
          ...(accepted.docs === undefined ? {} : { fullFlow: true }),
          ...(graph === undefined ? {} : { graphNodes: graph.nodes.length }),
        },
        ...(graph !== undefined ? { graph } : {}),
      };
    },

    wouldTake(issue, accepted) {
      if (accepted.kind !== "dev") throw new Error(`a ${accepted.kind} work item is not a dev run`);
      return { status: "would-take", key: issue.key, criteria: accepted.specs.length };
    },

    stillWanted: (run) => ticketStillWanted(host, run),

    stillMine: (run) => ticketStillMine(host, run),

    // What the checks said is kept in `ci_state`, but a run going on from QA or the delivery runs them again. A human
    // resume from `ci` or `review` also re-runs verify/QA/push in case they committed a fix locally; a crash recovery
    // in `ci` or `review` continues directly from there.
    recheck: (run, byPerson) =>
      run.phase === "qa" ||
      run.phase === "delivering" ||
      (byPerson && (run.phase === "ci" || run.phase === "review"))
        ? "verify"
        : undefined,

    // 大档 (CYC-328): the documents must still be as the run began. Then the pull request, once there is one: closed
    // without merging stops the run, merged counts as delivered.
    async beforePhase({ run, issue, save, rebase }) {
      const state = asDev(run).dev;
      if (state.fullFlowDocs.length > 0) await checkDocs(host, asDev(run), issue, save, rebase);
      if (asDev(run).dev.prUrl !== null) return guardPr(host, asDev(run), issue, save);
      return undefined;
    },

    async putBack(run) {
      const current = asDev(run);
      // A conflict turn that blocked before it was judged leaves the merge open, markers and all: back it out, or the
      // next checkpoint would commit them.
      const saved = current.dev.conflict;
      if (saved?.state === "dev" && saved.preMergeSha !== undefined && current.worktree !== null) {
        const failed = await rollbackMerge(host, current.worktree, saved.preMergeSha);
        if (failed !== "") throw new Error(`conflict rollback on resume failed: ${failed}`);
      }
      await resetBlockedNodeOnResume(host, current);
      return {
        ...current,
        dev: { ...current.dev, ciRound: 0, conflictRound: 0, conflict: null, resolvedFiles: [] },
      };
    },

    // CYC-467: a person edited the body while the run was blocked. A 大档 run is judged by its documents, which
    // `checkDocs` already watches; a run begun before the hash was kept adopts the hash and goes on as before.
    async reread(run, issue) {
      const current = asDev(run);
      if (current.dev.fullFlowDocs.length > 0) return undefined;
      const hash = bodyHashOf(issue);
      if (current.dev.bodyHash === hash) return undefined;
      const pre = preflight(issue, host.d.config);
      if (!pre.ok || pre.kind !== "dev") {
        const reasons = pre.ok ? ["工单不再是开发工单"] : pre.reasons;
        await sendBack(host, issue, reasons);
        return { rejected: reasons };
      }
      const stored = (await host.d.store.loadCriteria(run.key)).items.map(({ text, verify }) => ({
        text,
        verify,
      }));
      const sameCriteria = JSON.stringify(pre.specs) === JSON.stringify(stored);
      // A run begun before the hash was kept cannot say whether the prose changed: it adopts the hash.
      if (current.dev.bodyHash == null && sameCriteria)
        return { run: { ...current, dev: { ...current.dev, bodyHash: hash } } };
      const noted = { ...current.dev, bodyHash: hash, bodyChanged: true };
      // Same criteria: Dev is told, and nothing else restarts.
      if (sameCriteria) return { run: { ...current, dev: noted } };
      // New criteria start from pending: a run that was past the checks goes back to them.
      const from = current.resumeFrom;
      return {
        run: {
          ...current,
          resumeFrom: from === null || from === "claimed" || from === "dev" ? from : "verify",
          dev: noted,
        },
        book: CriteriaBook.fromSpecs(pre.specs),
      };
    },

    afterRemoved: () => ({ dev: { reviewSessionId: null, prUrl: null, activeNodeId: null } }),

    forget(key) {
      x.greenSeen.delete(key);
      for (const id of x.kept) if (id.startsWith(`${key}:`)) x.kept.delete(id);
    },

    block: (args) =>
      blockTicket(host, args, {
        firstPhase: "dev",
        session: `Dev 会话「[${args.run.key}] Dev」`,
        redact: (said) => said,
      }),

    // Done is not enough: the pull request must be merged. One closed without merging is left for a person.
    async whenDone(run) {
      const { config } = host.d;
      const prUrl = asDev(run).dev.prUrl;
      if (prUrl === null) return "keep";
      const read = await host.d.forge.prState(
        { cwd: config.repoRoot, timeoutMs: config.commandTimeoutMs },
        prUrl,
      );
      if (!read.ok) return "keep";
      if (read.state === "CLOSED") return { note: "cleanup_skipped_unmerged" };
      if (read.state !== "MERGED") return "keep";
      return "remove";
    },
  };
};

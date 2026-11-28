import type { CriteriaBook } from "../../criteria.ts";
import { summarizeFailure } from "../../failure.ts";
import { testLayers } from "../../layers.ts";
import { type DevRun, type FlowHost, type Save, where } from "./context.ts";
import { nodeVerify } from "./graph.ts";
import { restoreNodeModules } from "./node-modules.ts";
import { nextRound } from "./qa.ts";
import { verificationPass } from "./verification.ts";

export async function verify(
  h: FlowHost,
  run: DevRun,
  book: CriteriaBook,
  save: Save,
): Promise<void> {
  if (run.dev.activeNodeId != null) {
    // A QA node that is still open means a run going on from `qa`: only a Dev node has node-local checks.
    const graph = await h.d.store.loadGraph(run.key);
    const active = graph?.nodes.find((n) => n.id === run.dev.activeNodeId);
    if (active === undefined || active.role === "dev") {
      await nodeVerify(h, run, save);
      return;
    }
  }
  const { config, store, clock } = h.d;
  const worktree = h.need(run.worktree ?? undefined);
  // Every way into verify (after Dev, a clean conflict merge, a resume) passes here.
  await restoreNodeModules(h, run, worktree, save);
  const files = await h.d.workspace.changedFiles(where(h, worktree), config.baseRef);
  const failures: string[] = [];
  if (files.length === 0) failures.push("There is no change on the branch.");

  const { exec, options } = verificationPass(h, run, worktree);
  const checks: { command: string; passed: boolean }[] = [];
  if (files.length > 0) {
    for (const argv of testLayers(files)) {
      const done = await exec(argv, options);
      const passed = done.code === 0 && !done.timedOut;
      checks.push({ command: argv.join(" "), passed });
      if (!passed) {
        failures.push(
          `\`${argv.join(" ")}\` ${done.timedOut ? "timed out" : `failed (exit ${done.code})`}:\n${summarizeFailure(done.output).trim()}`,
        );
        break;
      }
    }
  }

  book.reset();
  if (failures.length === 0) {
    for (const criterion of book.items) {
      const done = await book.verify(criterion.id, { exec, ...options, now: () => clock.now() });
      if (done.status !== "passed")
        failures.push(
          `Criterion ${done.id} (${done.text}) did not pass:\n${summarizeFailure(done.evidence ?? "").trim()}`,
        );
    }
  }
  await store.saveCriteria(run.key, book);
  await h.d.store.saveCi(run.key, { checks });
  await store.event(run.key, "verify", {
    round: run.round,
    checks: checks.length,
    criteria: book.items.length,
    passed: book.items.filter((c) => c.status === "passed").length,
  });

  if (failures.length > 0) {
    const failedVerify = book.items
      .filter((c) => c.status === "failed")
      .flatMap((c) => c.verify.map((argv) => argv.join(" ")));
    await nextRound(h, run, failures.join("\n\n"), save, "dev", {
      fixTitle: "修复整单验收失败",
      fixVerify: failedVerify.length > 0 ? failedVerify : ["bun run check"],
    });
    return;
  }
  // The person's edit has been judged by the checks: a later fix turn need not be told of it again.
  await save({ phase: "qa", dev: { bodyChanged: false } });
}

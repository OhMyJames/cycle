import type { CriteriaBook } from "../../criteria.ts";
import { verifyEnv } from "../../env.ts";
import { summarizeFailure } from "../../failure.ts";
import { testLayers } from "../../layers.ts";
import type { Exec, ExecResult } from "../../types.ts";
import { type DevRun, type FlowHost, type Save, where } from "./context.ts";
import { restoreNodeModules } from "./node-modules.ts";
import { nextRound } from "./qa.ts";

export async function verify(
  h: FlowHost,
  run: DevRun,
  book: CriteriaBook,
  save: Save,
): Promise<void> {
  const { config, store, clock } = h.d;
  const worktree = h.need(run.worktree ?? undefined);
  // Every way into verify (after Dev, a clean conflict merge, a resume) passes here.
  await restoreNodeModules(h, run, worktree, save);
  const files = await h.d.workspace.changedFiles(where(h, worktree), config.baseRef);
  const failures: string[] = [];
  if (files.length === 0) failures.push("There is no change on the branch.");

  // The same command is run once, whichever criteria and layers name it.
  const results = new Map<string, ExecResult>();
  const exec: Exec = async (argv, options) => {
    const key = argv.join(" ");
    const known = results.get(key);
    if (known !== undefined) return known;
    let done = await h.d.exec(argv, options);
    // A flaky command gets re-run in place; a timed-out one does not (it would stretch the round).
    for (
      let attempt = 1;
      attempt <= config.maxVerifyRetries && done.code !== 0 && !done.timedOut;
      attempt++
    ) {
      done = await h.d.exec(argv, options);
      await store.event(run.key, "verify_retried", {
        round: run.round,
        command: key,
        attempt,
        passed: done.code === 0 && !done.timedOut,
      });
    }
    results.set(key, done);
    return done;
  };
  const env = verifyEnv(h.d.env);
  const checks: { command: string; passed: boolean }[] = [];
  if (files.length > 0) {
    for (const argv of testLayers(files)) {
      const done = await exec(argv, { cwd: worktree, env, timeoutMs: config.commandTimeoutMs });
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
      const done = await book.verify(criterion.id, {
        exec,
        cwd: worktree,
        env,
        timeoutMs: config.commandTimeoutMs,
        now: () => clock.now(),
      });
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
    await nextRound(h, run, failures.join("\n\n"), save);
    return;
  }
  await save({ phase: "qa" });
}

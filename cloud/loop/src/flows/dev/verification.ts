import { ensureVerifyDirs, verifyEnv } from "../../env.ts";
import type { Exec, ExecResult } from "../../types.ts";
import type { DevRun, FlowHost } from "./context.ts";

/** One verification pass has one environment, result cache and retry budget per command. */
export function verificationPass(h: FlowHost, run: DevRun, cwd: string, nodeId?: string) {
  const { config, store } = h.d;
  // The same command is run once, whichever criteria and layers name it.
  const results = new Map<string, ExecResult>();
  const exec: Exec = async (argv, options) => {
    const key = JSON.stringify(argv);
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
        ...(nodeId === undefined ? {} : { nodeId }),
        command: argv.join(" "),
        attempt,
        passed: done.code === 0 && !done.timedOut,
      });
    }
    results.set(key, done);
    return done;
  };
  const isolation = { stateDir: config.stateDir, key: run.key };
  ensureVerifyDirs(isolation);
  const env = verifyEnv(h.d.env, isolation);
  return { exec, options: { cwd, env, timeoutMs: config.commandTimeoutMs } };
}

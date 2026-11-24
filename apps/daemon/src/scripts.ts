// Runs an environment's setup or cleanup script in a worktree (docs/protocol.md §6 "Worktree"). Never in the main
// checkout: the caller passes a worktree's path. The script gets the shell's usual names and the environment's own
// variables, nothing of the daemon's.
import { gitEnv } from "./git.ts";

export type ScriptResult = { ok: boolean; output: string };

/** What a person is shown of a script's output: the last of it. */
const KEEP_BYTES = 8 * 1024;

export const runScript = async (
  script: string,
  options: { cwd: string; variables: Record<string, string>; timeoutMs: number; shell?: string },
): Promise<ScriptResult> => {
  const shell = options.shell ?? process.env.SHELL ?? "/bin/sh";
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([shell, "-c", script], {
      cwd: options.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...gitEnv(), ...options.variables, CYCLE_WORKTREE: options.cwd },
    });
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs);
  try {
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const all = `${out}${err}`;
    const output = all.length > KEEP_BYTES ? all.slice(-KEEP_BYTES) : all;
    if (timedOut)
      return { ok: false, output: `${output}\n(timed out after ${options.timeoutMs} ms)`.trim() };
    return { ok: code === 0, output };
  } finally {
    clearTimeout(timer);
  }
};

/** Setup may install dependencies; cleanup only lets go of what setup took. */
export const SETUP_TIMEOUT_MS = 10 * 60_000;
export const CLEANUP_TIMEOUT_MS = 60_000;

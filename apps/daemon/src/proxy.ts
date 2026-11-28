import { closeSync, mkdirSync, openSync, readFileSync, statSync, truncateSync } from "node:fs";
import type { Paths } from "./config.ts";
import { selfCommand } from "./self.ts";
import { bridgeStdio, isListening } from "./transport/server.ts";

/** Past this size the raw output is started anew: it holds what the runtime says as it dies, not a history. */
const OUTPUT_LIMIT = 1_000_000;

/** The daemon's log (docs/daemon.md "日志"). */
export const logPath = (paths: Paths): string => paths.log;

const tailOf = (path: string, chars: number): string => {
  try {
    return readFileSync(path, "utf8").trim().slice(-chars);
  } catch {
    return "";
  }
};

/**
 * The last of what the daemon said, for an error that has to say why it did not start: its log, and what the runtime
 * wrote when it was not the daemon's own code that stopped it.
 */
export const logTail = (paths: Paths): string =>
  [
    tailOf(paths.log, 1500) !== "" ? `Its log (${paths.log}):\n${tailOf(paths.log, 1500)}` : "",
    tailOf(paths.output, 1000) !== ""
      ? `Its output (${paths.output}):\n${tailOf(paths.output, 1000)}`
      : "",
  ]
    .filter((part) => part !== "")
    .join("\n");

/**
 * Starts a daemon that outlives this process, so a session goes on when an ssh connection drops. Its log is its own
 * (`daemon.log`, rotated); its stdout and stderr go to `<data dir>/daemon.out`, for what the runtime itself says when
 * it fails before or beneath the daemon's code. With nobody watching, those files are the way to learn why.
 */
export const startDetached = (
  paths: Paths,
  /** The program to start, when it is not this process's own (an update has just replaced that file). */
  command: string[] = selfCommand(),
): { exited: () => boolean; pid: number } => {
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  // One run's worth is enough to find a reason; the file does not grow for ever.
  try {
    if (statSync(paths.output).size > OUTPUT_LIMIT) truncateSync(paths.output, 0);
  } catch {}
  const fd = openSync(paths.output, "a", 0o600);
  try {
    const child = Bun.spawn(
      [...command, "serve", "--data-dir", paths.dataDir, "--socket", paths.socket],
      { detached: true, stdin: "ignore", stdout: fd, stderr: fd, env: process.env },
    );
    child.unref();
    return { exited: () => child.exitCode !== null, pid: child.pid };
  } finally {
    closeSync(fd);
  }
};

/**
 * `cycle proxy`: what a client runs over ssh. It joins its stdin and stdout to the daemon's
 * socket, and starts the daemon first if none is running. A first start of a new executable can be
 * slow (macOS looks at it before it runs it), so it is given time.
 */
export const proxy = async (
  paths: Paths,
  io: { stdin: ReadableStream<Uint8Array>; stdout: WritableStream<Uint8Array> },
  wait = { total: 30_000, step: 50 },
): Promise<void> => {
  if (!(await isListening(paths.socket))) {
    const daemon = startDetached(paths);
    const started = Date.now();
    while (!(await isListening(paths.socket))) {
      // One that has already exited is not going to start: no reason to wait out the time.
      if (daemon.exited() || Date.now() - started > wait.total) {
        await Bun.sleep(50);
        const said = logTail(paths);
        throw new Error(
          `The daemon did not start: nothing is listening on ${paths.socket}${
            said !== "" ? `\n${said}` : ""
          }`,
        );
      }
      await Bun.sleep(wait.step);
    }
  }
  await bridgeStdio(paths.socket, io);
};

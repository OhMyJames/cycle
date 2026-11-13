import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

const TIMEOUT_MS = 5_000;

// By absolute path, because a shell profile can redefine anything it finds by name. The format strings
// keep the markers out of the command's own text, in case a profile echoes commands to stdout.
const commandFor = (token: string): string =>
  `/usr/bin/printf '__CYCLE_ENV_START_%s__' ${token}; /usr/bin/env -0; /usr/bin/printf '__CYCLE_ENV_END_%s__' ${token}`;

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Finds the environment in what a login shell printed. Profiles print whatever they like around it,
 * and a value can hold a newline, so it comes between markers and is separated by NUL bytes.
 */
export function parseLoginEnv(stdout: string, token: string): Record<string, string> | undefined {
  const start = `__CYCLE_ENV_START_${token}__`;
  const end = `__CYCLE_ENV_END_${token}__`;
  const startAt = stdout.indexOf(start);
  if (startAt === -1) return undefined;
  const bodyAt = startAt + start.length;
  const endAt = stdout.indexOf(end, bodyAt);
  if (endAt === -1) return undefined;

  const env: Record<string, string> = {};
  for (const entry of stdout.slice(bodyAt, endAt).split("\0")) {
    const equals = entry.indexOf("=");
    if (equals === -1) continue;
    const name = entry.slice(0, equals);
    if (VARIABLE_NAME.test(name)) env[name] = entry.slice(equals + 1);
  }
  return env;
}

const isComplete = (stdout: string, token: string): boolean =>
  stdout.includes(`__CYCLE_ENV_END_${token}__`);

/** Stops at the end marker, because something a profile left running can hold the pipe open forever. */
const readUntilComplete = (stream: Readable, token: string): Promise<string> =>
  new Promise((resolve) => {
    let stdout = "";
    const finish = (): void => {
      stream.removeAllListeners();
      resolve(stdout);
    };
    // Decoded by the stream, so a character split between two chunks stays whole.
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      stdout += chunk;
      if (isComplete(stdout, token)) finish();
    });
    stream.on("end", finish);
    stream.on("error", finish);
  });

export type LoginEnvOptions = {
  shell: string;
  log: (line: string) => void;
  timeoutMs?: number;
};

/**
 * What a terminal would have, which Finder does not give an app: the `PATH` and proxy variables come
 * from the shell profile. A slow or broken profile must not stop the app, so it runs without them.
 */
export async function readLoginEnv({
  shell,
  log,
  timeoutMs = TIMEOUT_MS,
}: LoginEnvOptions): Promise<Record<string, string> | undefined> {
  const token = randomUUID().replaceAll("-", "");
  let child: ChildProcessByStdio<null, Readable, null>;
  try {
    child = spawn(shell, ["-l", "-i", "-c", commandFor(token)], {
      stdio: ["ignore", "pipe", "ignore"],
      // Its own session, with no terminal to stop it for reading, and a group to stop it by.
      detached: true,
    });
  } catch (error) {
    log(`could not start the login shell ${shell}: ${String(error)}`);
    return undefined;
  }
  const started = await new Promise<boolean>((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
  if (!started || child.pid === undefined) {
    log(`could not start the login shell ${shell}`);
    return undefined;
  }
  const { pid } = child;

  const { promise: timedOut, resolve: timeOut } = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => timeOut(undefined), timeoutMs);
  const stdout = await Promise.race([readUntilComplete(child.stdout, token), timedOut]);
  clearTimeout(timer);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // It already exited, with nothing left in its group.
  }

  if (stdout === undefined) {
    log(`the login shell ${shell} did not finish in ${timeoutMs}ms; using the app's environment`);
    return undefined;
  }
  const env = parseLoginEnv(stdout, token);
  if (!env) log(`the login shell ${shell} printed no environment; using the app's environment`);
  return env;
}

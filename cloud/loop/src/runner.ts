// The real `Exec`: runs a command with an exact environment, a time limit, and a cap on how much output is kept.

import type { Exec } from "./types.ts";

const MAX_OUTPUT = 200_000;

export const runCommand: Exec = async (argv, { cwd, env, timeoutMs }) => {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("empty command");
  const proc = Bun.spawn([command, ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Its own process group, so a timeout can end what the command started too.
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }, timeoutMs);
  let out = "";
  let err = "";
  const read = async (
    stream: ReadableStream<Uint8Array>,
    into: (text: string) => void,
  ): Promise<void> => {
    let text = "";
    for await (const chunk of stream) {
      text += new TextDecoder().decode(chunk);
      if (text.length > MAX_OUTPUT) text = text.slice(text.length - MAX_OUTPUT);
      into(text);
    }
  };
  try {
    const reading = Promise.all([
      read(proc.stdout, (t) => (out = t)),
      read(proc.stderr, (t) => (err = t)),
    ]);
    await proc.exited;
    // A grandchild that outlives the command may hold the pipes open: wait a moment for the tail, then go on.
    await Promise.race([reading, Bun.sleep(2000)]);
    return { code: proc.exitCode ?? 1, output: `${out}${err}`, timedOut };
  } catch (error) {
    return { code: 127, output: String(error), timedOut };
  } finally {
    clearTimeout(timer);
  }
};

// JSON-RPC 2.0 over a unix socket, one message a line (docs/protocol.md §2, §17).

import { chmodSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { createInterface } from "node:readline";
import { LOOP_PROJECTS_LIST, LOOP_RUNS_LIST } from "@cycle/protocol";
import type { Config } from "./config.ts";
import { projectsList } from "./projects.ts";
import { runsList } from "./runs.ts";

const MAX_PENDING = 32;

type RunsReader = (config: Config) => ReturnType<typeof runsList>;

const reply = (id: unknown, body: object): string =>
  JSON.stringify({ jsonrpc: "2.0", id, ...body });

const answer = async (
  config: Config,
  line: string,
  readRuns: RunsReader,
): Promise<string | undefined> => {
  let message: { id?: unknown; method?: unknown };
  try {
    message = JSON.parse(line) as { id?: unknown; method?: unknown };
    if (typeof message !== "object" || message === null) throw new Error();
  } catch {
    return reply(null, { error: { code: -32700, message: "Parse error" } });
  }
  const id = message.id ?? null;
  // A notification has no id and gets no answer.
  if (message.id === undefined) return undefined;
  try {
    if (message.method === LOOP_PROJECTS_LIST) return reply(id, { result: projectsList(config) });
    if (message.method === LOOP_RUNS_LIST) return reply(id, { result: await readRuns(config) });
    return reply(id, { error: { code: -32601, message: "Method not found" } });
  } catch {
    return reply(id, { error: { code: -32603, message: "Internal error" } });
  }
};

/** Whether something is accepting connections at the path: a server that is running, not a file left by one that died. */
const alive = (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });

export const listen = async (
  config: Config,
  socketPath: string,
  readRuns: RunsReader = runsList,
): Promise<Server> => {
  // A read in progress is never handed to a request that came after it started: such a request waits for one
  // fresh read, which every request that arrives meanwhile shares.
  let running: Promise<unknown> | undefined;
  let next: ReturnType<typeof runsList> | undefined;
  const start = (c: Config): ReturnType<typeof runsList> => {
    const read = readRuns(c);
    const done = read.then(
      () => undefined,
      () => undefined,
    );
    running = done;
    void done.then(() => {
      if (running === done) running = undefined;
    });
    return read;
  };
  const sharedRuns: RunsReader = (c) => {
    if (running === undefined) return start(c);
    if (next === undefined) {
      const after = running;
      next = after.then(() => {
        next = undefined;
        return start(c);
      });
    }
    return next;
  };
  if (await alive(socketPath)) throw new Error("already_running");
  return new Promise((resolve, reject) => {
    rmSync(socketPath, { force: true });
    // Born closed to everyone but its owner: a chmod after listen leaves a moment when it is not.
    const umask = process.umask(0o177);
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("error", () => {});
      // One request at a time per connection, so replies come back in the order asked.
      let queue: Promise<void> = Promise.resolve();
      let pending = 0;
      const lines = createInterface({ input: socket });
      // The client has finished sending: answer what is queued, then close.
      lines.on("close", () => {
        void queue.then(() => socket.end());
      });
      lines.on("line", (line) => {
        if (line.trim() === "" || socket.destroyed) return;
        if (pending >= MAX_PENDING) {
          let id: unknown = null;
          try {
            id = (JSON.parse(line) as { id?: unknown }).id ?? null;
          } catch {}
          socket.write(`${reply(id, { error: { code: -32000, message: "Too many requests" } })}\n`);
          return;
        }
        pending++;
        queue = queue.then(async () => {
          try {
            if (socket.destroyed) return;
            const out = await answer(config, line, sharedRuns);
            if (out !== undefined && !socket.destroyed) socket.write(`${out}\n`);
          } finally {
            pending--;
          }
        });
      });
    });
    server.once("error", reject);
    server.listen(socketPath, () => {
      process.umask(umask);
      chmodSync(socketPath, 0o600);
      resolve(server);
    });
  });
};

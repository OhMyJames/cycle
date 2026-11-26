// JSON-RPC 2.0 over a unix socket, one message a line (docs/protocol.md §2, §17).

import { chmodSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { createInterface } from "node:readline";
import { LOOP_PROJECTS_LIST, LOOP_RUNS_LIST } from "@cycle/protocol";
import type { Config } from "./config.ts";
import { projectsList } from "./projects.ts";
import { runsList } from "./runs.ts";

const answer = async (config: Config, line: string): Promise<string | undefined> => {
  let id: unknown = null;
  try {
    const message = JSON.parse(line) as { id?: unknown; method?: unknown };
    if (typeof message !== "object" || message === null) throw new Error();
    id = message.id ?? null;
    // A notification has no id and gets no answer.
    if (message.id === undefined) return undefined;
    if (message.method === LOOP_PROJECTS_LIST)
      return JSON.stringify({ jsonrpc: "2.0", id, result: projectsList(config) });
    if (message.method === LOOP_RUNS_LIST)
      return JSON.stringify({ jsonrpc: "2.0", id, result: await runsList(config) });
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found" },
    });
  } catch {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32700, message: "Parse error" } });
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

export const listen = async (config: Config, socketPath: string): Promise<Server> => {
  if (await alive(socketPath)) throw new Error("already_running");
  return new Promise((resolve, reject) => {
    rmSync(socketPath, { force: true });
    // Born closed to everyone but its owner: a chmod after listen leaves a moment when it is not.
    const umask = process.umask(0o177);
    const server = createServer((socket) => {
      socket.on("error", () => {});
      createInterface({ input: socket }).on("line", (line) => {
        if (line.trim() === "") return;
        void answer(config, line).then((reply) => {
          if (reply !== undefined) socket.write(`${reply}\n`);
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

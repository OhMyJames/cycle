// JSON-RPC 2.0 over a unix socket, one message a line (docs/protocol.md §2, §17).

import { chmodSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { createInterface } from "node:readline";
import {
  LOOP_EVENTS_LIST,
  LOOP_PROJECTS_LIST,
  LOOP_RUNS_LIST,
  LoopEventsListParamsSchema,
} from "@cycle/protocol";
import type { Config } from "./config.ts";
import { eventsList } from "./events.ts";
import { projectsList } from "./projects.ts";
import { runsList, type StateDirOf } from "./runs.ts";

const answer = async (
  config: Config,
  line: string,
  stateDirOf: StateDirOf,
): Promise<string | undefined> => {
  let id: unknown = null;
  try {
    const message = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof message !== "object" || message === null) throw new Error();
    id = message.id ?? null;
    // A notification has no id and gets no answer.
    if (message.id === undefined) return undefined;
    if (message.method === LOOP_PROJECTS_LIST)
      return JSON.stringify({ jsonrpc: "2.0", id, result: projectsList(config) });
    if (message.method === LOOP_RUNS_LIST) {
      try {
        return JSON.stringify({ jsonrpc: "2.0", id, result: await runsList(config, stateDirOf) });
      } catch {
        return JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: "Internal error" },
        });
      }
    }
    if (message.method === LOOP_EVENTS_LIST) {
      const params = LoopEventsListParamsSchema.safeParse(message.params);
      const fail = (code: number, text: string, reason?: string): string =>
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code, message: text, ...(reason ? { data: { reason } } : {}) },
        });
      if (!params.success || !config.projects.some((p) => p.projectKey === params.data.projectKey))
        return fail(-32602, "Invalid params");
      const { projectKey, afterSeq, limit } = params.data;
      try {
        const result = await eventsList(projectKey, stateDirOf(projectKey), afterSeq, limit);
        return JSON.stringify({ jsonrpc: "2.0", id, result });
      } catch (error) {
        return (error as Error).message === "seq_ahead"
          ? fail(-32602, "Invalid params", "seq_ahead")
          : fail(-32603, "Internal error");
      }
    }
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

export const listen = async (
  config: Config,
  socketPath: string,
  stateDirOf: StateDirOf = () => undefined,
): Promise<Server> => {
  if (await alive(socketPath)) throw new Error("already_running");
  return new Promise((resolve, reject) => {
    rmSync(socketPath, { force: true });
    // Born closed to everyone but its owner: a chmod after listen leaves a moment when it is not.
    const umask = process.umask(0o177);
    const server = createServer((socket) => {
      socket.on("error", () => {});
      createInterface({ input: socket }).on("line", (line) => {
        if (line.trim() === "") return;
        void answer(config, line, stateDirOf).then((reply) => {
          if (reply !== undefined && !socket.destroyed) socket.write(`${reply}\n`);
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

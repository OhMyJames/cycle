// JSON-RPC 2.0 over a unix socket, one message a line (docs/protocol.md §2, §17).

import { chmodSync, rmSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import {
  LOOP_API_PROJECTS_LIST,
  LOOP_EVENTS_LIST,
  LOOP_MAX_LINE_BYTES,
  LOOP_PROJECTS_LIST,
  LOOP_RUNS_LIST,
  LoopEventsListParamsSchema,
} from "@cycle/protocol/loop";
import { ApiError, type LoopApi, LoopApiHandler } from "./api.ts";
import type { Config } from "./config.ts";
import { eventsList } from "./events.ts";
import { projectsList } from "./projects.ts";
import { runsList, type StateDirOf } from "./runs.ts";

const answer = async (
  config: Config,
  line: string,
  stateDirOf: StateDirOf,
  api: LoopApiHandler | undefined,
): Promise<string | undefined> => {
  let id: unknown = null;
  try {
    const message = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof message !== "object" || message === null) throw new Error();
    id = message.id ?? null;
    // A notification has no id and gets no answer.
    if (message.id === undefined) return undefined;
    if (message.method === LOOP_PROJECTS_LIST || message.method === LOOP_API_PROJECTS_LIST)
      return JSON.stringify({ jsonrpc: "2.0", id, result: projectsList(config) });
    if (
      api !== undefined &&
      typeof message.method === "string" &&
      LoopApiHandler.handles(message.method)
    ) {
      try {
        return JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: await api.call(message.method, message.params),
        });
      } catch (error) {
        return JSON.stringify({
          jsonrpc: "2.0",
          id,
          error:
            error instanceof ApiError
              ? {
                  code: error.code,
                  message: error.message,
                  ...(error.reason ? { data: { reason: error.reason } } : {}),
                }
              : { code: -32603, message: "Internal error" },
        });
      }
    }
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
  loopApi?: LoopApi,
): Promise<Server> => {
  const api = loopApi === undefined ? undefined : new LoopApiHandler(loopApi);
  if (await alive(socketPath)) throw new Error("already_running");
  return new Promise((resolve, reject) => {
    rmSync(socketPath, { force: true });
    // Born closed to everyone but its owner: a chmod after listen leaves a moment when it is not.
    const umask = process.umask(0o177);
    const server = createServer((socket) => {
      socket.on("error", () => {});
      // Lines are cut here, not by readline: one that grows past the limit without a newline closes the connection
      // before it is held in memory.
      let pending: Buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        for (;;) {
          const end = pending.indexOf(0x0a);
          if (end === -1) break;
          if (end > LOOP_MAX_LINE_BYTES) return socket.destroy();
          const line = pending.subarray(0, end).toString("utf8").replace(/\r$/, "");
          pending = pending.subarray(end + 1);
          if (line.trim() === "") continue;
          void answer(config, line, stateDirOf, api).then((reply) => {
            if (reply !== undefined && !socket.destroyed) socket.write(`${reply}\n`);
          });
        }
        if (pending.length > LOOP_MAX_LINE_BYTES) socket.destroy();
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

// The read-only export an operator session reads (CYC-486): the Loop API's JSON for one Project, written under
// `<stateDir>/operator-export/` at every wake. The session gets this directory as a read root and nothing else of
// the state directory, so it never sees `loop.db`, `.env` files or the lock.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOOP_API_RUNS_LIST, LOOP_BOARD_GET, LOOP_NOTICES_LIST } from "@cycle/protocol/loop";
import type { LoopApiHandler, ProjectApi } from "../api.ts";

export const EXPORT_DIR = "operator-export";
/** A run key is a tracker key: letters, digits and dashes. Anything else would be a path. */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

export const exportDirOf = (stateDir: string): string => join(stateDir, EXPORT_DIR);

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Writes board, runs, notices and the events of `runKeys`; returns the directory. Each wake starts from an empty one. */
export const writeExport = async (o: {
  handler: LoopApiHandler;
  project: ProjectApi;
  stateDir: string;
  runKeys: string[];
  events: { run: string }[];
}): Promise<string> => {
  const dir = exportDirOf(o.stateDir);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "events"), { recursive: true });
  const params = { project: o.project.projectKey };
  // A part that cannot be read says so in its file; the session still gets the others.
  const part = async (file: string, method: string) => {
    let body: unknown;
    try {
      body = await o.handler.call(method, params);
    } catch (error) {
      body = {
        error:
          error instanceof Error
            ? ((error as { reason?: string }).reason ?? error.message)
            : "failed",
      };
    }
    await writeFile(join(dir, file), json(body));
  };
  await part("board.json", LOOP_BOARD_GET);
  await part("runs.json", LOOP_API_RUNS_LIST);
  await part("notices.json", LOOP_NOTICES_LIST);
  for (const key of new Set(o.runKeys)) {
    if (!SAFE_KEY.test(key)) continue;
    await writeFile(
      join(dir, "events", `${key}.json`),
      json(o.events.filter((e) => e.run === key)),
    );
  }
  return dir;
};

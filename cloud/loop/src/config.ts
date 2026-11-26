// The Loop server's configuration: which Projects it serves and the token each one needs. The file holds tokens, so it
// is refused unless only its owner can read it (docs/protocol.md §17).

import { realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { LoopForgeSchema } from "@cycle/protocol";
import { z } from "zod";

/** The real path where the directory exists (symlinks followed), else the absolute path. */
const realOrResolved = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export const ConfigSchema = z.object({
  projects: z
    .array(
      z.object({
        name: z.string().min(1),
        projectKey: z.string().min(1),
        repo: z.object({ url: z.string().min(1), forge: LoopForgeSchema }),
        token: z.string().min(1),
        /** Where this Project's runs are kept (`<stateDir>/runs/<KEY>/run.json`). Never sent to a client. */
        stateDir: z
          .string()
          .refine((v) => isAbsolute(v), "stateDir must be an absolute path")
          .optional(),
      }),
    )
    .refine(
      (projects) => new Set(projects.map((p) => p.projectKey)).size === projects.length,
      "projectKey must be unique",
    )
    .refine((projects) => {
      const dirs = projects.flatMap((p) =>
        p.stateDir === undefined ? [] : [realOrResolved(p.stateDir)],
      );
      // No two the same place, and none inside another (they would read each other's runs).
      return dirs.every((a, i) =>
        dirs.every((b, j) => i === j || (a !== b && !a.startsWith(b + sep))),
      );
    }, "stateDir must be unique and not nested"),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Why the server cannot start: a fixed word, never the path or anything in the file. */
export class ConfigError extends Error {
  constructor(readonly reason: "config_missing" | "config_mode" | "config_invalid") {
    super(reason);
  }
}

export const loadConfig = async (path: string): Promise<Config> => {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new ConfigError("config_missing");
  }
  if ((mode & 0o077) !== 0) throw new ConfigError("config_mode");
  try {
    return ConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new ConfigError("config_invalid");
  }
};

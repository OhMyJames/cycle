// The Loop server's configuration: which Projects it serves and the token each one needs. The file holds tokens, so it
// is refused unless only its owner can read it (docs/protocol.md §17).

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { LoopForgeSchema } from "@cycle/protocol/loop";
import { z } from "zod";

export const ConfigSchema = z.object({
  projects: z
    .array(
      z.object({
        name: z.string().min(1),
        projectKey: z.string().min(1),
        repo: z.object({ url: z.string().min(1), forge: LoopForgeSchema }),
        token: z.string().min(1),
      }),
    )
    .refine(
      (projects) => new Set(projects.map((p) => p.projectKey)).size === projects.length,
      "projectKey must be unique",
    ),
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

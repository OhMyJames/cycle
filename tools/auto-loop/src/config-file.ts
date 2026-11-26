// The loop's per-Project configuration file (CYC-392). It replaces the AUTO_LOOP_* environment variables: which
// repository, which itsaplan project, where the state and the lock live. It holds the tracker key, so it is written
// with mode 0600 and refused when others can read it. Columns, labels and type ids are not here: they are resolved
// from the tracker at start (project.ts).

import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const text = z.string().trim().min(1);
const agent = z.string().trim().min(1);

export const ConfigFileSchema = z.object({
  /** Absolute path of the repository the Project's work happens in. */
  repoRoot: text,
  /** itsaplan project key, e.g. `CYC`, or `<team>.KEY` when the bare key is ambiguous. */
  projectKey: text,
  /** Where runs, events and the lock live. One directory per Project. */
  stateDir: text,
  /** itsaplan key. Only the loop holds it. */
  planKey: text,
  planUrl: text.default("https://plan.ops.shrimpdot.ai/api/mcp"),
  /** Names looked up in `get_project`. */
  autoLabel: text.default("auto"),
  featureType: text.default("Feature"),
  bugType: text.default("Bug"),
  devAgent: agent.optional(),
  qaAgent: agent.optional(),
  reviewAgent: agent.optional(),
  /** Workers for this Project (CYC-433); `--workers` overrides it. */
  workers: z.number().int().positive().optional(),
});
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

const REQUIRED = ["repoRoot", "projectKey", "stateDir", "planKey"] as const;

export const parseConfigFile = (raw: string, source = "config"): ConfigFile => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${source}: not valid JSON`);
  }
  const body = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const missing = REQUIRED.filter((name) => {
    const v = body[name];
    return typeof v !== "string" || v.trim() === "";
  });
  if (missing.length > 0) throw new Error(`${source}: missing required ${missing.join(", ")}`);
  const parsed = ConfigFileSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${source}: invalid ${issue?.path.join(".") ?? "value"}: ${issue?.message}`);
  }
  for (const name of ["repoRoot", "stateDir"] as const) {
    if (!isAbsolute(parsed.data[name]))
      throw new Error(`${source}: ${name} must be an absolute path`);
  }
  return {
    ...parsed.data,
    repoRoot: resolve(parsed.data.repoRoot),
    stateDir: resolve(parsed.data.stateDir),
  };
};

/**
 * A file lists Projects as `{ "projects": [ {...}, {...} ] }`; a file that is one Project's fields (CYC-392) still
 * works and means a list of one. Two Projects must not share a stateDir: they would share runs and the lock.
 */
export const parseConfigFiles = (raw: string, source = "config"): ConfigFile[] => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${source}: not valid JSON`);
  }
  const list = (json as { projects?: unknown } | null)?.projects;
  if (list === undefined) return [parseConfigFile(raw, source)];
  if (!Array.isArray(list) || list.length === 0)
    throw new Error(`${source}: projects must be a non-empty list`);
  const projects = list.map((item, at) =>
    parseConfigFile(JSON.stringify(item), `${source}: projects[${at}]`),
  );
  const seen = new Map<string, string>();
  for (const p of projects) {
    const other = seen.get(p.stateDir);
    if (other !== undefined)
      throw new Error(
        `${source}: projects ${other} and ${p.projectKey} share stateDir ${p.stateDir}; each Project needs its own`,
      );
    seen.set(p.stateDir, p.projectKey);
  }
  return projects;
};

/** Reads the file; refuses one that group or others can read, because it holds the tracker key. */
export const loadConfigFiles = async (path: string): Promise<ConfigFile[]> => {
  const info = await stat(path).catch(() => {
    throw new Error(`config file not found: ${path}`);
  });
  if ((info.mode & 0o077) !== 0)
    throw new Error(
      `${path}: permissions ${(info.mode & 0o777).toString(8)} are too open, run chmod 600`,
    );
  return parseConfigFiles(await readFile(path, "utf8"), path);
};

export const loadConfigFile = async (path: string): Promise<ConfigFile> => {
  const [first] = await loadConfigFiles(path);
  if (first === undefined) throw new Error(`${path}: no project`);
  return first;
};

/** Validates, then writes with mode 0600 (also when the file already existed with a wider mode). */
export const writeConfigFile = async (path: string, config: z.input<typeof ConfigFileSchema>) => {
  const valid = parseConfigFile(JSON.stringify(config), path);
  await writeFile(path, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
};

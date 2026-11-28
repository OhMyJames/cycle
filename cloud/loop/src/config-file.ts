// The loop's per-Project configuration file (CYC-392). It replaces the AUTO_LOOP_* environment variables: which
// repository, which itsaplan project, where the state and the lock live. It holds the tracker key, so it is written
// with mode 0600 and refused when others can read it. Columns, labels and type ids are not here: they are resolved
// from the tracker at start (project.ts).

import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "./types.ts";

const text = z.string().trim().min(1);
const agent = z.string().trim().min(1);

const whole = (min: number, max: number) => z.number().int().min(min).max(max);

/**
 * Counts and durations the loop uses (CYC-441). Every field is optional; one that is not written keeps its default
 * (`defaultConfig`). The unit is in the name. A `tuning` with any bad field is not used at all.
 */
export const TuningSchema = z
  .object({
    intervalSeconds: whole(1, 3600),
    maxCriteria: whole(1, 20),
    maxFixRounds: whole(1, 10),
    maxCiRetries: whole(0, 10),
    maxReviewRetries: whole(0, 10),
    maxInterruptRetries: whole(0, 10),
    maxQaRetries: whole(0, 10),
    maxNetworkRetries: whole(0, 10),
    networkRetryDelaysSeconds: z.array(whole(1, 600)).min(1).max(10),
    ciPollIntervalSeconds: whole(5, 600),
    ciTimeoutMinutes: whole(1, 240),
    mergePollIntervalSeconds: whole(5, 600),
    mergeTimeoutMinutes: whole(1, 240),
    turnTimeoutMinutes: whole(1, 240),
    commandTimeoutMinutes: whole(1, 240),
    trackerTimeoutSeconds: whole(5, 120),
    releaseNodeModules: z.boolean(),
    blockedReminderDays: whole(0, 365),
  })
  .partial()
  .strict();
export type Tuning = z.infer<typeof TuningSchema>;

/** The `Config` fields a `tuning` sets; only the ones that are written. */
export const tuningToConfig = (t: Tuning): Partial<Config> => {
  const out: Partial<Config> = {};
  for (const name of [
    "maxCriteria",
    "maxFixRounds",
    "maxCiRetries",
    "maxReviewRetries",
    "maxInterruptRetries",
    "maxQaRetries",
    "maxNetworkRetries",
    "blockedReminderDays",
  ] as const) {
    if (t[name] !== undefined) out[name] = t[name];
  }
  if (t.releaseNodeModules !== undefined) out.releaseNodeModules = t.releaseNodeModules;
  if (t.networkRetryDelaysSeconds !== undefined)
    out.networkRetryDelaysMs = t.networkRetryDelaysSeconds.map((n) => n * 1000);
  if (t.ciPollIntervalSeconds !== undefined) out.ciPollIntervalMs = t.ciPollIntervalSeconds * 1000;
  if (t.ciTimeoutMinutes !== undefined) out.ciTimeoutMs = t.ciTimeoutMinutes * 60_000;
  if (t.mergePollIntervalSeconds !== undefined)
    out.mergePollIntervalMs = t.mergePollIntervalSeconds * 1000;
  if (t.mergeTimeoutMinutes !== undefined) out.mergeTimeoutMs = t.mergeTimeoutMinutes * 60_000;
  if (t.turnTimeoutMinutes !== undefined) out.turnTimeoutMs = t.turnTimeoutMinutes * 60_000;
  if (t.commandTimeoutMinutes !== undefined)
    out.commandTimeoutMs = t.commandTimeoutMinutes * 60_000;
  return out;
};

/**
 * Research work items for this Project (CYC-447). Left out, or `enabled: false`, means off. `type` and `folder` are
 * names looked up in the tracker; `readRoots` are directories a research session may read (default: `repoRoot`).
 */
export const ResearchSchema = z
  .object({
    enabled: z.boolean(),
    type: text.default("Research"),
    folder: text.default("调研"),
    readRoots: z.array(text).min(1).optional(),
    maxFollowups: whole(0, 20).default(5),
  })
  .strict();

/**
 * The planning node for this Project (CYC-322): when the Todo column has nothing to take, it refills it from Backlog.
 * Left out, or `enabled: false` (the default), means off. The labels are names looked up in the tracker.
 */
export const PlanningSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** On a work item the planner has rewritten or split, waiting for a person to approve it. */
    pending: text.default("待批准"),
    /** On a work item the planner asked a question about, waiting for an answer. */
    awaitingAnswer: text.default("待回答"),
    /** Put on by a person: the planner leaves the work item alone. */
    skip: text.default("Loop 跳过"),
    /** Put on by a person: the work item goes through the full process (four documents), never the planner. */
    fullProcess: text.default("完整流程"),
    maxPending: whole(1, 50).default(5),
    intervalMinutes: whole(1, 1440).default(30),
    maxSplit: whole(2, 10).default(4),
    /** Minutes between two looks at the Backlog for a change, across the Project's workers. Left out means 5. */
    checkMinutes: whole(1, 60).optional(),
    /** Most work items one round asks a person about (questions in a comment, 待回答). Left out means 3. */
    maxAsk: whole(0, 20).optional(),
  })
  .strict();
export type PlanningFile = z.infer<typeof PlanningSchema>;

/**
 * Review of pull requests a person opened (CYC-540). Left out, or `enabled: false` (the default), means off: the loop
 * does not even read the pull requests.
 */
export const PrReviewSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxReviewsPerPr: whole(1, 50).default(5),
  })
  .strict();

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
  /** Model and thinking effort per role; left out means the agent's own default. */
  devModel: text.optional(),
  qaModel: text.optional(),
  reviewModel: text.optional(),
  devEffort: text.optional(),
  qaEffort: text.optional(),
  reviewEffort: text.optional(),
  /** Workers for this Project (CYC-433); `--workers` overrides it. */
  workers: z.number().int().positive().optional(),
  /** Optional repository metadata from loop.json (used for delivery.git and `gh --repo`, CYC-478). */
  repo: z
    .object({
      url: text,
      forge: z.enum(["github", "gitlab"]).optional(),
    })
    .optional(),
  /** Counts, timeouts and the idle interval (CYC-441). Read again before every step while the loop runs. */
  tuning: TuningSchema.optional(),
  research: ResearchSchema.optional(),
  planning: PlanningSchema.optional(),
  prReview: PrReviewSchema.optional(),
});
/** As parsed: a research section always has its `readRoots`, absolute and with `~` expanded. */
export type ConfigFile = Omit<z.infer<typeof ConfigFileSchema>, "research"> & {
  research?: z.infer<typeof ResearchSchema> & { readRoots: string[] };
};

/** `~` and `~/x` are the home directory; anything else is taken as written. */
const expandHome = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

/** `invalid tuning.maxFixRounds: ...` for every bad field, so a person sees all of them at once. */
const describeIssues = (error: z.ZodError): string =>
  error.issues
    .map(
      (i) =>
        `invalid ${["tuning", ...i.path.filter((p) => p !== "tuning")].join(".")}: ${i.message}`,
    )
    .join("; ");

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
    if (issue?.path[0] === "tuning") throw new Error(`${source}: ${describeIssues(parsed.error)}`);
    throw new Error(`${source}: invalid ${issue?.path.join(".") ?? "value"}: ${issue?.message}`);
  }
  for (const name of ["repoRoot", "stateDir"] as const) {
    if (!isAbsolute(parsed.data[name]))
      throw new Error(`${source}: ${name} must be an absolute path`);
  }
  const repoRoot = resolve(parsed.data.repoRoot);
  const { research, ...rest } = parsed.data;
  const readRoots = (research?.readRoots ?? [repoRoot]).map((root) => {
    const path = expandHome(root);
    if (!isAbsolute(path))
      throw new Error(`${source}: research.readRoots must be absolute paths (got ${root})`);
    return resolve(path);
  });
  return {
    ...rest,
    repoRoot,
    stateDir: resolve(parsed.data.stateDir),
    ...(research !== undefined ? { research: { ...research, readRoots } } : {}),
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

/**
 * One Project's `tuning`, read from the file now. Only this Project's `tuning` is checked: the rest of the file is
 * not looked at, so a change elsewhere cannot stop a running loop. Throws when the file cannot be read, the Project
 * is not in it, or the `tuning` has a bad field (the message names the field).
 */
export const readTuning = async (path: string, projectKey: string): Promise<Tuning> => {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path}: cannot be read (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const list = (json as { projects?: unknown } | null)?.projects;
  const entries = list === undefined ? [json] : Array.isArray(list) ? list : [];
  const mine = entries.find(
    (e) => (e as { projectKey?: unknown } | null)?.projectKey === projectKey,
  ) as { tuning?: unknown } | undefined;
  if (mine === undefined) throw new Error(`${path}: Project ${projectKey} not found`);
  if (mine.tuning === undefined) return {};
  const parsed = TuningSchema.safeParse(mine.tuning);
  if (!parsed.success) throw new Error(`${path}: ${describeIssues(parsed.error)}`);
  return parsed.data;
};

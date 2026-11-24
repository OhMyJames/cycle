// agy's plan usage (CYC-298): `agy -p "/usage" --output-format json` answers with the account's limits without a turn
// (`usage` tokens all 0), told on as Cycle's `_cycle/plan_usage` (docs/protocol.md §8 "套餐用量"). Seen on agy 1.5.16:
// `command.data.groups[]` (a model group each) → `buckets[]` with `window` (`5h` | `weekly`), `remaining_fraction` and
// `reset_time`. An API-key login has no limits to tell.

/** The `session/update` variant the daemon takes plan usage in. Same as `PLAN_USAGE_UPDATE` of `@cycle/protocol`. */
export const PLAN_USAGE_UPDATE = "_cycle/plan_usage";

export type PlanWindow = {
  kind: string;
  /** The share used, from 0. */
  utilization: number;
  /** In milliseconds since the epoch. */
  resetsAt: number;
  status: "allowed" | "rejected";
};

/**
 * The windows `/usage` stands for. The Gemini models' limits are the plan's own (`five_hour`, `seven_day`); the other
 * group (Claude and GPT) shares its names with an `_other` suffix.
 */
export const planWindowsOf = (output: string): PlanWindow[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return [];
  }
  const result = parsed as {
    status?: unknown;
    command?: { data?: { groups?: unknown } };
  } | null;
  if (result?.status !== "SUCCESS") return [];
  const groups = result.command?.data?.groups;
  if (!Array.isArray(groups)) return [];
  const windows: PlanWindow[] = [];
  for (const group of groups as Array<{ name?: unknown; buckets?: unknown }>) {
    const suffix = typeof group?.name === "string" && /gemini/i.test(group.name) ? "" : "_other";
    if (!Array.isArray(group?.buckets)) continue;
    for (const bucket of group.buckets as Array<Record<string, unknown>>) {
      const base =
        bucket.window === "5h" ? "five_hour" : bucket.window === "weekly" ? "seven_day" : "";
      const remaining = bucket.remaining_fraction;
      const resets =
        typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : Number.NaN;
      if (base === "" || typeof remaining !== "number" || !Number.isFinite(remaining)) continue;
      if (!Number.isFinite(resets) || resets <= 0) continue;
      const utilization = Math.round(Math.min(1, Math.max(0, 1 - remaining)) * 10_000) / 10_000;
      const kind = `${base}${suffix}`;
      // A second group by the same name would show twice under one label: the first stands.
      if (windows.some((w) => w.kind === kind)) continue;
      windows.push({
        kind,
        utilization,
        resetsAt: resets,
        status: utilization >= 1 ? "rejected" : "allowed",
      });
    }
  }
  return windows;
};

/** An API-key login has no plan: the variables agy takes a key from. */
export const usesApiKey = (env: Record<string, string>): boolean =>
  Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);

const MIN_INTERVAL_MS = 5 * 60_000;
const TIMEOUT_MS = 20_000;

/**
 * Reads the plan usage at most every five minutes and tells it through the session that asked: a side process that
 * opens no turn and costs no quota. Never throws; a read that failed is tried again at the next ask. Told every time
 * it is read (the daemon keeps the newest), so a session opened later hears it too.
 */
export class PlanUsageReader<S = undefined> {
  #last = 0;
  #running = false;

  constructor(
    private readonly options: {
      executable: string;
      env: Record<string, string>;
      tell: (windows: PlanWindow[], session: S) => void;
      run?: (executable: string, env: Record<string, string>) => Promise<string>;
      now?: () => number;
    },
  ) {}

  async poll(session: S): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    if (this.#running || now - this.#last < MIN_INTERVAL_MS) return;
    if (usesApiKey(this.options.env)) return;
    this.#running = true;
    try {
      const output = await (this.options.run ?? runUsage)(
        this.options.executable,
        this.options.env,
      );
      const windows = planWindowsOf(output);
      if (windows.length > 0) {
        this.#last = now;
        this.options.tell(windows, session);
      }
    } catch {
      // Not told: the next ask tries again.
    } finally {
      this.#running = false;
    }
  }
}

const runUsage = async (executable: string, env: Record<string, string>): Promise<string> => {
  const child = Bun.spawn([executable, "-p", "/usage", "--output-format", "json"], {
    env,
    ...(env.HOME !== undefined ? { cwd: env.HOME } : {}),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("");
    }, TIMEOUT_MS);
  });
  try {
    return await Promise.race([new Response(child.stdout).text(), expired]);
  } finally {
    clearTimeout(timer);
  }
};

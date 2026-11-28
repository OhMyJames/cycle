import { openStore } from "./db/store.ts";
import type { LoopEvent } from "./store.ts";

export type Stats = {
  /** Dev runs (Feature, Bug). Every metric below is over these alone, except `researched` and `permissions`. */
  runs: number;
  /** Research runs that were published and moved to Done (`researched`, CYC-447). */
  researched: number;
  /** Runs with a `delivered` event, however it was delivered: auto-merged, escalated to a person, review system failure, auto-merge failed to enable, or merged outside the Loop. */
  delivered: number;
  /** Runs where the Loop itself enabled auto-merge and confirmed the merge (`delivered` with `autoMerge: true`), whether or not a person helped. */
  autoMerged: number;
  /** Auto-merged with no person's help (no permission_pending, blocked or resumed), out of the runs that were started. Escalations and outside merges do not count. */
  autonomousCompletionRate: number;
  /** Runs where a person had to step in (a waiting permission, a block, a resume), out of the runs started. */
  interventionRate: number;
  /** Runs that needed at least one fix round, out of the runs that reached a check. */
  reworkRate: number;
  /** Out of the runs started: delivered with `autoMerge: true` and no intervention (permission_pending, blocked, resumed) and no failure or rework (round_failed, ci_failed) at any point. */
  firstPassRate: number;
  /** Each `round_failed`, classed by the event just before it in its run (verify, qa_turn → qa, ci_failed → ci, review_decided → review, anything else → other): `events` is the count, `runs` the distinct runs with at least one. */
  reworkByStage: Record<ReworkStage, { events: number; runs: number }>;
  /** Milliseconds from the first `claimed` to the first `delivered` of each delivered run (never below 0), nearest-rank percentiles (the value at rank ceil(p·n) of the sorted list). `null` when no run was delivered. Includes time a run was blocked; for a run not auto-merged, `delivered` is written when the pull request opens, for an auto-merged one after the merge. */
  durationMs: { median: number | null; p90: number | null };
  /** When each delivered run's pull request was opened: its review time is the time from here to its merge. */
  delivery: { run: string; at: string; prUrl: string }[];
  /** The requests the Loop left to a person or refused, by kind and command prefix: the ones a person allowed most first, at most 10 (CYC-423). Empty when there are none. */
  permissions: PermissionRow[];
  /** Times a Dev session asked a person to decide (`dev_asked`, CYC-494), and the runs that asked. */
  devAsked: { asked: number; runs: number };
  /** Supervisor metrics (CYC-484, CYC-485): Work loop restarts, stuck escalations, and completed self-updates. */
  restarts: number;
  stuck: number;
  selfUpdates: number;
  /** The planning node (CYC-322), counted apart: its rounds are not runs and are in none of the numbers above. */
  planning: PlanningStats;
};

export type PlanningStats = {
  /** Rounds started (`plan_started`), and those that ended because triage could not be used. */
  rounds: number;
  triageStopped: number;
  /** Triage's categories over every round (`plan_triaged`): 能做, 要问, 要拆, 不适合. */
  categories: { can: number; ask: number; split: number; unfit: number };
  priorityChanged: number;
  /** Work items asked about, by triage or by shaping (`plan_asked`). */
  asked: number;
  /** Work items shaped and written back (`plan_shaped`), stopped (`plan_shape_stopped`), left alone (`plan_abandoned`). */
  shaped: number;
  stopped: number;
  abandoned: number;
  /** Fix rounds per shaped work item, on average; null when none was shaped. */
  meanFixRounds: number | null;
  /**
   * Of the work items the planner left waiting for approval (each part of a split counts), the share a dev run later
   * claimed. From the events alone: a dev run claims only a work item a person put in Todo with `auto`, so a claim
   * is the approval as the loop sees it; one approved and not yet claimed counts as not approved yet.
   */
  approvalRate: number;
};

const planningStats = (events: LoopEvent[]): PlanningStats => {
  const of = (kind: string) => events.filter((e) => e.kind === kind);
  const triaged = of("plan_triaged");
  const sum = (field: string) => triaged.reduce((n, e) => n + Number(e[field] ?? 0), 0);
  const shaped = of("plan_shaped");
  const offered = shaped.flatMap((e) =>
    String(e.keys ?? e.issue ?? "")
      .split(",")
      .filter((k) => k !== "")
      .map((key) => ({ key, ts: e.ts })),
  );
  const approved = offered.filter(({ key, ts }) =>
    events.some((e) => e.run === key && e.kind === "claimed" && e.ts >= ts),
  ).length;
  return {
    rounds: of("plan_started").length,
    triageStopped: of("plan_finished").filter((e) => e.outcome === "triage_stopped").length,
    categories: { can: sum("can"), ask: sum("ask"), split: sum("split"), unfit: sum("unfit") },
    priorityChanged: of("plan_priority_changed").length,
    asked: of("plan_asked").length,
    shaped: shaped.length,
    stopped: of("plan_shape_stopped").length,
    abandoned: of("plan_abandoned").length,
    meanFixRounds:
      shaped.length === 0
        ? null
        : shaped.reduce((n, e) => n + Number(e.rounds ?? 0), 0) / shaped.length,
    approvalRate: rate(approved, offered.length),
  };
};

export type ReworkStage = "verify" | "qa" | "ci" | "review" | "other";

const STAGE_OF: Record<string, ReworkStage> = {
  verify: "verify",
  qa_turn: "qa",
  ci_failed: "ci",
  review_decided: "review",
};

const FAILURES = new Set(["round_failed", "ci_failed"]);

/** Nearest-rank percentile of an ascending list; `null` when empty. */
const percentile = (sorted: number[], p: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null);

export type PermissionRow = {
  kind: string;
  /** The first two words of a command ("git mv"); absent for requests that are not commands. */
  command?: string;
  /** Times the request was left for a person (`ask`) or refused by the policy (`deny`). */
  requested: number;
  /** Times a person allowed it in the app. */
  allowed: number;
  /** Times a person refused it in the app. */
  denied: number;
};

const PERMISSION_ROWS = 10;

const permissionRows = (events: LoopEvent[]): PermissionRow[] => {
  const rows = new Map<string, PermissionRow>();
  for (const event of events) {
    if (event.kind !== "permission_requested" && event.kind !== "permission_answered") continue;
    if (event.decision === "allow") continue;
    const kind = String(event.tool ?? "other");
    const command = typeof event.command === "string" ? event.command : undefined;
    const key = `${kind}\0${command ?? ""}`;
    let row = rows.get(key);
    if (row === undefined) {
      row = {
        kind,
        ...(command !== undefined ? { command } : {}),
        requested: 0,
        allowed: 0,
        denied: 0,
      };
      rows.set(key, row);
    }
    if (event.kind === "permission_requested") row.requested++;
    else if (event.answer === "allow") row.allowed++;
    else if (event.answer === "deny") row.denied++;
  }
  return Array.from(rows.values())
    .sort(
      (a, b) =>
        b.allowed - a.allowed ||
        b.requested - a.requested ||
        a.kind.localeCompare(b.kind) ||
        (a.command ?? "").localeCompare(b.command ?? ""),
    )
    .slice(0, PERMISSION_ROWS);
};

const INTERVENTIONS = new Set(["permission_pending", "blocked", "resumed"]);

const rate = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

/**
 * A run's kind is in its first `claimed` event, as `runKind` (`kind` is the event's own name); one from before
 * research runs has none and is a dev run.
 */
const isResearch = (list: LoopEvent[]): boolean =>
  ["research", "design"].includes(String(list.find((e) => e.kind === "claimed")?.runKind));

/** The metrics of the initiative, from the event log (docs: cloud/loop/README.md). */
export const computeStats = (events: LoopEvent[]): Stats => {
  const all = new Map<string, LoopEvent[]>();
  for (const event of events) {
    const list = all.get(event.run) ?? [];
    list.push(event);
    all.set(event.run, list);
  }
  const byRun = new Map<string, LoopEvent[]>();
  let researched = 0;
  for (const [run, list] of all) {
    if (!isResearch(list)) byRun.set(run, list);
    else if (list.some((e) => e.kind === "researched")) researched++;
  }
  let delivered = 0;
  let autonomous = 0;
  let autoMerged = 0;
  let intervened = 0;
  let checked = 0;
  let reworked = 0;
  let firstPass = 0;
  const reworkByStage: Stats["reworkByStage"] = {
    verify: { events: 0, runs: 0 },
    qa: { events: 0, runs: 0 },
    ci: { events: 0, runs: 0 },
    review: { events: 0, runs: 0 },
    other: { events: 0, runs: 0 },
  };
  const durations: number[] = [];
  const delivery: Stats["delivery"] = [];
  for (const [run, list] of byRun) {
    if (!list.some((e) => e.kind === "claimed")) continue;
    const helped = list.some((e) => INTERVENTIONS.has(e.kind));
    const done = list.find((e) => e.kind === "delivered");
    if (helped) intervened++;
    const seen = new Set<ReworkStage>();
    list.forEach((e, i) => {
      if (e.kind !== "round_failed") return;
      const stage = STAGE_OF[list[i - 1]?.kind ?? ""] ?? "other";
      reworkByStage[stage].events++;
      seen.add(stage);
    });
    for (const stage of seen) reworkByStage[stage].runs++;
    if (done !== undefined) {
      const ms = Date.parse(done.ts) - Date.parse(list.find((e) => e.kind === "claimed")?.ts ?? "");
      if (Number.isFinite(ms)) durations.push(Math.max(0, ms));
      if (done.autoMerge === true && !helped && !list.some((e) => FAILURES.has(e.kind)))
        firstPass++;
      delivered++;
      if (done.autoMerge === true) {
        autoMerged++;
        if (!helped) autonomous++;
      }
      delivery.push({ run, at: done.ts, prUrl: String(done.prUrl ?? "") });
    }
    if (list.some((e) => e.kind === "verify")) {
      checked++;
      if (list.some((e) => e.kind === "round_failed")) reworked++;
    }
  }
  const runs = Array.from(byRun.values()).filter((l) => l.some((e) => e.kind === "claimed")).length;
  const sortedDurations = [...durations].sort((a, b) => a - b);
  return {
    runs,
    researched,
    delivered,
    autoMerged,
    autonomousCompletionRate: rate(autonomous, runs),
    interventionRate: rate(intervened, runs),
    reworkRate: rate(reworked, checked),
    firstPassRate: rate(firstPass, runs),
    reworkByStage,
    durationMs: {
      median: percentile(sortedDurations, 0.5),
      p90: percentile(sortedDurations, 0.9),
    },
    delivery,
    permissions: permissionRows(events),
    planning: planningStats(events),
    devAsked: {
      asked: Array.from(byRun.values()).reduce(
        (n, l) => n + l.filter((e) => e.kind === "dev_asked").length,
        0,
      ),
      runs: Array.from(byRun.values()).filter((l) => l.some((e) => e.kind === "dev_asked")).length,
    },
    restarts: events.filter((e) => e.kind === "supervisor_restart").length,
    stuck: events.filter((e) => e.kind === "stuck_escalated").length,
    selfUpdates: events.filter((e) => e.kind === "self_updated").length,
  };
};

/** The stats of a state directory: from `loop.db` where there is one, otherwise from the files. */
export const readStats = async (stateDir: string, now: () => Date): Promise<Stats> =>
  computeStats(await openStore(stateDir, now).events());

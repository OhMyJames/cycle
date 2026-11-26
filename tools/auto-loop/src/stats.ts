import type { LoopEvent } from "./store.ts";

export type Stats = {
  runs: number;
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
  /** When each delivered run's pull request was opened: its review time is the time from here to its merge. */
  delivery: { run: string; at: string; prUrl: string }[];
  /** The requests the Loop left to a person or refused, by kind and command prefix: the ones a person allowed most first, at most 10 (CYC-423). Empty when there are none. */
  permissions: PermissionRow[];
};

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

/** The metrics of the initiative, from the event log (docs: tools/auto-loop/README.md). */
export const computeStats = (events: LoopEvent[]): Stats => {
  const byRun = new Map<string, LoopEvent[]>();
  for (const event of events) {
    const list = byRun.get(event.run) ?? [];
    list.push(event);
    byRun.set(event.run, list);
  }
  let delivered = 0;
  let autonomous = 0;
  let autoMerged = 0;
  let intervened = 0;
  let checked = 0;
  let reworked = 0;
  const delivery: Stats["delivery"] = [];
  for (const [run, list] of byRun) {
    if (!list.some((e) => e.kind === "claimed")) continue;
    const helped = list.some((e) => INTERVENTIONS.has(e.kind));
    const done = list.find((e) => e.kind === "delivered");
    if (helped) intervened++;
    if (done !== undefined) {
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
  return {
    runs,
    delivered,
    autoMerged,
    autonomousCompletionRate: rate(autonomous, runs),
    interventionRate: rate(intervened, runs),
    reworkRate: rate(reworked, checked),
    delivery,
    permissions: permissionRows(events),
  };
};

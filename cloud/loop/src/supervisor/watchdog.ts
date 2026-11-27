// Deterministic Loop supervisor watchdog (CYC-484): keeps the Work loop alive, detects stalled worker heartbeats,
// cancels an overdue run once via `loop/run/cancel`, and escalates on a second overdue detection with a `stuck` Notice.
// Pure over injected clock, process controls, store reader, and cancel hook so tests never touch `~/.cycle` or launchd.

import type { SqliteStore } from "../db/store.ts";
import { parseHeartbeat } from "../engine/heartbeat.ts";

export type ManagedProcess = {
  pid: number;
  exited: Promise<number | null>;
};

export type ProcessControl = {
  spawn(): ManagedProcess;
  isAlive(pid: number): boolean;
  signal(pid: number, sig: "SIGTERM" | "SIGKILL"): void;
};

export type WatchdogProject = {
  projectKey: string;
  store: SqliteStore;
};

export type WatchdogOptions = {
  projects: WatchdogProject[];
  proc: ProcessControl;
  cancelRun: (projectKey: string, runKey: string) => Promise<boolean>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Heartbeat staleness threshold across all workers (default 10 minutes). */
  staleMs?: number;
  /** Grace period between SIGTERM and SIGKILL on stale heartbeat restart (default 30 seconds). */
  killGraceMs?: number;
  /** Maximum restarts allowed inside `crashWindowMs` before halting auto-restart (default 5). */
  maxRestartsInWindow?: number;
  /** Crash-loop window (default 10 minutes). */
  crashWindowMs?: number;
  /** Base backoff delay for restarts (default 1 second, doubled per consecutive restart). */
  baseBackoffMs?: number;
  /** Maximum drain time on graceful stop (default 30 minutes). */
  drainTimeoutMs?: number;
};

const MINUTE = 60_000;

export class SupervisorWatchdog {
  readonly #o: Required<
    Pick<
      WatchdogOptions,
      | "staleMs"
      | "killGraceMs"
      | "maxRestartsInWindow"
      | "crashWindowMs"
      | "baseBackoffMs"
      | "drainTimeoutMs"
    >
  > &
    WatchdogOptions;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #log: (line: string) => void;

  #child: ManagedProcess | null = null;
  #startedAtMs = 0;
  #restartTimes: number[] = [];
  #halted = false;
  /** Per-run overdue counts (`project:runKey -> count`), reset when the run moves past the overdue deadline. */
  readonly #overdueCount = new Map<string, number>();
  /** Timestamp until which restart is backed off. */
  #nextStartAtMs = 0;

  constructor(options: WatchdogOptions) {
    this.#o = {
      staleMs: 10 * MINUTE,
      killGraceMs: 30_000,
      maxRestartsInWindow: 5,
      crashWindowMs: 10 * MINUTE,
      baseBackoffMs: 1_000,
      drainTimeoutMs: 30 * MINUTE,
      ...options,
    };
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
    this.#log = options.log ?? (() => {});
  }

  get pid(): number | null {
    return this.#child !== null && this.#o.proc.isAlive(this.#child.pid) ? this.#child.pid : null;
  }

  get halted(): boolean {
    return this.#halted;
  }

  /** Ensures Work loop is running initially (does not count as a restart). */
  start(): void {
    if (this.pid !== null) return;
    this.#child = this.#o.proc.spawn();
    this.#startedAtMs = this.#now().getTime();
    this.#halted = false;
    this.#log(`supervisor: started work loop pid=${this.#child.pid}`);
  }

  /** One 60-second check cycle: process liveness, worker heartbeat freshness, and per-run deadlines. */
  async tick(): Promise<{
    action: "ok" | "restarted" | "halted" | "backed_off" | "stale_restarted";
    cancelled: string[];
    escalated: string[];
  }> {
    const now = this.#now();
    const nowMs = now.getTime();
    const cancelled: string[] = [];
    const escalated: string[] = [];

    // 1. Check if Work loop process is alive.
    if (this.pid === null) {
      if (this.#halted) return { action: "halted", cancelled, escalated };
      if (nowMs < this.#nextStartAtMs) return { action: "backed_off", cancelled, escalated };
      const outcome = this.#tryRestart(nowMs, "process_exited");
      return { action: outcome, cancelled, escalated };
    }

    // 2. Check global heartbeat staleness across all projects.
    // Anchor on at least `#startedAtMs` so stale beats left in `loop.db` from a previous process never kill a fresh start.
    const latestBeatMs = this.#latestBeatMs();
    const referenceMs =
      latestBeatMs !== null ? Math.max(latestBeatMs, this.#startedAtMs) : this.#startedAtMs;
    const childPid = this.#child?.pid;
    if (childPid !== undefined && nowMs - referenceMs > this.#o.staleMs) {
      this.#log("supervisor: all worker heartbeats stale for >10m; restarting work loop");
      await this.#killAndWait(childPid);
      const outcome = this.#tryRestart(nowMs, "heartbeat_stale");
      return {
        action: outcome === "restarted" ? "stale_restarted" : outcome,
        cancelled,
        escalated,
      };
    }

    // 3. Check per-run deadlines across all projects.
    for (const proj of this.#o.projects) {
      const runs = await proj.store.unfinished();
      const byKey = new Map(runs.map((r) => [r.key, r]));
      for (const hb of proj.store.heartbeats()) {
        if (hb.runKey.startsWith("__")) continue;
        const run = byKey.get(hb.runKey);
        // Blocked runs wait for a person; finished runs are not active.
        if (run === undefined || run.phase === "blocked" || run.phase === "done") continue;
        const parsed = parseHeartbeat(hb.detail);
        if (parsed === null) continue;
        // Waiting on a person or idle never counts as stuck.
        if (
          parsed.waitingOn === "person" ||
          parsed.waitingOn === "idle" ||
          parsed.deadline === null
        ) {
          this.#overdueCount.delete(`${proj.projectKey}:${hb.runKey}`);
          continue;
        }
        const deadlineMs = Date.parse(parsed.deadline);
        if (Number.isNaN(deadlineMs)) continue;
        const id = `${proj.projectKey}:${hb.runKey}`;
        if (nowMs <= deadlineMs) {
          this.#overdueCount.delete(id);
          continue;
        }
        const count = (this.#overdueCount.get(id) ?? 0) + 1;
        this.#overdueCount.set(id, count);

        if (count === 1) {
          proj.store.action(hb.runKey, "cancel_turn", {
            actorKind: "supervisor",
            actor: "supervisor",
            phase: parsed.phase,
            waitingOn: parsed.waitingOn,
            deadline: parsed.deadline,
          });
          await this.#o.cancelRun(proj.projectKey, hb.runKey).catch(() => false);
          await proj.store.event(hb.runKey, "stuck_cancelled", {
            phase: parsed.phase,
            waitingOn: parsed.waitingOn,
          });
          cancelled.push(hb.runKey);
        } else if (count === 2) {
          proj.store.notice(
            hb.runKey,
            "stuck",
            `任务在 ${parsed.phase} 阶段（等待 ${parsed.waitingOn}）连续超时两次，守护者不再自动取消，请人工介入。`,
            `stuck:${hb.runKey}:${parsed.phase}:${parsed.deadline}`,
          );
          await proj.store.event(hb.runKey, "stuck_escalated", {
            phase: parsed.phase,
            waitingOn: parsed.waitingOn,
          });
          escalated.push(hb.runKey);
        }
      }
    }

    return { action: "ok", cancelled, escalated };
  }

  /** Gracefully stops the Work loop with SIGTERM, waiting up to `drainTimeoutMs`. Only forces exit when `forceOnTimeout` is true. */
  async drainStop(forceOnTimeout = true): Promise<{ drained: boolean }> {
    const pid = this.pid;
    if (pid === null) return { drained: true };
    this.#o.proc.signal(pid, "SIGTERM");
    const start = this.#now().getTime();
    while (this.#o.proc.isAlive(pid)) {
      if (this.#now().getTime() - start >= this.#o.drainTimeoutMs) {
        if (forceOnTimeout) this.#o.proc.signal(pid, "SIGTERM");
        return { drained: false };
      }
      await this.#sleep(100);
    }
    return { drained: true };
  }

  #latestBeatMs(): number | null {
    let latest: number | null = null;
    for (const proj of this.#o.projects) {
      for (const hb of proj.store.heartbeats()) {
        const ms = Date.parse(hb.at);
        if (!Number.isNaN(ms) && (latest === null || ms > latest)) latest = ms;
      }
    }
    return latest;
  }

  async #killAndWait(pid: number): Promise<void> {
    this.#o.proc.signal(pid, "SIGTERM");
    const start = this.#now().getTime();
    while (this.#o.proc.isAlive(pid)) {
      if (this.#now().getTime() - start >= this.#o.killGraceMs) {
        this.#o.proc.signal(pid, "SIGKILL");
        break;
      }
      await this.#sleep(100);
    }
  }

  #tryRestart(nowMs: number, reason: string): "restarted" | "halted" {
    this.#restartTimes = this.#restartTimes.filter((t) => nowMs - t <= this.#o.crashWindowMs);
    if (this.#restartTimes.length >= this.#o.maxRestartsInWindow) {
      this.#halted = true;
      for (const proj of this.#o.projects) {
        proj.store.notice(
          proj.projectKey,
          "supervisor",
          `Work loop 在 ${Math.round(this.#o.crashWindowMs / MINUTE)} 分钟内重启超过 ${this.#o.maxRestartsInWindow} 次，守护者已停止自动拉起，请排查日志后手动重启。`,
          `supervisor:crash-loop:${proj.projectKey}:${Math.floor(nowMs / this.#o.crashWindowMs)}`,
        );
        void proj.store.event("supervisor", "supervisor_crash_loop", {
          restarts: this.#restartTimes.length,
        });
      }
      this.#log("supervisor: crash loop threshold reached; halting restarts");
      return "halted";
    }
    this.#restartTimes.push(nowMs);
    const delay = this.#o.baseBackoffMs * 2 ** (this.#restartTimes.length - 1);
    this.#nextStartAtMs = nowMs + delay;
    this.#child = this.#o.proc.spawn();
    this.#startedAtMs = nowMs;
    for (const proj of this.#o.projects) {
      void proj.store.event("supervisor", "supervisor_restart", {
        reason,
        attempt: this.#restartTimes.length,
      });
    }
    this.#log(`supervisor: restarted work loop pid=${this.#child.pid} reason=${reason}`);
    return "restarted";
  }
}

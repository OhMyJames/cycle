// The operator agent's loop (CYC-486): outside Intake, inside the Work loop's process, in one worker's place. It is
// woken, never resident: a supervisor `stuck` Notice, or `blockedThreshold` Blocked tickets, start one read-only
// session that reads the exported state and answers with a diagnosis, which is written as an `operator` Notice.
// It only advises: any `<action>` is ignored and recorded.

import type { LoopApiHandler, ProjectApi } from "../api.ts";
import { SqliteStore } from "../db/store.ts";
import { parseOperatorReply } from "../parse/blocks.ts";
import { type OperatorWake, operatorBrief } from "../prompts/operator.ts";
import type { Config, Sessions } from "../types.ts";
import { exportDirOf, writeExport } from "./export.ts";

/** How often the wake conditions are looked at: every worker asks, the store is read at most this often. */
const LOOK_EVERY_MS = 15_000;
/** Kept in the Notice: a diagnosis is a paragraph. */
const NOTICE_CHARS = 4000;

export type OperatorDeps = {
  config: Config;
  project: ProjectApi;
  handler: LoopApiHandler;
  sessions: Sessions;
  now: () => Date;
  log: (line: string) => void;
  /** Where the events are written: `operator_woken` is what `stats.operatorWakes` counts. */
  stopped?: () => boolean;
};

type Wake = { wake: OperatorWake; ref: string; runKeys: string[] };

export class Operator {
  readonly #d: OperatorDeps;
  #running = false;
  #lastLook = 0;
  /** `reason:ref` of every wake that happened, read from the events at the first look. */
  #handled: Set<string> | null = null;
  /** The Blocked keys of the last Blocked wake: a wake needs one that is not among them. */
  #lastBlocked = new Set<string>();

  constructor(deps: OperatorDeps) {
    this.#d = deps;
  }

  get #store(): SqliteStore | null {
    return this.#d.project.store instanceof SqliteStore ? this.#d.project.store : null;
  }

  /** A worker offers its turn: true when the operator used it (one session, one at a time), false to go on to work. */
  async tick(): Promise<boolean> {
    const store = this.#store;
    if (store === null || this.#d.config.dryRun || this.#running) return false;
    if (this.#d.stopped?.() === true) return false;
    const nowMs = this.#d.now().getTime();
    if (nowMs - this.#lastLook < LOOK_EVERY_MS) return false;
    this.#lastLook = nowMs;
    this.#running = true;
    try {
      const found = await this.#due(store);
      if (found === null) return false;
      await this.#wake(store, found);
      return true;
    } finally {
      this.#running = false;
    }
  }

  async #handledSet(store: SqliteStore): Promise<Set<string>> {
    if (this.#handled !== null) return this.#handled;
    const handled = new Set<string>();
    for (const e of await store.events()) {
      if (e.kind !== "operator_woken") continue;
      const { reason, ref, keys } = e as unknown as Record<string, unknown>;
      if (typeof reason === "string" && typeof ref === "string") handled.add(`${reason}:${ref}`);
      if (reason === "blocked" && typeof keys === "string")
        this.#lastBlocked = new Set(keys.split(",").filter((k) => k !== ""));
    }
    this.#handled = handled;
    return handled;
  }

  /** The first reason to wake that has not woken the operator yet, or null. */
  async #due(store: SqliteStore): Promise<Wake | null> {
    const handled = await this.#handledSet(store);
    const unfinished = await store.unfinished();
    const byKey = new Map(unfinished.map((r) => [r.key, r]));
    for (const n of store.notices()) {
      if (n.kind !== "stuck" || handled.has(`stuck:${n.dedupe}`)) continue;
      const run = byKey.get(n.runKey);
      // A run that is finished, Blocked (a person has it) or gone is no longer stuck.
      if (run === undefined || run.phase === "blocked" || run.phase === "done") continue;
      return {
        wake: { reason: "stuck", key: n.runKey, detail: n.text },
        ref: n.dedupe,
        runKeys: [n.runKey],
      };
    }
    const blocked = unfinished
      .filter((r) => r.phase === "blocked")
      .map((r) => r.key)
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    if (blocked.length < this.#d.config.operator.blockedThreshold) {
      // Below the line again: the next pile-up is a new cause.
      this.#lastBlocked = new Set();
      return null;
    }
    // The same pile does not wake it twice; a Blocked ticket that was not in the last one does.
    if (blocked.every((k) => this.#lastBlocked.has(k))) return null;
    return {
      wake: { reason: "blocked", keys: blocked },
      ref: blocked.join(","),
      runKeys: blocked,
    };
  }

  async #wake(store: SqliteStore, found: Wake): Promise<void> {
    const { config, project, sessions, now, log } = this.#d;
    const at = now().toISOString();
    const reason = found.wake.reason;
    // Recorded before the session: a crash or a failed session must not wake it again for the same cause.
    (await this.#handledSet(store)).add(`${reason}:${found.ref}`);
    if (found.wake.reason === "blocked") this.#lastBlocked = new Set(found.wake.keys);
    await store.event("operator", "operator_woken", {
      reason,
      ref: found.ref,
      ...(found.wake.reason === "blocked" ? { keys: found.wake.keys.join(",") } : {}),
      count: found.runKeys.length,
    });
    log(`operator woken: ${reason} ${found.ref}`);
    try {
      const exportDir = await writeExport({
        handler: this.#d.handler,
        project,
        stateDir: config.stateDir,
        runKeys: found.runKeys,
        events: await store.events(),
      });
      const readRoots = [exportDir, ...(config.research?.readRoots ?? [])];
      const created = await sessions.create({
        role: "operator",
        agent: config.qaAgent,
        ...(config.qaModel !== undefined ? { model: config.qaModel } : {}),
        ...(config.qaEffort !== undefined ? { effort: config.qaEffort } : {}),
        title: `[${project.projectKey}] Operator: ${reason}`,
        cwd: config.repoRoot,
        run: project.projectKey,
      });
      const result = await sessions.turn(
        created.sessionId,
        operatorBrief(found.wake, { exportDir, readRoots }),
        {
          run: project.projectKey,
          role: "operator",
          worktree: created.cwd,
          timeoutMs: config.turnTimeoutMs,
          readRoots,
        },
      );
      if (result.stopReason !== "end_turn") {
        await store.event("operator", "operator_failed", {
          reason,
          stop: result.stopReason,
          timedOut: result.timedOut,
        });
        return;
      }
      const reply = parseOperatorReply(result.text);
      if (reply.actionIgnored) await store.event("operator", "operator_action_ignored", { reason });
      if (reply.diagnosis === null) {
        await store.event("operator", "operator_failed", { reason, stop: "no_diagnosis" });
        return;
      }
      store.notice(
        project.projectKey,
        "operator",
        reply.diagnosis.slice(0, NOTICE_CHARS),
        `operator:${reason}:${found.ref}:${at}`,
        { kind: "operator", id: created.sessionId },
      );
    } catch (error) {
      log(`operator failed: ${error instanceof Error ? error.message : String(error)}`);
      await store.event("operator", "operator_failed", { reason, stop: "error" });
    }
  }
}

export { exportDirOf };

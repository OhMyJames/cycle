// The planning node (CYC-322): when the loop has nothing approved to build, it makes Backlog work items ready for a
// person to approve. One round is triage → shaping(i) → shape_qa(i) → writing(i) → … → finished.
//
// A round is a run of its own (an `OwnRun`), not one work item's: its record is `plans/<id>/run.json`, its events have
// `run: plan-<id>` (and `issue: CYC-n` when they are about one), and its sessions read one detached worktree of the
// base, `.agents/worktree/plan-<id>`, made without a branch and without an install. The sessions only read; the loop
// checks their replies (planning.ts) and writes to the tracker itself, only through the `PlanningTracker`: it cannot
// move a work item, put on `auto` or touch any label but its own two. Nothing goes to Blocked: a round that cannot
// use triage ends, an item that cannot be shaped is left with a comment, and the next item is taken.
//
// Every write-back step is saved as soon as it is done, so a round killed in the middle goes on from the first step
// not done. A comment is posted only when the same text is not already on the work item, and a split part saved as
// "being made" is looked up in Backlog (by parent and title) before it is made again.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { StepResult } from "../engine/flow.ts";
import { Blocked, type FlowHost, type Intake, type OwnRun, tail } from "../engine/flow.ts";
import { GIT_SAFE, gitCleanEnv } from "../env.ts";
import { withRepoLock } from "../git-lock.ts";
import { isNetworkError } from "../network.ts";
import { RANK } from "../parse/blocks.ts";
import { planningTracker } from "../plan-mcp.ts";
import {
  type BacklogSnapshot,
  backlogChanged,
  bodyHash,
  type CandidateRules,
  type Category,
  candidates,
  checkShape,
  checkTriage,
  integrationSuites,
  latestCommentAt,
  openingParagraph,
  parseShape,
  parseTriage,
  type ShapeOutput,
  type ShapeRules,
  shapeKind,
  shouldPlan,
  takeSnapshot,
  workflowRules,
} from "../planning.ts";
import {
  type BoardView,
  type CandidateSummary,
  formatFindings,
  listsWhatWasChecked,
  parseVerdict,
  type ShapeFormat,
  shapeBrief,
  shapeFixBrief,
  shapeQaBrief,
  triageBrief,
  triageFixBrief,
  type Verdict,
} from "../prompts/index.ts";
import { findSecrets } from "../secrets.ts";
import { type PlanRound, planRoundId, type Shaped, type ShapeItem } from "../store.ts";
import {
  type BacklogRow,
  DEFAULT_CHECK_MINUTES,
  DEFAULT_MAX_ASK,
  type Issue,
  type LoopPhase,
  type PlanningConfig,
  type PlanningTracker,
  type Priority,
  SessionLost,
  type SessionRole,
  type TurnResult,
} from "../types.ts";

/** The fixed first line of the comment that explains a shaped work item; the Loop page finds the reason by it. */
export const NOTES_HEADING = "Loop 规划";
/** The first line of the comment that keeps a work item as it was before it was shaped. */
export const ORIGINAL_HEADING = "加工前的工单";
/** The project's rules for work items, as the round's worktree has them. */
export const WORKFLOW_SKILL = ".claude/skills/cycle-workflow/SKILL.md";
/** A work item of this project written well, shown to shaping as an example of form (CYC-443), when it can be read. */
const EXAMPLE = { project: "CYC", number: 443 };

export const planKey = (id: string): string => `plan-${id}`;
const isPlanKey = (key: string): boolean => key.startsWith("plan-");
const numberOf = (key: string): number => Number(key.slice(key.lastIndexOf("-") + 1));

/** The round as it is now, and how to move it on. */
type Ctx = {
  round: PlanRound;
  key: string;
  save: (patch: Partial<PlanRound>) => Promise<void>;
  /** What every session of the round is told and given, worked out once per step. */
  rules?: string;
  example?: { key: string; title: string; description: string };
};

/** A session changed the round's worktree: what it said is not trusted, and asking again would not help. */
class Tampered extends Blocked {}

/** What kind of error, and nothing of what it said. */
const errorKind = (error: unknown): string =>
  error instanceof Error
    ? error.message.startsWith("tracker ")
      ? "tracker"
      : error.name
    : "unknown";

const ENDED: ReadonlySet<PlanRound["phase"]> = new Set(["finished", "abandoned"]);
const ITEM_DONE: ReadonlySet<ShapeItem["state"]> = new Set(["done", "abandoned"]);

export class PlanFlow {
  readonly kind = "plan";
  readonly #host: FlowHost;

  constructor(host: FlowHost) {
    this.#host = host;
  }

  get #d() {
    return this.#host.d;
  }

  #planning(): PlanningConfig {
    return this.#host.need(this.#d.config.planning ?? undefined);
  }

  #tracker(): PlanningTracker {
    const { config, tracker } = this.#d;
    return planningTracker(tracker, { ...config, planning: this.#planning() });
  }

  #rules(): CandidateRules {
    const { config } = this.#d;
    return { ...config, planning: this.#planning() };
  }

  // ---- intake ----

  /**
   * Asked after `Todo` has nothing to take, so approved work comes first. A round started and not ended goes on
   * (always: the checks of each work item are in its write-back); else, at most once every `checkMinutes` for the
   * whole Project, the Backlog is looked at, and a new round starts when `shouldPlan` says so and there is a candidate.
   * Only `plans/index.json` is read on the way: no past round.
   */
  intake(): Intake {
    return {
      want: async (held) => {
        const { config, store, clock } = this.#d;
        const planning = config.planning;
        if (planning === null) return { idle: "planning is off" };
        if ([...held].some(isPlanKey)) return { idle: "a planning round is under way" };
        const index = await store.loadPlanIndex();
        if (index.open !== null) {
          const open = await store.loadPlan(index.open);
          if (open !== undefined && !ENDED.has(open.phase)) return { begin: this.#goOn(open) };
        }

        const now = clock.now();
        const every = (planning.checkMinutes ?? DEFAULT_CHECK_MINUTES) * 60_000;
        if (index.lastCheckedAt !== null && now.getTime() - Date.parse(index.lastCheckedAt) < every)
          return { idle: "planning: the Backlog was looked at a short while ago" };
        if (!config.dryRun)
          await store.savePlanIndex({ ...index, lastCheckedAt: now.toISOString() });

        // One list call: the rows say the labels, the titles and when each last changed.
        const tracker = this.#tracker();
        const rows = await tracker.listBacklogRows();
        const pending = rows.filter((r) => r.labelIds.includes(planning.labels.pending)).length;
        const lastEndedAt = index.lastEndedAt === null ? null : new Date(index.lastEndedAt);
        const waited =
          lastEndedAt === null ||
          now.getTime() - lastEndedAt.getTime() >= planning.intervalMinutes * 60_000;
        // Comments are read only when they can decide: under the limit, inside the interval, every row as it was.
        const changed =
          !waited && pending < planning.maxPending
            ? await backlogChanged(index.snapshot, rows, this.#rules(), (row) =>
                this.#latestComment(row),
              )
            : false;
        const go = shouldPlan({
          freeWorker: true,
          todoTakeable: false,
          pending,
          maxPending: planning.maxPending,
          roundRunning: false,
          lastEndedAt,
          intervalMinutes: planning.intervalMinutes,
          now,
          backlogChanged: changed,
        });
        if (!go)
          return {
            idle: `planning: ${pending} of ${planning.maxPending} waiting for approval, ${
              waited ? "interval passed" : changed ? "Backlog changed" : "Backlog unchanged"
            }`,
          };

        // Only now is the Backlog read in full, to choose the candidates.
        const backlog = await tracker.listBacklog();
        const memory = await store.loadPlanMemory();
        const latest: Record<string, string | null> = {};
        for (const issue of backlog)
          if (issue.key in memory)
            latest[issue.key] = latestCommentAt(await tracker.listComments(issue));
        const found = candidates(backlog, this.#rules(), memory, latest);
        if (found.length === 0) {
          // Nothing to plan: remembered as a round that ended, with no round and no directory.
          if (!config.dryRun)
            await store.savePlanIndex({
              ...(await store.loadPlanIndex()),
              lastEndedAt: now.toISOString(),
              snapshot: await this.#snapshot(rows),
            });
          return { idle: "planning: no candidate in Backlog" };
        }
        return {
          begin: this.#start(
            planRoundId(now),
            found.map((i) => i.key),
          ),
        };
      },
      reject: async () => {
        throw new Error("the planning node takes no work item, so it rejects none");
      },
    };
  }

  async #latestComment(row: BacklogRow): Promise<string | null> {
    return latestCommentAt(await this.#tracker().listComments(row));
  }

  /** The Backlog as `backlogChanged` compares it next time: the rows, and the latest comment of the watched ones. */
  #snapshot(rows: BacklogRow[]): Promise<BacklogSnapshot> {
    return takeSnapshot(rows, this.#rules(), (row) => this.#latestComment(row));
  }

  #start(id: string, keys: string[]): OwnRun {
    const key = planKey(id);
    const { store, clock } = this.#d;
    return {
      key,
      open: async () => {
        const now = clock.now().toISOString();
        await store.savePlan({
          id,
          startedAt: now,
          updatedAt: now,
          phase: "triage",
          worktree: null,
          triageSessionId: null,
          candidates: keys,
          triage: null,
          queue: [],
          triageRound: 0,
          triageFindings: null,
          triageDone: {},
          stoppedReason: null,
          endedAt: null,
        });
        await store.savePlanIndex({ ...(await store.loadPlanIndex()), open: id });
        await store.event(key, "plan_started", { candidates: keys.length });
      },
      go: () => this.#run(id),
      fail: (error) => this.#fail(id, error),
      would: { status: "would-plan", key },
    };
  }

  /**
   * A round that failed as a whole (something other than the network): `plan_failed`, and the round ends, so the next
   * one can begin. Only the kind of the error is recorded.
   */
  async #fail(id: string, error: unknown): Promise<StepResult> {
    const { store, clock } = this.#d;
    const key = planKey(id);
    await store.event(key, "plan_failed", { error: errorKind(error) });
    const round = await store.loadPlan(id);
    const endedAt = clock.now().toISOString();
    if (round !== undefined && !ENDED.has(round.phase)) {
      for (const q of round.queue)
        if (!ITEM_DONE.has(q.state)) await this.#clearPhaseQuietly(q.key, q.number);
      let worktree = round.worktree;
      try {
        if (worktree !== null && (await this.#removeWorktree(worktree))) worktree = null;
      } catch {
        // kept in the leftovers below, for cleanup
      }
      await store.savePlan({
        ...round,
        phase: "abandoned",
        stoppedReason: round.stoppedReason ?? "规划出错",
        endedAt,
        worktree,
      });
      const index = await store.loadPlanIndex();
      await store.savePlanIndex({
        ...index,
        open: index.open === id ? null : index.open,
        lastEndedAt: endedAt,
        leftovers: worktree === null ? index.leftovers : [...index.leftovers, { id, worktree }],
      });
    }
    return { status: "plan_stopped", key, reason: "规划出错，这一轮结束了" };
  }

  #goOn(round: PlanRound): OwnRun {
    const key = planKey(round.id);
    return {
      key,
      open: () => this.#d.store.event(key, "recovered", { phase: round.phase }),
      go: () => this.#run(round.id),
      fail: (error) => this.#fail(round.id, error),
      would: { status: "would-plan", key },
    };
  }

  /** Removes the worktrees of rounds that ended and still have one (a removal that failed then), from the index. */
  async cleanup(active: ReadonlySet<string>): Promise<void> {
    const { store } = this.#d;
    const index = await store.loadPlanIndex();
    if (index.leftovers.length === 0) return;
    const left = [];
    for (const entry of index.leftovers) {
      if (active.has(planKey(entry.id)) || !(await this.#removeWorktree(entry.worktree))) {
        left.push(entry);
        continue;
      }
      // The one round read here: its record stops pointing at a worktree that is gone.
      const round = await store.loadPlan(entry.id);
      if (round !== undefined) await store.savePlan({ ...round, worktree: null });
    }
    if (left.length !== index.leftovers.length)
      await store.savePlanIndex({ ...(await store.loadPlanIndex()), leftovers: left });
  }

  // ---- the round ----

  async #run(id: string): Promise<StepResult> {
    const { store } = this.#d;
    const ctx: Ctx = {
      round: this.#host.need(await store.loadPlan(id)),
      key: planKey(id),
      save: async (patch) => {
        ctx.round = await store.savePlan({ ...ctx.round, ...patch });
      },
    };
    if (ctx.round.phase === "triage" && ctx.round.stoppedReason === null) {
      try {
        await this.#triage(ctx);
      } catch (error) {
        if (!(error instanceof Blocked)) throw error;
        await ctx.save({ stoppedReason: error.message });
      }
    }
    if (ctx.round.stoppedReason !== null) {
      await this.#end(ctx);
      return { status: "plan_stopped", key: ctx.key, reason: ctx.round.stoppedReason };
    }
    if (ctx.round.phase === "shaping") {
      for (let i = 0; i < ctx.round.queue.length; i++) await this.#shapeItem(ctx, i);
    }
    await this.#end(ctx);
    const count = (state: ShapeItem["state"]) =>
      ctx.round.queue.filter((q) => q.state === state).length;
    return {
      status: "planned",
      key: ctx.key,
      shaped: count("done"),
      asked:
        count("asked") +
        (ctx.round.triage === null
          ? 0
          : askedThisRound(
              ctx.round.triage,
              ctx.round.candidates,
              this.#planning().maxAsk ?? DEFAULT_MAX_ASK,
            ).size),
      stopped: count("stopped"),
      abandoned: count("abandoned"),
    };
  }

  /** The read roots of the round's sessions: research's, and the round's bodies. */
  #readRoots(id: string): string[] {
    return [...(this.#d.config.research?.readRoots ?? []), this.#d.store.planBodiesDir(id)];
  }

  async #git(args: string[], cwd: string) {
    return this.#d.exec(["git", ...GIT_SAFE, ...args], {
      cwd,
      env: gitCleanEnv(this.#d.env, this.#d.config.stateDir),
      timeoutMs: this.#d.config.commandTimeoutMs,
    });
  }

  /** A fresh base, and a detached worktree of it for the round's sessions to read. No branch, no install. */
  async #makeWorktree(ctx: Ctx): Promise<string> {
    const { config } = this.#d;
    const path = join(config.repoRoot, ".agents", "worktree", ctx.key);
    const fetched = await this.#host.netExec(ctx.key, "git fetch", () =>
      this.#d.workspace.fetchMain({ cwd: config.repoRoot, timeoutMs: config.commandTimeoutMs }),
    );
    if (fetched.code !== 0) throw new Blocked(`git fetch 失败：${tail(fetched.output)}`);
    if (!existsSync(path)) {
      const added = await withRepoLock(config.repoRoot, () =>
        this.#git(["worktree", "add", "--detach", path, config.baseRef], config.repoRoot),
      );
      if (added.code !== 0) throw new Blocked(`git worktree add 失败：${tail(added.output)}`);
    }
    return path;
  }

  /** Forced: the worktree is the round's own, detached and read-only, and holds nothing of a person's. */
  async #removeWorktree(path: string): Promise<boolean> {
    const { config } = this.#d;
    if (!existsSync(path)) return true;
    const removed = await withRepoLock(config.repoRoot, () =>
      this.#git(["worktree", "remove", "--force", path], config.repoRoot),
    );
    return removed.code === 0;
  }

  /** The rules and the example every shaping session is told, read once per step from the round's worktree. */
  async #prepare(ctx: Ctx, worktree: string): Promise<void> {
    if (ctx.rules !== undefined) return;
    let skill: string;
    try {
      skill = await readFile(join(worktree, WORKFLOW_SKILL), "utf8");
      ctx.rules = workflowRules(skill);
    } catch (error) {
      throw new Blocked(
        `读不到工单规范（${WORKFLOW_SKILL}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (ctx.round.candidates.some((key) => key.startsWith(`${EXAMPLE.project}-`))) {
      try {
        const example = await this.#tracker().get(EXAMPLE.number);
        ctx.example = {
          key: example.key,
          title: example.title,
          // The example predates the `./` rule (CYC-425): shown as the checks want it written.
          description: example.description.replace(
            /`bun test (?!\.\/)([^`\s/][^`]*)`/g,
            "`bun test ./$1`",
          ),
        };
      } catch {
        // No example: shaping goes on with the rules and the template alone.
      }
    }
  }

  // ---- triage ----

  async #triage(ctx: Ctx): Promise<void> {
    const { config, store } = this.#d;
    const planning = this.#planning();
    const tracker = this.#tracker();
    let backlog = await tracker.listBacklog();

    if (ctx.round.triage === null && ctx.round.candidates.length === 0) {
      const memory = await store.loadPlanMemory();
      const latest: Record<string, string | null> = {};
      for (const issue of backlog)
        if (issue.key in memory)
          latest[issue.key] = latestCommentAt(await tracker.listComments(issue));
      const found = candidates(backlog, this.#rules(), memory, latest);
      if (found.length === 0) {
        await store.event(ctx.key, "plan_triaged", {
          candidates: 0,
          can: 0,
          ask: 0,
          split: 0,
          unfit: 0,
          queued: 0,
        });
        await ctx.save({ phase: "shaping" });
        return;
      }
      await ctx.save({ candidates: found.map((i) => i.key) });
    }

    if (ctx.round.worktree === null) await ctx.save({ worktree: await this.#makeWorktree(ctx) });
    const worktree = this.#host.need(ctx.round.worktree ?? undefined);
    await this.#prepare(ctx, worktree);

    if (ctx.round.triage === null) {
      // A candidate deleted since it was chosen is left out, rather than holding the round up.
      const read = await Promise.all(ctx.round.candidates.map((k) => this.#read(numberOf(k))));
      const issues = read.filter((i): i is Issue => i !== undefined);
      if (issues.length !== ctx.round.candidates.length)
        await ctx.save({ candidates: issues.map((i) => i.key) });
      for (const issue of issues)
        await store.writePlanBody(
          ctx.round.id,
          issue.key,
          `# ${issue.key} ${issue.title}\n\n${issue.description}\n`,
        );
      const brief = triageBrief({
        candidates: await this.#summaries(issues, backlog),
        board: await this.#board(issues, backlog),
        bodiesDir: store.planBodiesDir(ctx.round.id),
        readRoots: this.#readRoots(ctx.round.id),
        maxCriteria: config.maxCriteria,
      });
      for (;;) {
        const findings = ctx.round.triageFindings;
        const prompt = findings === null ? brief : triageFixBrief(ctx.round.triageRound, findings);
        const result = await this.#sessionTurn(ctx, "triage", worktree, {
          sessionId: ctx.round.triageSessionId,
          title: `[${ctx.key}] Triage`,
          prompt,
          fresh: brief,
          saveSession: (id) => ctx.save({ triageSessionId: id }),
          who: "盘点",
        });
        const checked = checkTriage(parseTriage(result.text), ctx.round.candidates);
        if (checked.ok) {
          const t = checked.triage;
          await ctx.save({
            triage: {
              categories: t.categories,
              priorities: t.priorities,
              order: t.order,
              reasons: t.reasons,
              questions: t.questions,
            },
            triageFindings: null,
          });
          break;
        }
        if (ctx.round.triageRound >= config.maxFixRounds)
          throw new Blocked(
            `盘点修复了 ${ctx.round.triageRound} 轮仍未通过：${tail(checked.findings.join("；"), 600)}`,
          );
        await ctx.save({
          triageRound: ctx.round.triageRound + 1,
          triageFindings: checked.findings,
        });
      }
    }

    // What triage decided, written back: a changed priority with a comment, questions with 待回答. 不适合 is only
    // remembered (at the end of the round), never written.
    const triage = this.#host.need(ctx.round.triage ?? undefined);
    const asking = askedThisRound(
      triage,
      ctx.round.candidates,
      this.#planning().maxAsk ?? DEFAULT_MAX_ASK,
    );
    for (const key of ctx.round.candidates) await this.#writeTriage(ctx, key, asking);

    // The queue: as many as there is room for among those waiting for approval, in triage's order.
    backlog = await tracker.listBacklog();
    const pending = backlog.filter((i) => i.labelIds.includes(planning.labels.pending)).length;
    const room = Math.max(0, planning.maxPending - pending);
    const queue: ShapeItem[] = [];
    for (const key of triage.order.slice(0, room)) {
      const issue = await this.#read(numberOf(key));
      if (issue === undefined) continue;
      queue.push({
        key,
        issueId: issue.id,
        number: issue.number,
        hash: "",
        state: "waiting",
        round: 0,
        shapeSessionId: null,
        qaSessionId: null,
        stoppedReason: null,
        originalCommented: false,
        rewritten: false,
        before: null,
        created: [],
        pendingCreate: null,
        linked: false,
        notesCommented: false,
        labelled: false,
        findings: null,
        output: null,
        linkedCount: 0,
        questions: null,
        askCommented: false,
        askLabelled: false,
        stopCommented: false,
      });
    }
    const count = (c: Category) => Object.values(triage.categories).filter((x) => x === c).length;
    await store.event(ctx.key, "plan_triaged", {
      candidates: ctx.round.candidates.length,
      can: count("能做"),
      ask: count("要问"),
      split: count("要拆"),
      unfit: count("不适合"),
      queued: queue.length,
    });
    await ctx.save({ queue, phase: "shaping" });
  }

  /**
   * A work item read again, or undefined when it cannot be read (deleted since): the round goes on without it instead
   * of failing at the same place on every step.
   */
  async #read(number: number): Promise<Issue | undefined> {
    try {
      return await this.#tracker().get(number);
    } catch (error) {
      // The tracker out of reach is a wait, not "gone".
      if (error instanceof Error && isNetworkError(error.message)) throw error;
      return undefined;
    }
  }

  /** Whether the planner may still write to a work item: in Backlog, and not marked to skip. */
  #stillOurs(issue: Issue): "moved" | "skip" | undefined {
    const planning = this.#planning();
    if (issue.columnId !== planning.backlogColumn) return "moved";
    if (issue.labelIds.includes(planning.labels.skip)) return "skip";
    return undefined;
  }

  async #writeTriage(ctx: Ctx, key: string, asking: ReadonlySet<string>): Promise<void> {
    const { store } = this.#d;
    const tracker = this.#tracker();
    const triage = this.#host.need(ctx.round.triage ?? undefined);
    // 不适合 is only remembered: no priority, no comment (Spec: no flood of comments on what the loop will not do).
    if (triage.categories[key] === "不适合") return;
    const done = new Set(ctx.round.triageDone[key] ?? []);
    const mark = async (step: string) => {
      done.add(step);
      await ctx.save({ triageDone: { ...ctx.round.triageDone, [key]: [...done] } });
    };
    const issue = await this.#read(numberOf(key));
    if (issue === undefined || this.#stillOurs(issue) !== undefined) return;
    const reason = triage.reasons[key] ?? "";
    const questions = triage.questions[key] ?? [];
    // What a session wrote is published only without anything shaped like a credential.
    if (findSecrets([reason, ...questions].join("\n")).length > 0) return;

    const to = triage.priorities[key] as Priority | undefined;
    if (to !== undefined && !done.has("priority")) {
      // The comment goes first: it says the old priority, which is gone once the new one is written.
      if (!done.has("priorityComment") && issue.priority !== to) {
        await this.#commentOnce(
          issue,
          `规划节点调整了优先级：${issue.priority ?? "无"} → ${to}。\n\n理由：${reason}`,
        );
        await mark("priorityComment");
      }
      if (done.has("priorityComment")) {
        const from = issue.priority;
        if (from !== to) {
          await tracker.setPriority(issue, to);
          await store.event(ctx.key, "plan_priority_changed", {
            issue: key,
            from: from ?? "none",
            to,
          });
        }
      }
      await mark("priority");
    }
    // Over the round's limit, a 要问 is not written: it stays a candidate and is asked in a later round.
    if (triage.categories[key] === "要问" && asking.has(key))
      await this.#ask(ctx, issue, questions, done, mark);
  }

  /** 要问, from triage or from shaping: the questions in a comment, then 待回答. */
  async #ask(
    ctx: Ctx,
    issue: Issue,
    questions: string[],
    done: { has: (step: string) => boolean },
    mark: (step: string) => Promise<void>,
  ): Promise<void> {
    const tracker = this.#tracker();
    if (!done.has("askComment")) {
      await this.#commentOnce(
        issue,
        `规划节点需要先问清楚这几点，才能把这张工单整理成可以批准的样子：\n\n${questions
          .map((q, i) => `${i + 1}. ${q}`)
          .join("\n")}\n\n回答后请摘掉「待回答」标签，这张工单会重新参加规划。`,
      );
      await mark("askComment");
    }
    if (!done.has("askLabel")) {
      await tracker.markAwaitingAnswer(issue);
      await this.#d.store.event(ctx.key, "plan_asked", {
        issue: issue.key,
        questions: questions.length,
      });
      await mark("askLabel");
    }
  }

  /** Posts a comment unless the work item already has one with the same text (posted before a restart). */
  async #commentOnce(issue: Issue, text: string): Promise<void> {
    const tracker = this.#tracker();
    const existing = await tracker.listComments(issue);
    if (existing.some((c) => c.body.trim() === text.trim())) return;
    await tracker.comment(issue, text);
  }

  #typeOf(issue: Issue): "Feature" | "Bug" {
    return issue.typeId === this.#d.config.bugTypeId ? "Bug" : "Feature";
  }

  /** The parent of a work item: from the Backlog when it is there, else read; null when there is none or it cannot be read. */
  async #parent(issue: Issue, backlog: Issue[]): Promise<Issue | null> {
    if (issue.parentId === null) return null;
    const listed = backlog.find((i) => i.id === issue.parentId);
    if (listed !== undefined) return listed;
    if (issue.parent === undefined) return null;
    try {
      return await this.#tracker().get(issue.parent.number);
    } catch {
      return null;
    }
  }

  #links(issue: Issue): string[] {
    return (issue.links ?? []).map((l) =>
      l.kind === "blocks"
        ? l.direction === "inward"
          ? `blocked by ${l.key} ${l.title}`
          : `blocks ${l.key} ${l.title}`
        : `${l.kind} ${l.key} ${l.title}`,
    );
  }

  async #summaries(issues: Issue[], backlog: Issue[]): Promise<CandidateSummary[]> {
    const out: CandidateSummary[] = [];
    for (const issue of issues) {
      const parent = await this.#parent(issue, backlog);
      out.push({
        key: issue.key,
        title: issue.title,
        type: this.#typeOf(issue),
        priority: issue.priority,
        parent:
          parent !== null
            ? `${parent.key} ${parent.title}`
            : issue.parent !== undefined
              ? `${issue.parent.key} ${issue.parent.title}`
              : null,
        links: this.#links(issue),
        opening: openingParagraph(issue.description),
        length: [...issue.description].length,
      });
    }
    return out;
  }

  async #board(issues: Issue[], backlog: Issue[]): Promise<BoardView> {
    const planning = this.#planning();
    const tracker = this.#tracker();
    const line = (i: Issue) => `${i.key} ${i.title}`;
    const epics = new Map<string, Issue>();
    for (const i of backlog) if (i.typeId === planning.epicTypeId) epics.set(i.key, i);
    for (const issue of issues) {
      const parent = await this.#parent(issue, backlog);
      if (parent !== null && parent.typeId === planning.epicTypeId) epics.set(parent.key, parent);
    }
    return {
      todo: (await tracker.listTodo()).map(line),
      inProgress: (await tracker.listInProgress()).map(line),
      pending: backlog.filter((i) => i.labelIds.includes(planning.labels.pending)).map(line),
      epics: [...epics.values()].map((e) => ({
        key: e.key,
        title: e.title,
        opening: openingParagraph(e.description),
      })),
    };
  }

  // ---- sessions ----

  /**
   * One turn of a planning session, made when there is none. A session that is gone is replaced, and the new one is
   * given `fresh` (the whole brief). The worktree must be as it was: a session that changed it is not trusted.
   */
  async #sessionTurn(
    ctx: Ctx,
    role: SessionRole,
    worktree: string,
    s: {
      sessionId: string | null;
      title: string;
      prompt: string;
      fresh: string;
      saveSession: (id: string) => Promise<void>;
      who: string;
    },
  ): Promise<TurnResult> {
    const options = {
      role,
      worktree,
      timeoutMs: this.#d.config.turnTimeoutMs,
      readRoots: this.#readRoots(ctx.round.id),
    };
    const before = await this.#host.snapshot(worktree);
    let sessionId = s.sessionId;
    let prompt = s.prompt;
    if (sessionId === null) {
      sessionId = await this.#newSession(role, worktree, s.title);
      await s.saveSession(sessionId);
      prompt = s.fresh;
    }
    let result: TurnResult;
    try {
      result = await this.#host.turn(ctx.key, sessionId, prompt, options);
    } catch (error) {
      if (!(error instanceof SessionLost)) throw error;
      sessionId = await this.#newSession(role, worktree, s.title);
      await s.saveSession(sessionId);
      result = await this.#host.turn(ctx.key, sessionId, s.fresh, options);
    }
    await this.#d.store.event(ctx.key, `${role}_turn`, { stop: result.stopReason });
    if ((await this.#host.snapshot(worktree)) !== before)
      throw new Tampered(`${s.who}会话修改了工作区，自动化不信任这次的结果。`);
    this.#host.mustHaveEnded(s.who, result);
    return result;
  }

  async #newSession(role: SessionRole, worktree: string, title: string): Promise<string> {
    const { config } = this.#d;
    const qa = role === "shape_qa";
    const agent = qa ? config.qaAgent : config.devAgent;
    const model = qa ? config.qaModel : config.devModel;
    const effort = qa ? config.qaEffort : config.devEffort;
    const created = await this.#d.sessions.create({
      role,
      agent,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      title,
      // The round's own worktree, by name: the daemon finds it there (it makes none, and no branch) and files the
      // session under the project, as it does a dev session. A `cwd` inside it would make it a workspace of its own.
      cwd: config.repoRoot,
      worktree: { base: config.baseRef, name: basename(worktree) },
    });
    return created.sessionId;
  }

  // ---- shaping ----

  async #shapeItem(ctx: Ctx, index: number): Promise<void> {
    const item = () => ctx.round.queue[index] as ShapeItem;
    const save = (patch: Partial<ShapeItem>) =>
      ctx.save({
        queue: ctx.round.queue.map((q, j) => (j === index ? { ...q, ...patch } : q)),
      });
    for (;;) {
      const state = item().state;
      if (ITEM_DONE.has(state)) return;
      try {
        if (state === "waiting") await this.#begin(ctx, item(), save);
        else if (state === "shape") await this.#shape(ctx, item(), save);
        else if (state === "shape_qa") await this.#qa(ctx, item(), save);
        else if (state === "writing") await this.#write(ctx, item(), save);
        else if (state === "asked") return await this.#asked(ctx, item(), save);
        else if (state === "stopped") return await this.#stopped(ctx, item(), save);
      } catch (error) {
        if (!(error instanceof Blocked)) {
          // A network error goes up (the step waits); anything else stops this one item, and the next is taken.
          if (isNetworkError(error instanceof Error ? error.message : String(error))) throw error;
          await this.#d.store.event(ctx.key, "plan_item_failed", {
            issue: item().key,
            error: errorKind(error),
          });
          // Failed while stopping itself (the comment): give up on the comment, or the same failure repeats.
          if (state === "stopped") {
            await save({ stopCommented: true });
            return;
          }
          await save({ state: "stopped", stoppedReason: "规划时出错" });
          continue;
        }
        await save({ state: "stopped", stoppedReason: error.message });
        await this.#d.store.event(ctx.key, "plan_shape_stopped", {
          issue: item().key,
          rounds: item().round,
        });
      }
    }
  }

  /** Clears the phase field of a work item if it can still be read; a failure here is not worth another one. */
  async #clearPhaseQuietly(key: string, number: number): Promise<void> {
    try {
      const issue = await this.#read(number);
      if (issue !== undefined) await this.#host.clearPhase(key, issue);
    } catch {
      // best effort
    }
  }

  #phase(item: ShapeItem, issue: Issue, phase: LoopPhase | null): void {
    this.#host.mirror(item.key, issue, phase);
  }

  async #abandon(
    ctx: Ctx,
    item: ShapeItem,
    issue: Issue | undefined,
    why: string,
    save: (patch: Partial<ShapeItem>) => Promise<void>,
  ): Promise<void> {
    await save({ state: "abandoned" });
    await this.#d.store.event(ctx.key, "plan_abandoned", { issue: item.key, why });
    if (issue !== undefined) await this.#host.clearPhase(item.key, issue);
  }

  /** Shaping begins: the work item is read and its title and body hashed, to see later whether a person changed it. */
  async #begin(
    ctx: Ctx,
    item: ShapeItem,
    save: (patch: Partial<ShapeItem>) => Promise<void>,
  ): Promise<void> {
    const planning = this.#planning();
    const issue = await this.#read(item.number);
    if (issue === undefined) return this.#abandon(ctx, item, undefined, "gone", save);
    const why =
      this.#stillOurs(issue) ??
      (issue.labelIds.includes(planning.labels.pending) ? "pending" : undefined);
    if (why !== undefined) return this.#abandon(ctx, item, issue, why, save);
    await save({ state: "shape", hash: bodyHash(issue.title, issue.description) });
  }

  #format(issue: Issue): ShapeFormat {
    return {
      key: issue.key,
      type: this.#typeOf(issue),
      standalone: issue.parentId === null,
      maxSplit: this.#planning().maxSplit,
    };
  }

  async #nextRound(
    item: ShapeItem,
    findings: string,
    save: (patch: Partial<ShapeItem>) => Promise<void>,
  ): Promise<void> {
    if (item.round >= this.#d.config.maxFixRounds)
      throw new Blocked(
        `修复了 ${item.round} 轮仍未通过。最后一次的问题：\n${tail(findings, 1500)}`,
      );
    await save({ state: "shape", round: item.round + 1, findings });
  }

  async #shape(
    ctx: Ctx,
    item: ShapeItem,
    save: (patch: Partial<ShapeItem>) => Promise<void>,
  ): Promise<void> {
    const { config } = this.#d;
    const planning = this.#planning();
    const tracker = this.#tracker();
    const triage = this.#host.need(ctx.round.triage ?? undefined);
    const worktree = this.#host.need(ctx.round.worktree ?? undefined);
    await this.#prepare(ctx, worktree);
    const issue = await tracker.get(item.number);
    this.#phase(item, issue, "plan");
    const backlog = await tracker.listBacklog();
    const parent = await this.#parent(issue, backlog);
    const siblings =
      issue.parentId === null
        ? []
        : backlog
            .filter((i) => i.parentId === issue.parentId && i.id !== issue.id)
            .map((i) => `sibling ${i.key} ${i.title}`);
    const format = this.#format(issue);
    const brief = shapeBrief(issue, {
      format,
      comments: await tracker.listComments(issue),
      parent:
        parent === null
          ? null
          : { key: parent.key, title: parent.title, description: parent.description },
      related: [...this.#links(issue), ...siblings],
      template: format.type === "Bug" ? planning.templates.bug : planning.templates.feature,
      triage: {
        category: (triage.categories[item.key] ?? "能做") as Category,
        reason: triage.reasons[item.key] ?? "",
      },
      rules: this.#host.need(ctx.rules),
      maxCriteria: config.maxCriteria,
      readRoots: this.#readRoots(ctx.round.id),
      ...(ctx.example !== undefined ? { example: ctx.example } : {}),
    });
    const findings = item.findings;
    const result = await this.#sessionTurn(ctx, "shape", worktree, {
      sessionId: item.shapeSessionId,
      title: `[${item.key}] Shape`,
      prompt: findings === null ? brief : shapeFixBrief(item.round, findings, format),
      fresh:
        findings === null
          ? brief
          : `${brief}\n\nAn earlier reply was sent back with these findings; do not repeat them:\n${findings}`,
      saveSession: (id) => save({ shapeSessionId: id }),
      who: "加工",
    });
    const output = parseShape(result.text);
    const rules: ShapeRules = {
      ...config,
      maxSplit: planning.maxSplit,
      exists: (path) => existsSync(join(worktree, path)),
      suites: integrationSuites(),
    };
    const found = checkShape(output, issue, rules);
    if (found.length > 0)
      return this.#nextRound(
        item,
        `The loop's checks found:\n${found.map((f) => `- ${f}`).join("\n")}`,
        save,
      );
    if (shapeKind(output) === "questions") {
      await save({ state: "asked", questions: output.questions ?? [], findings: null });
      return;
    }
    await save({ state: "shape_qa", output: shaped(output), findings: null });
  }

  /**
   * Shaping QA: a second reader, told the original and the result. An unusable answer is tried again in a fresh
   * session, up to `maxQaRetries` times; a rejection goes back to the shaping session as a fix round.
   */
  async #qa(
    ctx: Ctx,
    item: ShapeItem,
    save: (patch: Partial<ShapeItem>) => Promise<void>,
  ): Promise<void> {
    const { config, store } = this.#d;
    const tracker = this.#tracker();
    const worktree = this.#host.need(ctx.round.worktree ?? undefined);
    await this.#prepare(ctx, worktree);
    const issue = await tracker.get(item.number);
    this.#phase(item, issue, "planQa");
    const prompt = shapeQaBrief(issue, {
      comments: await tracker.listComments(issue),
      output: unshaped(this.#host.need(item.output ?? undefined)),
      rules: this.#host.need(ctx.rules),
      readRoots: this.#readRoots(ctx.round.id),
    });
    const attempts = Math.max(1, config.maxQaRetries + 1);
    let verdict: Verdict | undefined;
    let last = "";
    let sessionId = item.qaSessionId;
    for (let attempt = 0; attempt < attempts && verdict === undefined; attempt++) {
      if (attempt > 0) {
        await store.event(ctx.key, "qa_retry", { issue: item.key, attempt });
        sessionId = null;
      }
      const result = await this.#sessionTurn(ctx, "shape_qa", worktree, {
        sessionId,
        title: `[${item.key}] Shape QA`,
        prompt,
        fresh: prompt,
        saveSession: async (id) => {
          sessionId = id;
          await save({ qaSessionId: id });
        },
        who: "规划 QA",
      }).catch((error) => {
        // A turn that timed out or ended badly is QA's fault, not the shaping's: tried again in a new session.
        if (error instanceof Blocked && !(error instanceof Tampered)) {
          last = error.message;
          return undefined;
        }
        throw error;
      });
      if (result === undefined) continue;
      const parsed = parseVerdict(result.text);
      if (parsed === undefined) last = "QA 没有给出可以读取的审查结论。";
      else if (!listsWhatWasChecked(result.text))
        last = "QA 没有写明它检查了什么，自动化不接受没有依据的通过。";
      else verdict = parsed;
    }
    if (verdict === undefined)
      throw new Blocked(
        `规划 QA 系统故障（不是加工结果的问题）：共尝试 ${attempts} 次仍没有可用的审查结论。最后一次：${last}`,
      );
    if (!verdict.pass)
      return this.#nextRound(item, `Independent review found:\n${formatFindings(verdict)}`, save);
    await save({ state: "writing" });
  }

  /** Spec 「写回」 0–5, each step saved as soon as it is done. */
  async #write(
    ctx: Ctx,
    start: ShapeItem,
    save: (patch: Partial<ShapeItem>) => Promise<void>,
  ): Promise<void> {
    const { store } = this.#d;
    const tracker = this.#tracker();
    const triage = this.#host.need(ctx.round.triage ?? undefined);
    let item = start;
    const step = async (patch: Partial<ShapeItem>) => {
      item = { ...item, ...patch };
      await save(patch);
    };
    const out = this.#host.need(item.output ?? undefined);
    const reason = triage.reasons[item.key] ?? "";

    // Before every step that writes: still the text this round began with (or the one it wrote itself), still in
    // Backlog, not marked to skip. Otherwise the round leaves it as it is. A restart gets the same check.
    const expected = (): { title: string; description: string } | null =>
      out.kind === "rewrite" ? out : out.epic !== null ? out.epic : (out.parts[0] ?? null);
    const guard = async (): Promise<Issue | undefined> => {
      const fresh = await tracker.get(item.number);
      const wrote = expected();
      const hash = bodyHash(fresh.title, fresh.description);
      // The old text; or the new one, whole (a restart before `rewritten` was saved) or with only the title written.
      const same =
        hash === item.hash ||
        (wrote !== null &&
          (hash === bodyHash(wrote.title, wrote.description) ||
            (item.before !== null && hash === bodyHash(wrote.title, item.before.description))));
      const why = same ? this.#stillOurs(fresh) : "edited";
      if (why !== undefined) {
        await this.#abandon(ctx, item, fresh, why, save);
        return undefined;
      }
      return fresh;
    };

    let original: Issue;
    if (!item.originalCommented) {
      // 0. Nothing shaped like a credential leaves the machine; only the kinds are said.
      const kinds = findSecrets(
        [
          out.title,
          out.description,
          out.notes,
          reason,
          ...out.parts.flatMap((p) => [p.title, p.description]),
          ...(out.epic === null ? [] : [out.epic.title, out.epic.description]),
        ].join("\n"),
      );
      if (kinds.length > 0) {
        await store.event(ctx.key, "secrets_found", { issue: item.key, kinds: kinds.join(",") });
        throw new Blocked(
          `加工结果里有疑似凭据（${kinds.join("、")}），没有写进工单，这里也不贴原文。`,
        );
      }
      // 1. Not over a person: changed since shaping began, out of Backlog, or marked to skip leaves it alone.
      const fresh = await guard();
      if (fresh === undefined) return;
      // 2. The original, as it was.
      await this.#commentOnce(
        fresh,
        `${ORIGINAL_HEADING}\n\n标题：${fresh.title}\n\n${fresh.description}`,
      );
      await step({ originalCommented: true });
      original = fresh;
    } else {
      const fresh = await guard();
      if (fresh === undefined) return;
      original = fresh;
    }
    // 3. The new text; for a split, the parts.
    if (!item.rewritten) {
      if (item.before === null)
        await step({ before: { title: original.title, description: original.description } });
      if (out.kind === "rewrite") {
        await tracker.setTitle(original, out.title);
        await tracker.setDescription(original, out.description);
      } else if (out.epic !== null) {
        await tracker.makeEpic(original);
        await tracker.setTitle(original, out.epic.title);
        await tracker.setDescription(original, out.epic.description);
      } else {
        const first = this.#host.need(out.parts[0]);
        await tracker.setTitle(original, first.title);
        await tracker.setDescription(original, first.description);
      }
      await step({ rewritten: true });
      original = await tracker.get(item.number);
    }
    let chain: Issue[] = [original];
    if (out.kind === "split") {
      const made = out.epic !== null ? out.parts : out.parts.slice(1);
      const parentId = out.epic !== null ? original.id : original.parentId;
      const priority = original.priority ?? triage.priorities[item.key] ?? "medium";
      for (let k = item.created.length; k < made.length; k++) {
        const part = this.#host.need(made[k]);
        let number: number | undefined;
        if (item.pendingCreate?.index === k) {
          // Made before a restart, and not yet saved? Then it is in Backlog under the same parent, with this title.
          number = (await tracker.listBacklog()).find(
            (i) =>
              i.parentId === parentId &&
              i.title === part.title &&
              i.number !== item.number &&
              !item.created.includes(i.number),
          )?.number;
        }
        if (number === undefined) {
          const fresh = await guard();
          if (fresh === undefined) return;
          original = fresh;
          await step({ pendingCreate: { index: k, title: part.title } });
          number = (
            await tracker.createIssue({
              kind: part.type,
              title: part.title,
              description: part.description,
              parentId,
              priority,
            })
          ).number;
        }
        await step({ created: [...item.created, number], pendingCreate: null });
      }
      const parts = await Promise.all(item.created.map((n) => tracker.get(n)));
      chain = out.epic !== null ? parts : [original, ...parts];
      // In order, each blocking the next.
      for (let j = item.linkedCount; j < chain.length - 1; j++) {
        if ((await guard()) === undefined) return;
        await tracker.linkBlocks(chain[j] as Issue, (chain[j + 1] as Issue).id);
        await step({ linkedCount: j + 1 });
      }
      if (!item.linked) await step({ linked: true });
    }

    // 4. What was done and why, under the fixed first line.
    if (!item.notesCommented) {
      if ((await guard()) === undefined) return;
      const list =
        out.kind === "split"
          ? `\n\n拆成了：\n${[
              ...(out.epic !== null ? [`- ${original.key}（改成 Epic）`] : []),
              ...chain.map((i) => `- ${i.key} ${i.title}`),
            ].join("\n")}`
          : "";
      await this.#commentOnce(
        original,
        `${NOTES_HEADING}\n\n${out.notes}\n\n盘点的理由：${reason}${list}`,
      );
      await step({ notesCommented: true });
    }

    // 5. 待批准 on each work item a person is to approve: the rewritten one, or every part (not the Epic).
    if (!item.labelled) {
      if ((await guard()) === undefined) return;
      for (const i of chain) await tracker.markPending(i);
      await step({ labelled: true });
    }
    await step({ state: "done" });
    await this.#host.clearPhase(item.key, original);
    await store.event(ctx.key, "plan_shaped", {
      issue: item.key,
      form: out.kind,
      parts: out.kind === "split" ? out.parts.length : 1,
      rounds: item.round,
      keys: chain.map((i) => i.key).join(","),
    });
  }

  /** Shaping found it needs a person after all: as 要问 from triage, and not shaped. */
  async #asked(
    ctx: Ctx,
    item: ShapeItem,
    save: (patch: Partial<ShapeItem>) => Promise<void>,
  ): Promise<void> {
    const issue = await this.#tracker().get(item.number);
    const questions = item.questions ?? [];
    let current = item;
    const why = this.#stillOurs(issue);
    if (why === undefined && findSecrets(questions.join("\n")).length > 0) {
      throw new Blocked("加工会话提的问题里有疑似凭据，没有发出去。");
    }
    if (why === undefined)
      await this.#ask(
        ctx,
        issue,
        questions,
        {
          has: (step) =>
            step === "askComment"
              ? current.askCommented
              : step === "askLabel" && current.askLabelled,
        },
        async (step) => {
          const patch = step === "askComment" ? { askCommented: true } : { askLabelled: true };
          current = { ...current, ...patch };
          await save(patch);
        },
      );
    await this.#host.clearPhase(item.key, issue);
  }

  /** Shaping stopped: one comment that says why (never what the sessions wrote when it holds a credential). */
  async #stopped(
    _ctx: Ctx,
    item: ShapeItem,
    save: (patch: Partial<ShapeItem>) => Promise<void>,
  ): Promise<void> {
    // Read quietly: a work item that was deleted, or that the tracker keeps failing on, is stopped without a word.
    const issue = await this.#read(item.number);
    if (issue === undefined) return;
    if (!item.stopCommented) {
      const said = item.stoppedReason ?? "";
      const leaked = findSecrets(said);
      const reason =
        leaked.length > 0 ? `原因里有疑似凭据（${leaked.join("、")}），没有贴出原文。` : said;
      await this.#commentOnce(
        issue,
        `规划节点没能加工这张工单，这次什么都没有改：${reason}\n\n工单的标题、正文或评论有变化后，规划节点会再看它。`,
      );
      await save({ stopCommented: true });
    }
    await this.#host.clearPhase(item.key, issue);
  }

  // ---- the end ----

  /**
   * What the round leaves for the next: per candidate, its category, the hash of its title and body and its latest
   * comment, taken after the round's own writes; the Backlog's snapshot in the index, likewise. Then the worktree goes.
   */
  async #end(ctx: Ctx): Promise<void> {
    const { store, clock } = this.#d;
    const tracker = this.#tracker();
    const triage = ctx.round.triage;
    if (triage !== null) {
      const memory = await store.loadPlanMemory();
      for (const key of ctx.round.candidates) {
        const issue = await this.#read(numberOf(key));
        if (issue === undefined) continue;
        const item = ctx.round.queue.find((q) => q.key === key);
        memory[key] = {
          category: triage.categories[key] ?? null,
          bodyHash: bodyHash(issue.title, issue.description),
          lastCommentAt: latestCommentAt(await tracker.listComments(issue)),
          stopped: item?.state === "stopped",
        };
      }
      await store.savePlanMemory(memory);
    }
    const snapshot = await this.#snapshot(await tracker.listBacklogRows());
    let worktree = ctx.round.worktree;
    if (worktree !== null && (await this.#removeWorktree(worktree))) worktree = null;
    const count = (state: ShapeItem["state"]) =>
      ctx.round.queue.filter((q) => q.state === state).length;
    await store.event(ctx.key, "plan_finished", {
      outcome: ctx.round.stoppedReason === null ? "finished" : "triage_stopped",
      shaped: count("done"),
      asked: count("asked"),
      stopped: count("stopped"),
      abandoned: count("abandoned"),
    });
    const endedAt = clock.now().toISOString();
    await ctx.save({
      phase: ctx.round.stoppedReason === null ? "finished" : "abandoned",
      endedAt,
      worktree,
    });
    const index = await store.loadPlanIndex();
    await store.savePlanIndex({
      ...index,
      open: null,
      lastEndedAt: endedAt,
      snapshot,
      leftovers:
        worktree === null ? index.leftovers : [...index.leftovers, { id: ctx.round.id, worktree }],
    });
  }
}

/** A reply that passed the checks, as the round's record keeps it. */
const shaped = (output: ShapeOutput): Shaped =>
  output.split !== null
    ? {
        kind: "split",
        title: "",
        description: "",
        notes: output.notes ?? "",
        parts: output.split.map((p) => ({
          type: p.type ?? "Feature",
          title: p.title,
          description: p.description,
        })),
        epic: output.epic,
      }
    : {
        kind: "rewrite",
        title: output.title ?? "",
        description: output.description ?? "",
        notes: output.notes ?? "",
        parts: [],
        epic: null,
      };

/** The kept result, as `shapeQaBrief` shows it. */
const unshaped = (s: Shaped): ShapeOutput =>
  s.kind === "split"
    ? {
        title: null,
        description: null,
        notes: s.notes,
        split: s.parts,
        epic: s.epic,
        questions: null,
      }
    : {
        title: s.title,
        description: s.description,
        notes: s.notes,
        split: null,
        epic: null,
        questions: null,
      };

/**
 * The 要问 work items whose questions a round writes: at most `limit`, highest suggested priority first, then in the
 * candidates' order. Asking about every unclear work item at once floods people with questions (CYC-322 pilot: 31 in
 * one round); the rest wait, still candidates, for a later round.
 */
export const askedThisRound = (
  triage: { categories: Record<string, string>; priorities: Record<string, string> },
  candidates: readonly string[],
  limit: number,
): Set<string> =>
  new Set(
    candidates
      .map((key, index) => ({ key, index }))
      .filter(({ key }) => triage.categories[key] === "要问")
      .sort(
        (a, b) =>
          (RANK[triage.priorities[a.key] ?? ""] ?? 4) -
            (RANK[triage.priorities[b.key] ?? ""] ?? 4) || a.index - b.index,
      )
      .slice(0, limit)
      .map(({ key }) => key),
  );

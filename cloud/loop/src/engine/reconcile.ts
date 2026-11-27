// The tracker made to match what the loop wrote down (CYC-480). Whatever the loop writes for people to read (a
// comment, a move, a label, the phase field) is first an intent, in the same SQLite transaction as the change that
// calls for it. The reconciler then does what is still to do, in order, one work item at a time. A failure leaves the
// intent pending and counts, except a network failure, which waits and does not count; the next flush (every `step()` starts with one) tries again. Each intent is safe to run
// twice: it looks at the work item first, and a comment carries a marker the reconciler looks for before it writes.

import type { Intent, StoreOps } from "../db/store.ts";
import { isNetworkError } from "../network.ts";
import type { Tracker } from "../ports/tracker.ts";
import type { LoopStore } from "../store.ts";
import type { Clock, Config, Issue, Logger, LoopPhase, Stage } from "../types.ts";

/** More failed attempts than this and an intent is `stuck`: a person is told, and the loop stops trying. */
export const MAX_ATTEMPTS = 10;
/** How long an intent waits after its 1st, 2nd, 3rd… network failure; the last is the longest. */
export const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000, 600_000] as const;
/** The wait after `waits` network failures so far. */
export const backoffMs = (waits: number): number =>
  BACKOFF_MS[Math.min(waits, BACKOFF_MS.length - 1)] as number;
/** How many work items are reconciled at once. */
const PARALLEL = 4;
/** How many of the newest comments are searched for a marker. */
const RECENT = 50;

export type IntentPayload =
  | { comment: { body: string } }
  | { move: { to: Stage; from: Stage | Stage[] } }
  | { label: { labelId: number; add: boolean } }
  | { phase: { phase: LoopPhase | null; at: string } };

type Target = { issueId: number; issueNumber: number };

export const marker = (dedupe: string): string => `<!-- loop:${dedupe} -->`;

/** Writes an intent inside a transaction. A `dedupe` that exists is left as it is: returns whether it was new. */
export const writeIntent = (
  tx: StoreOps,
  args: {
    run: string;
    issue: Pick<Issue, "id" | "number">;
    kind: "comment" | "move" | "label" | "phase";
    dedupe: string;
    payload: Record<string, unknown>;
  },
): boolean =>
  tx.intent(
    args.run,
    args.kind,
    { issueId: args.issue.id, issueNumber: args.issue.number, ...args.payload },
    args.dedupe,
  );

type Parts = {
  tracker: Tracker;
  store: LoopStore;
  config: Config;
  clock: Clock;
  log: Logger;
};

/** The tracker said plainly that the work item is not there. */
class IssueNotFound extends Error {}

/** Failures that say nothing against the intent: the network, a timeout, the tracker being down. They wait, uncounted. */
const isTransient = (kind: string): boolean => kind === "network" || kind === "timeout";

/** What went wrong, as a kind and nothing else: the message may carry text from the tracker. */
export const failureKind = (error: unknown): string => {
  if (error instanceof IssueNotFound) return "not_found";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && isNetworkError(error.message)) return "network";
  return "error";
};

const targetOf = (intent: Intent): Target | undefined => {
  const p = intent.payload as Partial<Target> | null;
  if (p === null || typeof p.issueId !== "number" || typeof p.issueNumber !== "number")
    return undefined;
  return { issueId: p.issueId, issueNumber: p.issueNumber };
};

/** A column as its stateType, and nothing of its name; an unknown column (Backlog, say) is `other`. */
const stateTypeOf = (config: Config, column: unknown): string => {
  const c = config.columns;
  const id = typeof column === "string" ? c[column as Stage as keyof typeof c] : column;
  if (id === c.todo) return "unstarted";
  if (id === c.inProgress || id === c.inReview || id === c.blocked) return "started";
  if (id === c.done) return "completed";
  if (id === c.canceled) return "canceled";
  return "other";
};

const KINDS = new Set(["comment", "move", "label", "phase"]);

export class Reconciler {
  readonly #parts: () => Parts;
  /** The work that is under way for each work item: a second flush waits for it, and so keeps the order. */
  readonly #chains = new Map<string, Promise<void>>();

  /** `parts` is a getter: the config is the one of the step that calls. */
  constructor(parts: () => Parts) {
    this.#parts = parts;
  }

  /**
   * Does what is pending, for one work item or for all. Never throws: a failure is on the intent. With `capMs`, stops
   * waiting after that long; the work goes on in the background.
   */
  async flush(issueId?: number, opts: { capMs?: number } = {}): Promise<void> {
    const work = this.#flush(issueId).catch((error) => {
      this.#parts().log(`reconcile: ${failureKind(error)}`);
    });
    if (opts.capMs === undefined) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, opts.capMs);
      }),
    ]);
    clearTimeout(timer);
  }

  async #flush(issueId: number | undefined): Promise<void> {
    // Two lanes per work item: what people read, in strict order, and the phase field, which is best effort and
    // must never hold a comment or a move behind it.
    const lanes = new Map<string, { id: number; phase: boolean }>();
    for (const intent of this.#pending()) {
      const target = targetOf(intent);
      if (target === undefined || (issueId !== undefined && target.issueId !== issueId)) continue;
      const phase = intent.kind === "phase";
      lanes.set(`${target.issueId}:${phase}`, { id: target.issueId, phase });
    }
    const queue = [...lanes.values()];
    const worker = async () => {
      for (let l = queue.shift(); l !== undefined; l = queue.shift())
        await this.#chain(l.id, l.phase);
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  }

  #pending(): Intent[] {
    return this.#parts()
      .store.transaction((tx) => tx.pendingIntents())
      .filter((i) => KINDS.has(i.kind));
  }

  #chain(issueId: number, phase: boolean): Promise<void> {
    const lane = `${issueId}:${phase}`;
    const prev = this.#chains.get(lane) ?? Promise.resolve();
    const next = prev.then(() => this.#issue(issueId, phase)).catch(() => {});
    this.#chains.set(lane, next);
    void next.then(() => {
      if (this.#chains.get(lane) === next) this.#chains.delete(lane);
    });
    return next;
  }

  /** The intents of one work item, in order; the first that fails stops the rest, so a move never passes its comment. */
  async #issue(issueId: number, phase: boolean): Promise<void> {
    // Read again here: another flush may have done some of these while this one waited.
    const mine = this.#pending().filter(
      (i) => targetOf(i)?.issueId === issueId && (i.kind === "phase") === phase,
    );
    // A comment or a move that gave up holds back every later comment and move of the work item: a move must not
    // pass the comment that explains it. The phase field and labels are not held.
    const held = phase
      ? Number.POSITIVE_INFINITY
      : (this.#parts()
          .store.transaction((tx) => tx.stuckIntents())
          .filter(
            (i) => (i.kind === "comment" || i.kind === "move") && targetOf(i)?.issueId === issueId,
          )
          .map((i) => i.id)
          .sort((a, b) => a - b)[0] ?? Number.POSITIVE_INFINITY);
    for (const intent of mine) {
      if ((intent.kind === "comment" || intent.kind === "move") && intent.id > held) continue;
      const current = this.#pending().find((i) => i.id === intent.id);
      if (current === undefined) continue;
      // Waiting for the network: nothing behind it goes first.
      if (
        current.nextAt !== null &&
        Date.parse(current.nextAt) > this.#parts().clock.now().getTime()
      )
        return;
      if (!(await this.#attempt(current))) return;
    }
  }

  /** One attempt. Returns whether the intent is settled (done) so the next may go on. */
  async #attempt(intent: Intent): Promise<boolean> {
    const { store, log } = this.#parts();
    try {
      await this.#apply(intent);
      store.transaction((tx) => tx.markIntent(intent.id, "done"));
      return true;
    } catch (error) {
      const kind = failureKind(error);
      if (isTransient(kind)) {
        const at = new Date(this.#parts().clock.now().getTime() + backoffMs(intent.waits));
        store.transaction((tx) => tx.deferIntent(intent.id, kind, at.toISOString()));
        return false;
      }
      const stuck = kind === "not_found" || intent.attempts + 1 > MAX_ATTEMPTS;
      store.transaction((tx) => {
        tx.markIntent(intent.id, stuck ? "stuck" : "pending", kind);
        // The Notice is the stuck intent itself (`loop/notices/list`); no second one is written here.
        if (stuck)
          tx.event(intent.runKey, "intent_stuck", {
            intent: intent.id,
            what: intent.kind,
            failure: kind,
          });
      });
      if (stuck) log(`${intent.runKey}: intent ${intent.dedupe} is stuck (${kind})`);
      return false;
    }
  }

  /** `tracker.get`, where a work item that is not there is told apart from a tracker that cannot be reached. */
  async #get(number: number): Promise<Issue> {
    try {
      return await this.#parts().tracker.get(number);
    } catch (error) {
      if (error instanceof Error && /not found|\b404\b/i.test(error.message))
        throw new IssueNotFound("work item not found");
      throw error;
    }
  }

  async #apply(intent: Intent): Promise<void> {
    const { tracker, config, store } = this.#parts();
    const target = targetOf(intent) as Target;
    const p = intent.payload as Record<string, unknown>;
    if (intent.kind === "phase") {
      // Only the newest phase of a run matters: an older one still pending is not written.
      const newer = this.#pending().some(
        (i) => i.kind === "phase" && i.runKey === intent.runKey && i.id > intent.id,
      );
      if (newer) return;
      const issue = await this.#get(target.issueNumber);
      await tracker.setLoopPhase(issue, p.phase as LoopPhase | null, new Date(p.at as string));
      return;
    }
    const issue = await this.#get(target.issueNumber);
    if (intent.kind === "move") {
      const to = p.to as Stage;
      // A move is replayed only while it is still what the run wants: a newer move for the run replaces it, and the
      // run's own phase decides the two that a later step may have made wrong.
      const newer = this.#pending().some(
        (i) => i.kind === "move" && i.runKey === intent.runKey && i.id > intent.id,
      );
      if (newer) return;
      const run = await store.load(intent.runKey);
      if (run !== undefined) {
        const stopped = run.phase === "blocked" || run.phase === "done";
        if (to === "blocked" && run.phase !== "blocked") return;
        if (to === "inProgress" && stopped) return;
      }
      if (issue.columnId === config.columns[to]) return;
      // Only while the work item is where the loop thought it was: one a person has moved elsewhere is left alone. An intent
      // written before `from` existed has no place, so it moves nothing that is somewhere else.
      const wanted = [p.from].flat();
      if (
        !wanted.some((f) => typeof f === "string" && config.columns[f as Stage] === issue.columnId)
      ) {
        store.transaction((tx) =>
          tx.event(intent.runKey, "intent_overridden", {
            intent: "move",
            from: stateTypeOf(config, wanted[0]),
            at: stateTypeOf(config, issue.columnId),
          }),
        );
        return;
      }
      await tracker.move(issue, to);
    } else if (intent.kind === "label") {
      const labelId = p.labelId as number;
      const has = issue.labelIds.includes(labelId);
      if (p.add === true ? has : !has) return;
      if (p.add === true) await tracker.addLabel(issue, labelId);
      else await tracker.removeLabel(issue, labelId);
    } else {
      const tag = marker(intent.dedupe);
      const recent = (await tracker.listComments(issue)).slice(-RECENT);
      if (recent.some((c) => c.body.includes(tag))) return;
      await tracker.comment(issue, `${p.body as string}\n\n${tag}`);
    }
  }
}

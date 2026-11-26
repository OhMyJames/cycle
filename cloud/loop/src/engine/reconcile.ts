// The tracker made to match what the loop wrote down (CYC-480). Whatever the loop writes for people to read (a
// comment, a move, a label, the phase field) is first an intent, in the same SQLite transaction as the change that
// calls for it. The reconciler then does what is still to do, in order, one work item at a time. A failure leaves the
// intent pending and counts; the next flush (every `step()` starts with one) tries again. Each intent is safe to run
// twice: it looks at the work item first, and a comment carries a marker the reconciler looks for before it writes.

import type { Intent, StoreOps } from "../db/store.ts";
import { isNetworkError } from "../network.ts";
import type { Tracker } from "../ports/tracker.ts";
import type { LoopStore } from "../store.ts";
import type { Clock, Config, Issue, Logger, LoopPhase, Stage } from "../types.ts";

/** More failed attempts than this and an intent is `stuck`: a person is told, and the loop stops trying. */
export const MAX_ATTEMPTS = 10;
/** How many work items are reconciled at once. */
const PARALLEL = 4;
/** How many of the newest comments are searched for a marker. */
const RECENT = 50;

export type IntentPayload =
  | { comment: { body: string } }
  | { move: { to: Stage } }
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

/** What went wrong, as a kind and nothing else: the message may carry text from the tracker. */
export const failureKind = (error: unknown): string => {
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

const KINDS = new Set(["comment", "move", "label", "phase"]);

export class Reconciler {
  readonly #parts: () => Parts;
  /** The work that is under way for each work item: a second flush waits for it, and so keeps the order. */
  readonly #chains = new Map<number, Promise<void>>();

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
    const ids = new Set<number>();
    for (const intent of this.#pending()) {
      const target = targetOf(intent);
      if (target !== undefined && (issueId === undefined || target.issueId === issueId))
        ids.add(target.issueId);
    }
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) await this.#chain(id);
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  }

  #pending(): Intent[] {
    return this.#parts()
      .store.transaction((tx) => tx.pendingIntents())
      .filter((i) => KINDS.has(i.kind));
  }

  #chain(issueId: number): Promise<void> {
    const prev = this.#chains.get(issueId) ?? Promise.resolve();
    const next = prev.then(() => this.#issue(issueId)).catch(() => {});
    this.#chains.set(issueId, next);
    void next.then(() => {
      if (this.#chains.get(issueId) === next) this.#chains.delete(issueId);
    });
    return next;
  }

  /** The intents of one work item, in order; the first that fails stops the rest, so a move never passes its comment. */
  async #issue(issueId: number): Promise<void> {
    // Read again here: another flush may have done some of these while this one waited.
    const mine = this.#pending().filter((i) => targetOf(i)?.issueId === issueId);
    for (const intent of mine) {
      const current = this.#pending().find((i) => i.id === intent.id);
      if (current === undefined) continue;
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
      const stuck = intent.attempts + 1 > MAX_ATTEMPTS;
      store.transaction((tx) => {
        tx.markIntent(intent.id, stuck ? "stuck" : "pending", kind);
        if (stuck) {
          tx.event(intent.runKey, "intent_stuck", {
            intent: intent.id,
            what: intent.kind,
            failure: kind,
          });
          tx.notice(
            intent.runKey,
            "intent_stuck",
            `写给 tracker 的${intent.kind}连续失败 ${intent.attempts + 1} 次（${kind}），已不再重试：${intent.dedupe}`,
            `intent_stuck:${intent.id}`,
          );
        }
      });
      if (stuck) log(`${intent.runKey}: intent ${intent.dedupe} is stuck (${kind})`);
      return false;
    }
  }

  async #apply(intent: Intent): Promise<void> {
    const { tracker, config } = this.#parts();
    const target = targetOf(intent) as Target;
    const p = intent.payload as Record<string, unknown>;
    if (intent.kind === "phase") {
      // Only the newest phase of a run matters: an older one still pending is not written.
      const newer = this.#pending().some(
        (i) => i.kind === "phase" && i.runKey === intent.runKey && i.id > intent.id,
      );
      if (newer) return;
      const issue = await tracker.get(target.issueNumber);
      await tracker.setLoopPhase(issue, p.phase as LoopPhase | null, new Date(p.at as string));
      return;
    }
    const issue = await tracker.get(target.issueNumber);
    if (intent.kind === "move") {
      const to = p.to as Stage;
      if (issue.columnId === config.columns[to]) return;
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

import type { AgentContext, SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { CONTEXT_META, type ContextBreakdown } from "./context.ts";
import { PLAN_USAGE_UPDATE, planWindowsOf } from "./plan-usage.ts";
import { notify, type SessionState } from "./session.ts";

/**
 * The turn's usage with what the window holds, when the process said: the window is then the one Claude Code measures
 * against (its compaction window when that is smaller than the model's), so the share and the parts agree. When it
 * did not say this time, the window this process last told stays (`known`, cleared on a new process or model), so
 * the ring does not jump between two windows for the same tokens.
 */
export const withContext = (
  usage: SessionUpdate,
  context: ContextBreakdown | undefined,
  known: number | undefined,
): SessionUpdate =>
  context !== undefined
    ? ({ ...usage, size: context.window, _meta: { [CONTEXT_META]: context } } as SessionUpdate)
    : known !== undefined
      ? ({ ...usage, size: known } as SessionUpdate)
      : usage;

/**
 * The account's plan usage, told when it changed (docs/protocol.md §8 "套餐用量"). Once for every session of this
 * adapter: it is the account's, and the daemon keeps it for the agent, not the session.
 */
export class PlanUsage {
  #key: string | undefined;

  async tell(client: AgentContext, session: SessionState, info: unknown): Promise<void> {
    // Only what this event says: the daemon puts it with the other limits, each kept as the newest it heard of it
    // from any process. Kept here, an old limit would come back as new.
    const windows = planWindowsOf(info);
    if (windows.length === 0) return;
    const key = JSON.stringify(windows);
    if (key === this.#key) return;
    this.#key = key;
    await notify(client, session.id, {
      sessionUpdate: PLAN_USAGE_UPDATE,
      windows,
      at: Date.now(),
    } as unknown as SessionUpdate).catch(() => {
      if (this.#key === key) this.#key = undefined;
    });
  }
}

/**
 * The usage after a compaction, told at once rather than at the end of the turn. Only with a window known from
 * an earlier usage of this process: a size is not made up. The cost is left out, which keeps the last one.
 */
export const compactedUsage = async (client: AgentContext, session: SessionState, used: number) => {
  if (session.contextSize === undefined) return;
  await notify(client, session.id, {
    sessionUpdate: "usage_update",
    used,
    size: session.contextSize,
  } as SessionUpdate);
};

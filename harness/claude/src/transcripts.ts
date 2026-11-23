import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { PlanState, TurnTranslator } from "./translate.ts";

/** What a sub-agent's conversation may hold. `CHILD_UPDATE_KINDS` of `@cycle/protocol`; the adapter stays self-contained. */
const CHILD_UPDATE_KINDS: ReadonlySet<string> = new Set([
  "agent_message",
  "agent_message_chunk",
  "agent_thought",
  "agent_thought_chunk",
  "tool_call_update",
  "tool_call_content_chunk",
]);

const childOnly = (updates: SessionUpdate[]): SessionUpdate[] =>
  updates.filter((update) =>
    CHILD_UPDATE_KINDS.has((update as { sessionUpdate: string }).sessionUpdate),
  );

/**
 * Sub-agents' conversations (CYCL-134, docs/protocol.md §9): what each one said, thought and called, as updates of its
 * own session, the one `subagent_update` announced. A sub-agent's messages carry the Agent call that started it
 * (`parent_tool_use_id`); `Subagents` knows which task that call began, and that task's id is the child's.
 *
 * Each sub-agent has a translator of its own, with a plan of its own: its to-do list is not the session's. Only its
 * conversation leaves here; what the translator says of a plan or of usage stays.
 */
export class Transcripts {
  readonly #translators = new Map<string, TurnTranslator>();
  /** Which sub-agent made each call: a permission it asks for is that sub-agent's. */
  readonly #owners = new Map<string, string>();
  /**
   * Sub-agents told as ended. Their last messages can come after (see `Subagents`): what they say is still theirs, but a
   * call they make then is ended at once, as nothing would end it later.
   */
  readonly #ended = new Set<string>();

  /**
   * The updates of `childId`'s conversation that `message`, one of its own, makes. `servers` are the session's MCP
   * servers, for its tools' titles.
   */
  feed(childId: string, message: SDKMessage, servers: readonly string[] = []): SessionUpdate[] {
    if (this.#ended.has(childId)) {
      const late = new TurnTranslator(new PlanState(), servers, true);
      return [...childOnly(late.feed(message)), ...late.unfinished()];
    }
    let translator = this.#translators.get(childId);
    if (translator === undefined) {
      translator = new TurnTranslator(new PlanState(), servers, true);
      this.#translators.set(childId, translator);
    }
    const updates = childOnly(translator.feed(message));
    for (const update of updates) {
      const call = update as { sessionUpdate: string; toolCallId?: unknown };
      if (call.sessionUpdate === "tool_call_update" && typeof call.toolCallId === "string")
        this.#owners.set(call.toolCallId, childId);
    }
    return updates;
  }

  /** The sub-agent a call was made by, if it was made by one this has heard from. */
  ownerOf(toolCallId: string): string | undefined {
    return this.#owners.get(toolCallId);
  }

  /** `childId` is over: a call it left running ends as cancelled, so no client shows it running for ever. */
  end(childId: string): SessionUpdate[] {
    this.#ended.add(childId);
    const translator = this.#translators.get(childId);
    if (translator === undefined) return [];
    this.#translators.delete(childId);
    for (const [call, owner] of this.#owners) if (owner === childId) this.#owners.delete(call);
    return translator.unfinished();
  }

  /** `childId` runs again (a sub-agent that was sent more work): its calls are its own to end again. */
  resume(childId: string): void {
    this.#ended.delete(childId);
  }

  /** The process is gone: every sub-agent is over. By child, in the order they were first heard from. */
  endAll(): { childId: string; updates: SessionUpdate[] }[] {
    return [...this.#translators.keys()]
      .map((childId) => ({ childId, updates: this.end(childId) }))
      .filter((ended) => ended.updates.length > 0);
  }
}

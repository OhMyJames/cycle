import { type CommandLabel } from "./command-label.ts";
import type { AgentItem, CompactionItem, Conversation, Item, NoticeItem, PlanItem, StopReason, ThoughtItem, ToolItem, UserItem } from "./conversation.ts";
import { type Review } from "./review.ts";
export type Activity = "run" | "read" | "edit" | "search" | "list" | "fetch" | "advise" | "other";
export declare const commandOf: (tool: ToolItem) => string | undefined;
export declare const commandLabelOf: (tool: ToolItem) => CommandLabel | undefined;
export declare const activityOf: (tool: ToolItem) => Activity;
export declare const activityCounts: (tools: readonly ToolItem[]) => {
    activity: Activity;
    count: number;
}[];
export declare const isSubagentCall: (tool: ToolItem) => boolean;
export declare const isLive: (tool: ToolItem) => boolean;
export type LaidBlock = {
    key: string;
    turn: number;
    startsTurn: boolean;
} & ({
    kind: "user";
    item: UserItem;
} | {
    kind: "agent";
    item: AgentItem;
} | {
    kind: "thought";
    item: ThoughtItem;
} | {
    kind: "plan";
    item: PlanItem;
} | {
    kind: "notice";
    item: NoticeItem;
} | {
    kind: "compaction";
    item: CompactionItem;
} | {
    kind: "work";
    tools: readonly ToolItem[];
} | {
    kind: "subagent";
    tool: ToolItem;
} | {
    kind: "review";
    tool: ToolItem;
    review: Review;
} | {
    kind: "failed";
    tool: ToolItem;
} | {
    kind: "end";
    stop: StopReason;
} | {
    kind: "fold";
    blocks: readonly LaidBlock[];
    ms?: number;
});
export type BlockCache = Map<number, {
    items: readonly Item[];
    stop: StopReason | undefined;
    blocks: LaidBlock[];
}>;
export declare const blocksOf: (c: Conversation, cache?: BlockCache) => LaidBlock[];
export declare const shownBlocks: (blocks: readonly LaidBlock[], mode: "normal" | "detailed") => LaidBlock[];
export type FoldCache = Map<number, {
    from: readonly LaidBlock[];
    stop: StopReason | undefined;
    blocks: LaidBlock[];
}>;
export declare const foldedBlocks: (blocks: readonly LaidBlock[], stops: readonly StopReason[], cache?: FoldCache) => LaidBlock[];
export type Step = {
    kind: "approval";
} | {
    kind: "tool";
    tool: ToolItem;
} | {
    kind: "thinking";
} | {
    kind: "working";
} | {
    kind: "review";
} | {
    kind: "retrying";
    attempt?: number;
    maxRetries?: number;
};
export declare const stepOf: (c: Conversation) => Step | undefined;

import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
export type Block = {
    type: string;
    [key: string]: unknown;
};
type InTurn = {
    turn: number;
    at?: number;
};
type Streamed = InTurn & {
    blocks: Block[];
    lastAt?: number;
};
export type UserItem = Streamed & {
    kind: "user";
    id: string;
};
export type AgentItem = Streamed & {
    kind: "agent";
    id: string;
};
export type ThoughtItem = Streamed & {
    kind: "thought";
    id: string;
};
export type ToolItem = InTurn & {
    kind: "tool";
    id: string;
    name?: string;
    title?: string;
    toolKind?: string;
    status?: string;
    content: Block[];
    rawInput?: unknown;
    rawOutput?: unknown;
    locations?: {
        path: string;
        line?: number | null;
    }[];
    result?: unknown;
    subagent?: Subagent;
    started?: boolean;
};
export type Subagent = {
    id?: string;
    stoppable?: boolean;
    conversation?: Conversation;
    state: "running" | "done" | "failed" | "stopped" | "unknown" | "dismissed";
    background: boolean;
    summary?: string;
    lastTool?: string;
    usage?: {
        tokens: number;
        toolUses: number;
        durationMs: number;
    };
};
export type PlanEntry = {
    content: string;
    priority: string;
    status: string;
};
export type ContextPart = {
    id?: string;
    name: string;
    tokens: number;
    kind: "used" | "free" | "buffer" | "deferred";
};
export type Usage = {
    used: number;
    size: number;
    parts?: ContextPart[];
    autoCompactAt?: number;
    cost?: {
        amount: number;
        currency: string;
    };
    beforeCompaction?: true;
};
export type ContextState = {
    usage: Usage | undefined;
    compactions: number;
    compacting: boolean;
};
export type PlanItem = InTurn & {
    kind: "plan";
    id: string;
    entries: PlanEntry[];
};
export type NoticeItem = InTurn & {
    kind: "notice";
    id: string;
    severity: string;
    title: string;
    retry?: {
        attempt?: number;
        maxRetries?: number;
    };
};
export type CompactionItem = InTurn & {
    kind: "compaction";
    id: string;
    status: "in_progress" | "completed" | "failed" | "cancelled";
};
export type Item = UserItem | AgentItem | ThoughtItem | ToolItem | PlanItem | NoticeItem | CompactionItem;
export type Status = "idle" | "running" | "requires_action";
export type StopReason = {
    stopReason: string;
    error?: {
        code?: number;
        message?: string;
    } | null | undefined;
};
export type QueuedPrompt = {
    queueId: string;
    prompt: Block[];
};
export type Returned = {
    serial: number;
    returnId?: string;
    prompts: QueuedPrompt[];
    reason?: string;
};
export type Command = {
    name: string;
    description: string;
    hint?: string;
};
export type DynamicConfigChoice = {
    value: string;
    name: string;
    description?: string;
    recommended?: boolean;
    danger?: boolean;
    efforts?: string[];
    provider?: {
        id: string;
        name: string;
    };
};
export type DynamicConfigOption = {
    configId: string;
    name: string;
    currentValue?: string;
    options: DynamicConfigChoice[];
};
declare const TASK_KINDS: readonly ["shell", "monitor", "workflow", "mcp", "other"];
declare const TASK_STATES: readonly ["running", "completed", "failed", "stopped", "unknown"];
export type TaskKind = (typeof TASK_KINDS)[number];
export type TaskState = (typeof TASK_STATES)[number];
export type Goal = {
    condition: string;
    iterations: number;
    setAt: number;
    lastReason?: string;
};
export type BackgroundTask = {
    id: string;
    kind: TaskKind;
    title: string | undefined;
    toolCallId: string | undefined;
    state: TaskState;
};
export type ScheduledJob = {
    id: string;
    kind: "cron" | "wakeup";
    schedule: string;
    humanSchedule: string | undefined;
    recurring: boolean;
    durable: boolean;
    prompt: string;
    nextFireAt: number | undefined;
    toolCallId: string | undefined;
};
export type Schedules = {
    jobs: ScheduledJob[];
    dormant: boolean;
};
export type Conversation = {
    items: Item[];
    status: Status;
    turns: number;
    stops: StopReason[];
    replaying: boolean;
    usage: Usage | undefined;
    queue: QueuedPrompt[];
    returned: Returned | undefined;
    commands: Command[];
    configOptions: DynamicConfigOption[];
    ignored: number;
    waiting: Record<string, Subagent>;
    tasks: BackgroundTask[];
    goal: Goal | null | undefined;
    schedules: Schedules | undefined;
    suggestion: string | undefined;
    planId: string | undefined;
};
export declare const emptyConversation: () => Conversation;
export declare const contextOf: (c: Conversation) => ContextState;
export declare const effortLevelsOf: (meta: Record<string, unknown> | undefined) => string[] | undefined;
export declare const providerOfChoice: (meta: Record<string, unknown> | undefined) => {
    id: string;
    name: string;
} | undefined;
export declare const latestPlan: (c: Conversation) => PlanItem | undefined;
export declare const subagentCallOf: (c: Conversation, childId: string) => ToolItem | undefined;
export declare const applyUpdate: (c: Conversation, update: SessionUpdate, record?: {
    at?: number | undefined;
}) => Conversation;
export declare const reduce: (updates: SessionUpdate[], from?: Conversation) => Conversation;
export declare const canPrompt: (c: Conversation) => boolean;
export declare const textOf: (blocks: Block[]) => string;
export {};

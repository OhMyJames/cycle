import type { Block, Conversation, ToolItem } from "./conversation.ts";
export type Failure = "agent_exited" | "daemon_stopped" | "history" | "resume" | "agent_error";
export declare const failureOf: (code: number | undefined) => Failure;
export type Resend = {
    turn: number;
    prompts: Block[][];
    changed: ToolItem[];
    failure: Failure;
    busy: boolean;
};
export declare const resendOf: (c: Conversation) => Resend | undefined;

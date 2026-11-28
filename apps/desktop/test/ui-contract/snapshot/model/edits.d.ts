import type { Conversation, ToolItem } from "./conversation.ts";
import { type DiffLine } from "./facts.ts";
export type SessionEdit = {
    toolId: string;
    path: string | undefined;
    created: boolean;
    additions: number;
    deletions: number;
    lines?: DiffLine[];
    staged: boolean;
};
export type TurnEdits = {
    turn: number;
    prompt: string | undefined;
    edits: SessionEdit[];
    additions: number;
    deletions: number;
};
export declare const editPathOf: (tool: ToolItem) => string | undefined;
export declare const sessionEdits: (conversation: Conversation) => TurnEdits[];

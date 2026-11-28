import type { Block, ToolItem } from "./conversation.ts";
export type DiffLine = {
    kind: "add" | "del" | "context" | "hunk";
    text: string;
    line?: number;
    id: string;
};
export type ToolFacts = {
    edit?: {
        created: boolean;
        additions: number;
        deletions: number;
        lines?: DiffLine[];
        staged: boolean;
    };
    read?: {
        start: number;
        count: number;
        total?: number;
    };
    search?: {
        files: number;
        matches?: number;
        lines?: number;
        more: boolean;
    };
    fetch?: {
        status: number;
        bytes?: number;
    };
    links: {
        key: string;
        uri: string;
        name: string;
    }[];
    run?: {
        interrupted: boolean;
        timedOutMs?: number;
        background: boolean;
        exitCode?: number;
        durationMs?: number;
    };
    images: {
        key: string;
        block: Block;
    }[];
};
export declare const diffLines: (patch: string) => DiffLine[];
export declare const streamsOf: (tool: ToolItem) => {
    out: string;
    err: string;
};
export declare const toolFacts: (tool: ToolItem) => ToolFacts;

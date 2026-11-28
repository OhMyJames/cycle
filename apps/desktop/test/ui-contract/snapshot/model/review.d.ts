import type { ToolItem } from "./conversation.ts";
export declare const REVIEW_TOOLS: ReadonlySet<string>;
export type Verdict = "confirmed" | "plausible";
export type Outcome = "fixed" | "skipped" | "no_change_needed";
export type Finding = {
    file: string;
    line?: number;
    summary: string;
    short?: string;
    scenario: string;
    category?: string;
    verdict?: Verdict;
    outcome?: Outcome;
};
export type Review = {
    level?: string;
    findings: Finding[];
    prose?: string;
};
export declare const reviewOf: (tool: ToolItem) => Review | undefined;
export declare const isPendingReview: (tool: ToolItem) => boolean;
export declare const isRunningReview: (tool: ToolItem) => boolean;
export declare const reviewTally: (review: Review) => {
    total: number;
    confirmed: number;
    plausible: number;
    fixed: number;
};

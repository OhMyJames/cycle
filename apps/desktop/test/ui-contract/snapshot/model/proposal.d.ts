import type { DiffLine } from "./facts.ts";
export type Proposal = {
    kind: "edit";
    path: string;
    whole: boolean;
    everywhere: boolean;
    lines: DiffLine[];
    additions: number;
    deletions: number;
} | {
    kind: "command";
    command: string;
    description?: string;
    rest?: Record<string, unknown>;
} | {
    kind: "input";
    input: unknown;
};
export declare const lineDiff: (before: string, after: string) => DiffLine[];
export declare const proposalOf: (call: {
    rawInput?: unknown;
}) => Proposal | undefined;

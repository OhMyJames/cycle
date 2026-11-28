export type CommandLabel = {
    kind: "search" | "read" | "list";
    detail: string;
    count: number;
};
export declare const commandLabel: (command: string) => CommandLabel | undefined;

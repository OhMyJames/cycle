export type Slice = {
    start: number;
    end: number;
};
export declare const offsetOf: (sizes: readonly number[], gap: number, index: number) => number;
export declare const sliceOf: (sizes: readonly number[], gap: number, top: number, height: number, lead: number) => Slice;
export declare const spaceOf: (sizes: readonly number[], gap: number, from: number, to: number) => number;

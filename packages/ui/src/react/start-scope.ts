import { useAppState } from "./store-context.tsx";

/**
 * What the times a step or a call started (`startedAt`) are kept under: the session they are in, so two sessions at the
 * same turn, or agents that reuse call ids, do not share one start.
 */
export const useStartScope = (): string =>
  useAppState((state) => `${state.selectedEnvironment ?? ""}:${state.selectedSession ?? ""}`);

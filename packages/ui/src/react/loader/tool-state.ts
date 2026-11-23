// Ported whole from Cycle v2 (packages/ui/src/loader/tool-state.ts), by the owner's decision for CYCL-215; see index.ts.
import type { LoaderState } from "./scenes.ts";

/** What each kind of tool looks like from outside: looking things up, thinking, or doing something. */
const OF_KIND: Readonly<Record<string, LoaderState>> = {
  read: "searching",
  search: "searching",
  list: "searching",
  fetch: "searching",
  think: "thinking",
};

/** The loader's state for a tool at work of ACP kind `kind`: anything not a lookup or thought is doing something. */
export const loaderStateOfKind = (kind: string | undefined): LoaderState =>
  (kind === undefined ? undefined : OF_KIND[kind]) ?? "executing";

// The loader: chains of dots, one animation for each state of the agent's work, morphing from one to the next.
//
// Ported whole from Cycle v2 (`cycle_v2/packages/ui/src/loader/`), which had it from shrimpdot-durable's loader, which had
// it from the brand group's shrimpdot-loader.js. AGENTS.md says not to copy old cycle's code; for this one the owner
// decided otherwise (CYCL-215): the loader is the brand's, and is taken as it is, not redrawn. What changed for v1:
// imports, styling by `data-slot` in app.css, and reduced motion, which here stands still (DESIGN.md §2.3) where v2 kept
// it moving.
//
// Use: `<MorphLoader state="thinking" />`. It is 16px in the layout and takes the text's colour. A new state is held
// back until the one shown has had HOLD_MS, so quick changes do not keep it from settling; `waiting` and `done` come at
// once. For a tool call, `loaderStateOfKind(tool.toolKind)` gives its state.

export { HOLD_MS } from "./hold.ts";
export { MorphLoader } from "./morph-loader.tsx";
export type { LoaderState } from "./scenes.ts";
export { loaderStateOfKind } from "./tool-state.ts";

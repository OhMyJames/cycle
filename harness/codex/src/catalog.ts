// The base instructions codex sends a model it does not know (@openai/codex 0.167.2, Apache-2.0):
// codex-rs/models-manager/prompt.md less its `update_plan` sections, which codex drops while that
// tool is off, as it is unless codex's config turns it on, and never drops from a catalog's text.
// The provider test in the integration suite fails when an upgrade of codex changes them.
import fallbackInstructions from "./fallback-instructions.txt" with { type: "text" };

/** One of the owner's provider models, by the id codex knows it by. */
export interface CatalogEntry {
  slug: string;
  /** How many tokens it can read. */
  contextWindow: number;
}

/**
 * The `model_catalog_json` for the process that serves the owner's providers.
 *
 * Codex caps a session's `model_context_window` at the model's `max_context_window`, and a model it
 * does not know gets 272k, so a larger window would be cut. Each entry is codex's own fallback for
 * an unknown model with the window put in, so a model behaves as it did without a catalog and only
 * reads as far as it can. Null when there is nothing to list: codex refuses an empty catalog.
 */
export function modelCatalog(models: readonly CatalogEntry[]): string | null {
  const entries = models.filter(
    ({ slug, contextWindow }) => slug && Number.isSafeInteger(contextWindow) && contextWindow > 0,
  );
  if (!entries.length) return null;
  return JSON.stringify({
    models: entries.map(({ slug, contextWindow }) => ({
      slug,
      display_name: slug,
      description: null,
      supported_reasoning_levels: [],
      shell_type: "unified_exec",
      visibility: "none",
      supported_in_api: true,
      priority: 99,
      availability_nux: null,
      upgrade: null,
      model_messages: { instructions_template: fallbackInstructions },
      include_apps_usage_instructions: false,
      default_reasoning_summary: "auto",
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: null,
      web_search_tool_type: "text",
      truncation_policy: { mode: "bytes", limit: 10_000 },
      context_window: contextWindow,
      max_context_window: contextWindow,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
    })),
  });
}

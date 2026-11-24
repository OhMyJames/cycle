import type { SessionConfigOption } from "@agentclientprotocol/sdk/experimental/v2";
import type { EffortLevel, ModelInfo } from "@anthropic-ai/claude-agent-sdk";

/** What a session has chosen, from which its configuration options are told (docs/protocol.md §10). */
export type Choices = {
  model: string | undefined;
  effort: EffortLevel | undefined;
  mode: PermissionMode;
};

/**
 * The models offered. Aliases: Claude Code resolves them to whatever is current. The daemon's `configSchema` is built
 * from this list too. "Default model", not "Default": the name is shown alone, beside the message box.
 */
export const CLAUDE_MODELS: readonly { value: string; name: string; description?: string }[] = [
  {
    value: "default",
    name: "Default model",
    description: "Uses your Claude Code default.",
  },
  {
    value: "sonnet",
    name: "Sonnet",
    description: "Balanced speed for everyday coding.",
  },
  {
    value: "opus",
    name: "Opus",
    description: "Most capable for complex work.",
  },
  {
    value: "haiku",
    name: "Haiku",
    description: "Fastest for quick edits and lookups.",
  },
];

/**
 * Reasoning effort levels supported by the Claude Agent SDK (`EffortLevel`), plus `default` which leaves the
 * model's own default in force. Applied via `options.effort` on process start and `applyFlagSettings({ effortLevel })`
 * on a live process (`null` clears the override).
 */
export const CLAUDE_EFFORT_LEVELS = [
  {
    value: "default",
    name: "Default",
    description: "Model default reasoning depth.",
  },
  {
    value: "low",
    name: "Low",
    description: "Minimal reasoning for quick tasks.",
  },
  {
    value: "medium",
    name: "Medium",
    description: "Balanced depth and speed.",
  },
  {
    value: "high",
    name: "High",
    description: "Deeper reasoning for complex changes.",
  },
  {
    value: "xhigh",
    name: "XHigh",
    description: "Extended reasoning for hard problems.",
  },
  {
    value: "max",
    name: "Max",
    description: "Maximum depth for this session.",
  },
] as const;

export type EffortOption = (typeof CLAUDE_EFFORT_LEVELS)[number]["value"];
export const DEFAULT_EFFORT_LEVEL: EffortOption = "default";

/**
 * Every permission mode the SDK has, with what a person needs to choose one, the suggested one first. The values are the
 * SDK's own and are what is stored, so they are never renamed; only `name` and `description` are
 * ours. The daemon's `configSchema` is built from this list too, so the two always agree. The
 * suggested one carries `META.recommended` of `@cycle/protocol` in its `_meta`.
 */
export const CLAUDE_PERMISSION_MODES = [
  {
    value: "auto",
    name: "Auto",
    description: "Reviews actions automatically; asks when unsure.",
    _meta: { "cycle/recommended": true },
  },
  {
    value: "default",
    name: "Ask before acting",
    description: "Asks before editing files or running commands.",
  },
  {
    value: "acceptEdits",
    name: "Accept edits",
    description: "Allows file edits; still asks for commands.",
  },
  {
    value: "plan",
    name: "Plan mode",
    description: "Plans changes first; waits for approval.",
  },
  {
    value: "dontAsk",
    name: "Don't ask",
    description: "Read-only unless allowed by your rules.",
  },
  {
    value: "bypassPermissions",
    name: "Bypass permissions",
    description: "Runs all edits and commands without asking.",
    _meta: { "cycle/danger": true },
  },
] as const;

export type PermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number]["value"];
/** What a new session starts in, and what is offered as the one to use. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";
export const PERMISSION_MODES: readonly string[] = CLAUDE_PERMISSION_MODES.map((m) => m.value);

const DEFAULT_MODEL_OPTION = {
  value: "default",
  name: "Default model",
  description: "Uses your Claude Code default.",
} as const;

/** Matches the active model value (or default) against the SDK's discovered `ModelInfo` entries. */
const findModelInfo = (
  models: readonly ModelInfo[] | undefined,
  current: string | undefined,
): ModelInfo | undefined => {
  if (models === undefined || models.length === 0) return undefined;
  const target = current ?? "default";
  return models.find((m) => m.value === target || m.resolvedModel === target);
};

/**
 * What a discovered model is called: its alias name with the version Claude Code gives first in the description
 * ("Opus 5.5 · Best for …" → "Opus 5.5"), so the list says which model each name is today.
 */
const versionedName = (m: ModelInfo): string => {
  const name = m.displayName || m.value;
  const lead = m.description?.split(" · ")[0]?.trim();
  // Only the name and a version ("Opus 5.5"), never a phrase that happens to start with the name.
  return lead?.toLowerCase().startsWith(`${name.toLowerCase()} `) &&
    /^\d+(\.\d+)*$/.test(lead.slice(name.length + 1))
    ? lead
    : name;
};

/** The rows that are the model `default` stands for, when the SDK says so (`resolvedModel`). */
const aliasesOfDefault = (models: readonly ModelInfo[]): readonly ModelInfo[] => {
  const fallback = models.find((m) => m.value === "default");
  if (fallback?.resolvedModel === undefined) return [];
  return models.filter((m) => m.value !== "default" && m.resolvedModel === fallback.resolvedModel);
};

/**
 * The list as offered: `default` is not an option of its own but the model it stands for, "Opus 5.5 (default)", with the
 * rows it duplicates folded into it. A session pinned to one of those rows keeps it, so the pin is seen and `default`
 * can still be chosen. When the SDK does not say which model `default` is, it keeps a row of its own.
 */
const discoveredModelOptions = (models: readonly ModelInfo[], pinned: string | undefined) => {
  const aliases = aliasesOfDefault(models);
  const row = (m: ModelInfo) => {
    const efforts = effortLevelsOf(m);
    return {
      value: m.value,
      name: versionedName(m),
      ...(m.description ? { description: m.description } : {}),
      ...(efforts !== undefined ? { _meta: { [EFFORTS_META]: efforts } } : {}),
    };
  };
  const out: ReturnType<typeof row>[] = [];
  if (!models.some((m) => m.value === "default")) out.push({ ...DEFAULT_MODEL_OPTION });
  for (const m of models) {
    if (aliases.includes(m) && m.value !== pinned) continue;
    if (m.value !== "default") {
      out.push(row(m));
      continue;
    }
    const named = aliases[0];
    const current = /currently ([^)]+)\)/.exec(m.description ?? "")?.[1]?.trim();
    const base = named !== undefined ? versionedName(named) : current;
    out.push({
      ...row(m),
      name: base === undefined ? DEFAULT_MODEL_OPTION.name : `${base} (default)`,
      ...(named?.description ? { description: named.description } : {}),
    });
  }
  return out;
};

const modelOptions = (
  session: Choices,
  discovered: readonly ModelInfo[] | undefined,
): readonly {
  value: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}[] => {
  const base: {
    value: string;
    name: string;
    description?: string;
    _meta?: Record<string, unknown>;
  }[] =
    discovered !== undefined && discovered.length > 0
      ? discoveredModelOptions(discovered, session.model)
      : CLAUDE_MODELS.map((m) => ({ ...m }));
  if (session.model === undefined || base.some((m) => m.value === session.model)) return base;
  return [...base, { value: session.model, name: session.model, _meta: { "cycle/custom": true } }];
};

/** `_meta` key on a model choice: the effort levels it takes (docs/protocol.md §10). Same as `META.efforts`. */
export const EFFORTS_META = "cycle/efforts";

/**
 * The effort levels a model takes, as the SDK says: `[]` when it takes none, `undefined` when it does not say.
 * Only levels Cycle knows, in Cycle's order.
 */
const effortLevelsOf = (model: ModelInfo): string[] | undefined => {
  if (model.supportsEffort === false) return [];
  if (!Array.isArray(model.supportedEffortLevels) || model.supportedEffortLevels.length === 0)
    return undefined;
  const allowed = new Set<string>(model.supportedEffortLevels);
  const known = CLAUDE_EFFORT_LEVELS.filter(
    (e) => e.value !== DEFAULT_EFFORT_LEVEL && allowed.has(e.value),
  ).map((e) => e.value);
  // Levels it takes, none of them ones Cycle knows (a newer SDK): not "none", but not known.
  return known.length > 0 ? known : undefined;
};

export const effortOptions = (session: Choices, discovered: readonly ModelInfo[] | undefined) => {
  const matched = findModelInfo(discovered, session.model);
  const levels = matched === undefined ? undefined : effortLevelsOf(matched);
  // Not known: every level, and the SDK decides (docs/protocol.md §10).
  if (levels === undefined) return CLAUDE_EFFORT_LEVELS.map((e) => ({ ...e }));
  const allowed = new Set(levels);
  return CLAUDE_EFFORT_LEVELS.filter(
    (e) => e.value === DEFAULT_EFFORT_LEVEL || allowed.has(e.value),
  ).map((e) => ({ ...e }));
};

/** Validates and deduplicates model entries reported by the SDK. */
export const sanitizeModels = (models: unknown): ModelInfo[] | undefined => {
  if (!Array.isArray(models) || models.length === 0) return undefined;
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const item of models) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as ModelInfo;
    if (typeof m.value !== "string" || m.value === "" || seen.has(m.value)) continue;
    seen.add(m.value);
    out.push(m);
  }
  return out.length > 0 ? out : undefined;
};

export const configOptions = (
  session: Choices,
  discovered?: readonly ModelInfo[],
): SessionConfigOption[] =>
  [
    {
      configId: "model",
      name: "Model",
      type: "select",
      currentValue: session.model ?? "default",
      options: modelOptions(session, discovered),
    },
    {
      configId: "effort",
      name: "Effort",
      type: "select",
      currentValue: session.effort ?? DEFAULT_EFFORT_LEVEL,
      options: effortOptions(session, discovered),
    },
    {
      configId: "mode",
      name: "Permission mode",
      type: "select",
      currentValue: session.mode,
      options: CLAUDE_PERMISSION_MODES.map((m) => ({ ...m })),
    },
  ] as SessionConfigOption[];

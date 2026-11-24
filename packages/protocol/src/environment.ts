// A session's environment (docs/protocol.md §6 "环境"): a setup the client defines once and chooses per workspace,
// sent whole with `session/new` and kept by the daemon as the session's own copy. Not where the session runs: that is
// the client's location (decision note 2026-11-24-work-in-and-environments).
import { z } from "zod";

/** A command for each system, with a default for the others. A system with none of its own and no default runs none. */
export const ScriptsSchema = z.object({
  default: z.string().optional(),
  macos: z.string().optional(),
  linux: z.string().optional(),
  windows: z.string().optional(),
});
export type Scripts = z.infer<typeof ScriptsSchema>;

/** A name a shell can export: what `env` would print on the left of `=`. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const EnvironmentVariableSchema = z.object({ name: z.string(), value: z.string() });
export type EnvironmentVariable = z.infer<typeof EnvironmentVariableSchema>;

export const EnvironmentActionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  icon: z.string().optional(),
  command: ScriptsSchema,
});
export type EnvironmentAction = z.infer<typeof EnvironmentActionSchema>;

/** What `session/new` carries in `_meta["cycle/environment"]`, and what the daemon keeps of it. */
export const SessionEnvironmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  variables: z.array(EnvironmentVariableSchema).default([]),
  actions: z.array(EnvironmentActionSchema).default([]),
  setup: ScriptsSchema.optional(),
  cleanup: ScriptsSchema.optional(),
});
export type SessionEnvironment = z.infer<typeof SessionEnvironmentSchema>;

/** What a `session/list` row says of it: never a variable's value. */
export const SessionEnvironmentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  variableNames: z.array(z.string()),
  actions: z.array(z.object({ id: z.string(), name: z.string(), icon: z.string().optional() })),
});
export type SessionEnvironmentSummary = z.infer<typeof SessionEnvironmentSummarySchema>;

/** How much an environment may hold altogether, as its JSON is long. */
export const ENVIRONMENT_MAX_BYTES = 64 * 1024;

/**
 * Names an environment may not set. They are the daemon's (`config.json`, docs/protocol.md §10): where an agent keeps
 * its login and settings, which account it bills, and what a shell needs to start. An environment that set one could
 * quietly change whose login an agent uses.
 */
export const RESERVED_VARIABLES: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TERM",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

export const isReservedVariable = (name: string): boolean =>
  RESERVED_VARIABLES.includes(name) || name.startsWith("CYCLE_");

/** Why an environment cannot be taken, as `data.reason` of the `-32602` that refuses it. */
export type EnvironmentProblem =
  | { reason: "invalid_environment"; detail: string }
  | { reason: "reserved_variable"; name: string }
  | { reason: "invalid_variable"; name: string }
  | { reason: "too_large"; limit: number };

/** The environment as sent, checked; or what is wrong with it. */
export const checkEnvironment = (
  value: unknown,
): { ok: true; environment: SessionEnvironment } | { ok: false; problem: EnvironmentProblem } => {
  const parsed = SessionEnvironmentSchema.safeParse(value);
  if (!parsed.success)
    return { ok: false, problem: { reason: "invalid_environment", detail: parsed.error.message } };
  const environment = parsed.data;
  if (new TextEncoder().encode(JSON.stringify(environment)).length > ENVIRONMENT_MAX_BYTES)
    return { ok: false, problem: { reason: "too_large", limit: ENVIRONMENT_MAX_BYTES } };
  const seen = new Set<string>();
  for (const { name, value: text } of environment.variables) {
    if (!VARIABLE_NAME.test(name) || seen.has(name) || text.includes("\0"))
      return { ok: false, problem: { reason: "invalid_variable", name } };
    if (isReservedVariable(name))
      return { ok: false, problem: { reason: "reserved_variable", name } };
    seen.add(name);
  }
  const actionIds = new Set<string>();
  for (const action of environment.actions) {
    if (actionIds.has(action.id))
      return {
        ok: false,
        problem: { reason: "invalid_environment", detail: `Two actions have the id ${action.id}` },
      };
    actionIds.add(action.id);
  }
  return { ok: true, environment };
};

/** The variables as an environment block, in their order (a later one of the same name cannot be: they are unique). */
export const environmentVariables = (
  environment: SessionEnvironment | undefined,
): Record<string, string> =>
  Object.fromEntries((environment?.variables ?? []).map(({ name, value }) => [name, value]));

export const summarizeEnvironment = (
  environment: SessionEnvironment,
): SessionEnvironmentSummary => ({
  id: environment.id,
  name: environment.name,
  variableNames: environment.variables.map((v) => v.name),
  actions: environment.actions.map(({ id, name, icon }) => ({
    id,
    name,
    ...(icon !== undefined ? { icon } : {}),
  })),
});

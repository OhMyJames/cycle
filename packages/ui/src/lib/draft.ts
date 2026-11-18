import type { ModelInfo } from "@cycle/protocol";

type Model = Pick<ModelInfo, "id" | "harness" | "isDefault" | "sandbox">;

/** The agents a session can start on, the main one first, as the models on offer name them. */
export function harnessesOf(models: Model[]): string[] {
  return [...new Set(models.map((model) => model.harness))];
}

/** The agent a new session starts on: the one of the owner's usual model, or the main one. */
export function draftHarness(models: Model[], preferred: string | null): string {
  const usual = models.find((model) => model.id === preferred);
  return usual?.harness ?? models.find((model) => model.isDefault)?.harness ?? "codex";
}

/**
 * The model a new session on an agent starts with: the owner's usual one when it is that agent's,
 * or else the agent's own first choice. It is always named once the models are known, since a
 * session with no model named starts on the owner's usual one, whichever agent that is.
 */
export function draftModel(
  models: Model[],
  harness: string,
  preferred: string | null,
): string | null {
  const own = models.filter((model) => model.harness === harness);
  const chosen =
    own.find((model) => model.id === preferred) ?? own.find((model) => model.isDefault) ?? own[0];
  return chosen?.id ?? null;
}

/** Whether a session on an agent can run in a sandbox here. */
export function canSandbox(models: Model[], harness: string): boolean {
  return models.some((model) => model.harness === harness && model.sandbox);
}

/** What the owner's last new session chose: its agent, and where each agent's last one ran. */
export interface LastDraft {
  harness: string | null;
  /** By agent: an environment's id, or null for this machine. */
  environment: Record<string, string | null>;
}

/**
 * Reads what was kept of the owner's last new session: nothing readable gives nothing chosen. A page
 * of before sessions kept the environment as `sandbox`, and its choice is still read.
 */
export function lastDraftFrom(raw: string | null): LastDraft {
  try {
    const kept = JSON.parse(raw ?? "{}") as {
      harness?: string | null;
      environment?: LastDraft["environment"];
      sandbox?: LastDraft["environment"];
    };
    return { harness: kept.harness ?? null, environment: kept.environment ?? kept.sandbox ?? {} };
  } catch {
    return { harness: null, environment: {} };
  }
}

/** Where a new session on an agent starts: where the last one on it ran, if that is still there. */
export function draftEnvironment(
  models: Model[],
  environments: { id: string }[],
  harness: string,
  last: LastDraft,
): string | null {
  const used = last.environment[harness] ?? null;
  return used !== null && canSandbox(models, harness) && environments.some((one) => one.id === used)
    ? used
    : null;
}

/** The agent a new session starts on: the last one chosen, while it is on offer, or the usual. */
export function draftStart(models: Model[], preferred: string | null, last: LastDraft): string {
  return last.harness !== null && harnessesOf(models).includes(last.harness)
    ? last.harness
    : draftHarness(models, preferred);
}

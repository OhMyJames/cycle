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

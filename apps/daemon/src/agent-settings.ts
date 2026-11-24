// Per-agent hot-reloadable runtime settings persisted in `<dataDir>/agent-settings.json`
// (docs/protocol.md §16, docs/harness-settings.md §6.1).
// Merge precedence: `agent-settings.json` (explicit overrides) > `config.json` (startup host config) > schema defaults.
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type AgentRuntimePatchValue,
  type AgentRuntimeValue,
  AgentRuntimeValueSchema,
  type RuntimeProperty,
} from "@cycle/protocol";
import { z } from "zod";
import { type Logger, silentLogger } from "./logger.ts";

const AgentEntrySchema = z.object({
  revision: z.number().int().nonnegative(),
  values: z.record(z.string(), AgentRuntimeValueSchema),
});

const AgentSettingsFileSchema = z.object({
  version: z.literal(1),
  agents: z.record(z.string(), AgentEntrySchema),
});

type AgentEntry = z.infer<typeof AgentEntrySchema>;

/** Thrown when `expectedRevision` does not match the agent's current revision (`-32602` / `revision_conflict`). */
export class AgentSettingsConflictError extends Error {
  readonly currentRevision: number;
  constructor(agent: string, expected: number, current: number) {
    super(`Revision conflict for ${agent}: expected ${expected}, current ${current}`);
    this.name = "AgentSettingsConflictError";
    this.currentRevision = current;
  }
}

/** Thrown when `<dataDir>/agent-settings.json` was corrupt on load and must not be silently overwritten. */
export class AgentSettingsCorruptError extends Error {
  readonly fileError: string;
  constructor(path: string, detail: string) {
    super(`Refusing to overwrite unreadable ${path}: ${detail}`);
    this.name = "AgentSettingsCorruptError";
    this.fileError = detail;
  }
}

/** Thrown when a runtime patch fails schema validation (`-32014` / `invalid_config`). */
export class AgentSettingsValidationError extends Error {
  readonly field?: string | undefined;
  readonly reason: string;
  constructor(message: string, options: { field?: string; reason: string }) {
    super(message);
    this.name = "AgentSettingsValidationError";
    this.field = options.field;
    this.reason = options.reason;
  }
}

/**
 * Validate a partial runtime patch against a closed v1 `RuntimeProperty` map (daemon-side authoritative check;
 * never trusts frontend values). Returns the validated patch.
 */
export const validateRuntimePatch = (
  schema: Record<string, RuntimeProperty>,
  patch: Record<string, AgentRuntimePatchValue>,
): Record<string, AgentRuntimePatchValue> => {
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(schema, key)) {
      throw new AgentSettingsValidationError(`Unknown runtime setting: ${key}`, {
        field: key,
        reason: "unknown_field",
      });
    }
    if (value === null) continue;
    const prop = schema[key] as RuntimeProperty;
    if (prop.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new AgentSettingsValidationError(`Expected boolean for ${key}`, {
          field: key,
          reason: "invalid_type",
        });
      }
    } else if (prop.type === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new AgentSettingsValidationError(`Expected integer for ${key}`, {
          field: key,
          reason: "invalid_type",
        });
      }
      if (value < prop.minimum || value > prop.maximum) {
        throw new AgentSettingsValidationError(
          `Value for ${key} must be between ${prop.minimum} and ${prop.maximum}`,
          { field: key, reason: "out_of_range" },
        );
      }
      if (prop.multipleOf !== undefined && value % prop.multipleOf !== 0) {
        throw new AgentSettingsValidationError(
          `Value for ${key} must be a multiple of ${prop.multipleOf}`,
          { field: key, reason: "invalid_step" },
        );
      }
    } else if (prop.type === "string") {
      if (typeof value !== "string") {
        throw new AgentSettingsValidationError(`Expected string for ${key}`, {
          field: key,
          reason: "invalid_type",
        });
      }
      const allowed = prop.oneOf.map((c) => c.const);
      if (!allowed.includes(value)) {
        throw new AgentSettingsValidationError(`Unsupported choice for ${key}`, {
          field: key,
          reason: "invalid_choice",
        });
      }
    }
  }
  return patch;
};

export class AgentSettings {
  readonly #path: string;
  #agents: Map<string, AgentEntry>;
  readonly #fileError: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    path: string,
    agents: Map<string, AgentEntry>,
    fileError: string | undefined,
  ) {
    this.#path = path;
    this.#agents = agents;
    this.#fileError = fileError;
  }

  /**
   * Load `<dataDir>/agent-settings.json`. If the file exists but fails JSON/schema validation or has an unknown
   * version, never overwrites it: logs an error, records `fileError`, and starts with empty overrides so the daemon
   * continues to run using `config.json` / schema defaults.
   */
  static async load(path: string, log: Logger = silentLogger): Promise<AgentSettings> {
    const file = Bun.file(path);
    if (!(await file.exists())) return new AgentSettings(path, new Map(), undefined);
    try {
      const parsed = AgentSettingsFileSchema.parse(JSON.parse(await file.text()));
      return new AgentSettings(path, new Map(Object.entries(parsed.agents)), undefined);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.error("agent_settings_unreadable", { error: detail });
      return new AgentSettings(path, new Map(), detail);
    }
  }

  fileError(): string | undefined {
    return this.#fileError;
  }

  revisionOf(agent: string): number {
    return this.#agents.get(agent)?.revision ?? 0;
  }

  overridesOf(agent: string): Record<string, AgentRuntimeValue> {
    return { ...(this.#agents.get(agent)?.values ?? {}) };
  }

  /** Merge `agent-settings.json` > `config.json` > schema defaults for one agent. */
  effective<T extends Record<string, AgentRuntimeValue>>(
    agent: string,
    defaults: T,
    configValues: Partial<T>,
  ): { values: T; overrides: string[]; revision: number } {
    const entry = this.#agents.get(agent);
    const merged: Record<string, AgentRuntimeValue> = { ...defaults };
    for (const [k, v] of Object.entries(configValues)) {
      if (v !== undefined) merged[k] = v;
    }
    const overrides: string[] = [];
    if (entry !== undefined) {
      for (const [k, v] of Object.entries(entry.values)) {
        if (Object.hasOwn(defaults, k) && typeof v === typeof defaults[k]) {
          merged[k] = v;
          overrides.push(k);
        }
      }
    }
    overrides.sort();
    return {
      values: merged as T,
      overrides,
      revision: entry?.revision ?? 0,
    };
  }

  /**
   * Atomically apply a partial patch (`null` unsets an override) with per-agent optimistic concurrency
   * (`expectedRevision`), serialized write queue, `0600` file permissions, and atomic rename.
   */
  patch(
    agent: string,
    patch: Record<string, AgentRuntimePatchValue>,
    expectedRevision: number,
    schema: Record<string, RuntimeProperty>,
  ): Promise<{ overrides: Record<string, AgentRuntimeValue>; revision: number }> {
    const run = this.#queue.then(async () => {
      if (this.#fileError !== undefined) {
        throw new AgentSettingsCorruptError(this.#path, this.#fileError);
      }
      const current = this.#agents.get(agent) ?? { revision: 0, values: {} };
      if (expectedRevision !== current.revision) {
        throw new AgentSettingsConflictError(agent, expectedRevision, current.revision);
      }
      validateRuntimePatch(schema, patch);

      const nextValues: Record<string, AgentRuntimeValue> = { ...current.values };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete nextValues[key];
        else nextValues[key] = value;
      }
      const nextRevision = current.revision + 1;
      const nextAgents = new Map(this.#agents);
      nextAgents.set(agent, { revision: nextRevision, values: nextValues });
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
      const body = `${JSON.stringify(
        { version: 1, agents: Object.fromEntries(nextAgents) },
        null,
        2,
      )}\n`;
      await writeFile(temporary, body, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.#path);
      // Commit in-memory state ONLY after atomic rename succeeds so concurrent readers never observe uncommitted state.
      this.#agents = nextAgents;
      return { overrides: { ...nextValues }, revision: nextRevision };
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

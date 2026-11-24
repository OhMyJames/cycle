// Per-agent hot-reloadable runtime settings persisted in `<dataDir>/agent-settings.json`
// (docs/protocol.md §16, docs/harness-settings.md §6.1).
// Merge precedence: `agent-settings.json` (explicit overrides) > `config.json` (startup host config) > schema defaults.
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
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

/**
 * What a client is told when `agent-settings.json` cannot be read (snapshot `runtime.fileError`, `set_runtime` error):
 * fixed, so neither the file's path nor the parser's message leaves the daemon. The detail is in daemon.log.
 */
export const AGENT_SETTINGS_UNREADABLE = "agent-settings.json is unreadable";

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
  constructor() {
    super(AGENT_SETTINGS_UNREADABLE);
    this.name = "AgentSettingsCorruptError";
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

/** Reads the file: its agents, `undefined` when there is none, or the reason it cannot be read (for daemon.log only). */
const readFile = (path: string): Map<string, AgentEntry> | undefined | { error: string } => {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = AgentSettingsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return new Map(Object.entries(parsed.agents));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

export class AgentSettings {
  readonly #path: string;
  readonly #log: Logger;
  #agents = new Map<string, AgentEntry>();
  /** Set while the file on disk cannot be read: writes are refused so it is never overwritten. */
  #unreadable = false;
  /** Each agent's runtime schema, once known: loaded values are checked against it. */
  #schemas = new Map<string, Record<string, RuntimeProperty>>();
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(path: string, log: Logger) {
    this.#path = path;
    this.#log = log;
  }

  /**
   * Load `<dataDir>/agent-settings.json`. If the file exists but fails JSON/schema validation or has an unknown
   * version, never overwrites it: logs an error, records `fileError`, and starts with empty overrides so the daemon
   * continues to run using `config.json` / schema defaults. The file is read again while it is unreadable (on each
   * `fileError()` and `patch()`), so one that is fixed or removed is picked up without a restart.
   */
  static async load(path: string, log: Logger = silentLogger): Promise<AgentSettings> {
    const settings = new AgentSettings(path, log);
    settings.#reload();
    return settings;
  }

  /**
   * The agents' runtime schemas (each harness's `runtimeSchema`). A loaded value that does not satisfy its agent's
   * schema (unknown key, wrong type, out of range) is dropped and logged, now and on every later reload.
   */
  useSchemas(schemas: Record<string, Record<string, RuntimeProperty>>): void {
    this.#schemas = new Map(Object.entries(schemas));
    this.#agents = this.#validated(this.#agents);
  }

  /** Fixed text while the file cannot be read (never its path or the parse error), else `undefined`. */
  fileError(): string | undefined {
    this.#recheck();
    return this.#unreadable ? AGENT_SETTINGS_UNREADABLE : undefined;
  }

  /** While the file is unreadable, reads it again (a synchronous read of one small file): fixed or gone, it is used. */
  #recheck(): void {
    if (this.#unreadable) this.#reload();
  }

  #reload(): void {
    const read = readFile(this.#path);
    if (read !== undefined && !(read instanceof Map)) {
      if (!this.#unreadable) this.#log.error("agent_settings_unreadable", { error: read.error });
      this.#unreadable = true;
      this.#agents = new Map();
      return;
    }
    if (this.#unreadable) this.#log.info("agent_settings_readable_again");
    this.#unreadable = false;
    this.#agents = this.#validated(read ?? new Map());
  }

  #validated(agents: Map<string, AgentEntry>): Map<string, AgentEntry> {
    const out = new Map<string, AgentEntry>();
    for (const [agent, entry] of agents) {
      const schema = this.#schemas.get(agent);
      if (schema === undefined) {
        out.set(agent, entry);
        continue;
      }
      const values: Record<string, AgentRuntimeValue> = {};
      for (const [key, value] of Object.entries(entry.values)) {
        try {
          validateRuntimePatch(schema, { [key]: value });
          values[key] = value;
        } catch (error) {
          // The key is the schema's own name (or one the file has that the schema does not): never the value.
          this.#log.warn("agent_settings_value_dropped", {
            agent,
            field: Object.hasOwn(schema, key) ? key : "unknown",
            reason: error instanceof AgentSettingsValidationError ? error.reason : "invalid",
          });
        }
      }
      out.set(agent, { revision: entry.revision, values });
    }
    return out;
  }

  revisionOf(agent: string): number {
    this.#recheck();
    return this.#agents.get(agent)?.revision ?? 0;
  }

  overridesOf(agent: string): Record<string, AgentRuntimeValue> {
    this.#recheck();
    return { ...(this.#agents.get(agent)?.values ?? {}) };
  }

  /** Merge `agent-settings.json` > `config.json` > schema defaults for one agent. */
  effective<T extends Record<string, AgentRuntimeValue>>(
    agent: string,
    defaults: T,
    configValues: Partial<T>,
  ): { values: T; overrides: string[]; revision: number } {
    this.#recheck();
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
      this.#recheck();
      if (this.#unreadable) throw new AgentSettingsCorruptError();
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
      let renamed = false;
      try {
        const file = await open(temporary, "w", 0o600);
        try {
          await file.writeFile(body);
          // On disk before it replaces the old file: a crash after the rename never leaves an empty one.
          await file.sync();
        } finally {
          await file.close();
        }
        await chmod(temporary, 0o600);
        await rename(temporary, this.#path);
        renamed = true;
      } finally {
        if (!renamed) await unlink(temporary).catch(() => undefined);
      }
      // Commit in-memory state ONLY after atomic rename succeeds so concurrent readers never observe uncommitted state.
      this.#agents = nextAgents;
      return { overrides: { ...nextValues }, revision: nextRevision };
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }
}

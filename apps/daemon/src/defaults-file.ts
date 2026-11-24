import { z } from "zod";
import { JsonFile, readJsonFile } from "./json-file.ts";

const DefaultsSchema = z.object({
  version: z.literal(1),
  agents: z.record(z.string(), z.record(z.string(), z.string())),
});

/** The defaults file is there but cannot be read. It is not replaced. */
export class DefaultsUnreadableError extends Error {
  constructor(path: string, detail: string) {
    super(
      `The agent defaults at ${path} cannot be read (${detail}). Fix or move it; it is not replaced.`,
    );
    this.name = "DefaultsUnreadableError";
  }
}

/**
 * What a new session of an agent starts with (docs/protocol.md §10): per agent, settings by name.
 * A session's own configuration, given when it is created, wins over these. Written whole, to a
 * temporary file and then renamed, and private to the account, like the session index (json-file.ts).
 */
export class AgentDefaults {
  readonly #file: JsonFile<ReadonlyMap<string, Record<string, string>>>;

  private constructor(path: string, agents: Map<string, Record<string, string>>) {
    this.#file = new JsonFile<ReadonlyMap<string, Record<string, string>>>(
      path,
      agents,
      (value) => ({
        version: 1,
        agents: Object.fromEntries(value),
      }),
    );
  }

  static async load(path: string): Promise<AgentDefaults> {
    const parsed = await readJsonFile(
      path,
      DefaultsSchema,
      (detail) => new DefaultsUnreadableError(path, detail),
    );
    return new AgentDefaults(path, new Map(Object.entries(parsed?.agents ?? {})));
  }

  get(agent: string): Record<string, string> {
    return { ...(this.#file.value.get(agent) ?? {}) };
  }

  async set(agent: string, config: Record<string, string>): Promise<void> {
    await this.#file.change((current) => {
      const agents = new Map(current);
      if (Object.keys(config).length === 0) agents.delete(agent);
      else agents.set(agent, { ...config });
      return { value: agents, answer: undefined };
    });
  }
}

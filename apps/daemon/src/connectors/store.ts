import {
  ConnectorAuthSchema,
  ConnectorNameSchema,
  ConnectorTransportSchema,
} from "@cycle/protocol";
import { z } from "zod";
import { JsonFile, readJsonFile } from "../json-file.ts";

/**
 * The two stores behind connectors (docs/protocol.md §14, note 2026-11-19-connectors-behind-a-daemon-gateway).
 * Each is an interface so that a cloud can stand in for the files: the catalog can become the
 * account's list, the vault a broker that lends short-lived tokens. Nothing above them knows which.
 */

/** A connector as the catalog keeps it. No secret is here. */
export const CatalogEntrySchema = z.object({
  id: z.string(),
  name: ConnectorNameSchema,
  enabled: z.boolean(),
  transport: ConnectorTransportSchema,
  auth: ConnectorAuthSchema,
  createdAt: z.string(),
  /**
   * Set for an http server a plugin of one agent brings (docs/protocol.md §15): made and removed with the plugin,
   * given to that agent's sessions only, under the name the agent knows the plugin's server by.
   */
  origin: z
    .object({
      type: z.literal("plugin"),
      agentId: z.string(),
      pluginId: z.string(),
      /** The plugin's name as its agent gives it, to say whose the server is. */
      pluginName: z.string().optional(),
      server: z.string(),
      agentName: z.string(),
      /** Request headers as the plugin wrote them. A `${NAME}` is filled from the vault's `env` as a request goes out. */
      headers: z.record(z.string(), z.string()),
    })
    .optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

/** What the vault keeps for a connector: everything that must not reach a client or an agent. */
export const CredentialsSchema = z.object({
  /** Request headers for an http connector, by name. */
  headers: z.record(z.string(), z.string()),
  /** Environment variables for a stdio connector, by name. */
  env: z.record(z.string(), z.string()),
  oauth: z
    .object({
      /** Where the server's authorization is, as found when signing in. */
      issuer: z.string().optional(),
      authorizationEndpoint: z.string(),
      tokenEndpoint: z.string(),
      revocationEndpoint: z.string().optional(),
      /** The resource the token is for (RFC 8707), when the server named one. */
      resource: z.string().optional(),
      client: z.object({
        clientId: z.string(),
        clientSecret: z.string().optional(),
        /** The redirect the client was registered with; another one needs a new registration. */
        redirectUri: z.string().optional(),
        /** Registered by Cycle (dynamic registration), not given by the person. */
        registered: z.boolean(),
        /** How the client proves itself at the token endpoint when it has a secret. */
        tokenEndpointAuthMethod: z
          .enum(["none", "client_secret_post", "client_secret_basic"])
          .optional(),
      }),
      tokens: z
        .object({
          accessToken: z.string(),
          refreshToken: z.string().optional(),
          /** Milliseconds since the epoch. */
          expiresAt: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type Credentials = z.infer<typeof CredentialsSchema>;

export const emptyCredentials = (): Credentials => ({ headers: {}, env: {} });

export interface ConnectorCatalog {
  list(): Promise<CatalogEntry[]>;
  get(id: string): Promise<CatalogEntry | undefined>;
  put(entry: CatalogEntry): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface CredentialVault {
  get(id: string): Promise<Credentials>;
  put(id: string, credentials: Credentials): Promise<void>;
  remove(id: string): Promise<void>;
}

/** A store's file is there but cannot be read. It is not replaced. */
export class ConnectorFileUnreadableError extends Error {
  constructor(path: string, detail: string) {
    super(`${path} cannot be read (${detail}). Fix or move it; it is not replaced.`);
    this.name = "ConnectorFileUnreadableError";
  }
}

/**
 * A map kept whole in one JSON file (json-file.ts). The folder is the connectors' own and 0700, the file 0600, since the
 * vault's file holds keys.
 */
class JsonMapFile<T> {
  readonly #file: JsonFile<ReadonlyMap<string, T>>;

  private constructor(path: string, items: Map<string, T>) {
    this.#file = new JsonFile<ReadonlyMap<string, T>>(
      path,
      items,
      (value) => ({ version: 1, items: Object.fromEntries(value) }),
      { ownFolder: true },
    );
  }

  static async load<T>(path: string, item: z.ZodType<T>): Promise<JsonMapFile<T>> {
    const parsed = await readJsonFile(
      path,
      z.object({ version: z.literal(1), items: z.record(z.string(), item) }),
      (detail) => new ConnectorFileUnreadableError(path, detail),
    );
    return new JsonMapFile<T>(path, new Map(Object.entries(parsed?.items ?? {})));
  }

  values(): T[] {
    return [...this.#file.value.values()];
  }

  get(id: string): T | undefined {
    return this.#file.value.get(id);
  }

  change(apply: (items: Map<string, T>) => void): Promise<void> {
    return this.#file.change((current) => {
      const items = new Map(current);
      apply(items);
      return { value: items, answer: undefined };
    });
  }
}

/** The catalog in `$CYCLE_HOME/connectors/catalog.json`. */
export class FileConnectorCatalog implements ConnectorCatalog {
  readonly #file: JsonMapFile<CatalogEntry>;

  private constructor(file: JsonMapFile<CatalogEntry>) {
    this.#file = file;
  }

  static async load(path: string): Promise<FileConnectorCatalog> {
    return new FileConnectorCatalog(await JsonMapFile.load(path, CatalogEntrySchema));
  }

  async list(): Promise<CatalogEntry[]> {
    return this.#file.values().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<CatalogEntry | undefined> {
    return this.#file.get(id);
  }

  put(entry: CatalogEntry): Promise<void> {
    return this.#file.change((items) => items.set(entry.id, entry));
  }

  remove(id: string): Promise<void> {
    return this.#file.change((items) => items.delete(id));
  }
}

/** The vault in `$CYCLE_HOME/connectors/credentials.json`, mode 0600. */
export class FileCredentialVault implements CredentialVault {
  readonly #file: JsonMapFile<Credentials>;

  private constructor(file: JsonMapFile<Credentials>) {
    this.#file = file;
  }

  static async load(path: string): Promise<FileCredentialVault> {
    return new FileCredentialVault(await JsonMapFile.load(path, CredentialsSchema));
  }

  async get(id: string): Promise<Credentials> {
    const found = this.#file.get(id);
    return found === undefined ? emptyCredentials() : structuredClone(found);
  }

  put(id: string, credentials: Credentials): Promise<void> {
    return this.#file.change((items) => items.set(id, structuredClone(credentials)));
  }

  remove(id: string): Promise<void> {
    return this.#file.change((items) => items.delete(id));
  }
}

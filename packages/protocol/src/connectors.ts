import { z } from "zod";
import { cycleMethod } from "./method.ts";
import { DoneSchema } from "./methods.ts";

/**
 * Connectors (docs/protocol.md §14): MCP servers Cycle keeps for every agent, signed in to once.
 * Secrets go in and never come out: what a client reads says which names have a value, not the value.
 */

/** What an agent sees the server as. Unique among a daemon's connectors. */
export const ConnectorNameSchema = z.string().regex(/^[a-z0-9_-]{1,32}$/);

/** A header or environment variable name a secret is kept under. */
const SecretName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const ConnectorTransportSchema = z.discriminatedUnion("type", [
  /** Streamable HTTP. https, or http to a loopback address. */
  z.object({ type: z.literal("http"), url: z.string().min(1).max(2048) }),
  /** A process the daemon starts on its own machine. `cwd`: absolute, or absent for the session's folder. */
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64),
    cwd: z.string().min(1).max(4096).optional(),
  }),
]);
export type ConnectorTransport = z.infer<typeof ConnectorTransportSchema>;

export const ConnectorAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  /** MCP's authorization (OAuth 2.1 with PKCE). `clientId` only for a server without dynamic registration. */
  z.object({
    type: z.literal("oauth"),
    clientId: z.string().min(1).max(512).optional(),
    scopes: z.array(z.string().min(1).max(256)).max(32).optional(),
  }),
]);
export type ConnectorAuth = z.infer<typeof ConnectorAuthSchema>;

/** Why a connector is in `error`: a fixed word, never a server's own message. */
export const ConnectorErrorReasonSchema = z.enum([
  "unreachable",
  "auth_failed",
  "spawn_failed",
  "protocol",
]);
export type ConnectorErrorReason = z.infer<typeof ConnectorErrorReasonSchema>;

export const ConnectorStatusSchema = z.object({
  state: z.enum(["ready", "needs_auth", "disabled", "error"]),
  reason: ConnectorErrorReasonSchema.optional(),
});
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;

/**
 * Where a connector that nobody added comes from: an http server a plugin of one agent brings (§15). The daemon
 * makes, switches and removes it with the plugin, and gives it to that agent's sessions only.
 */
export const ConnectorOriginSchema = z.object({
  type: z.literal("plugin"),
  agentId: z.string(),
  pluginId: z.string(),
  /** The plugin's name, to show: the id is the agent's own and is not taken apart. Absent from an older daemon. */
  pluginName: z.string().optional(),
  server: z.string(),
});
export type ConnectorOrigin = z.infer<typeof ConnectorOriginSchema>;

export const ConnectorSchema = z.object({
  id: z.string(),
  name: ConnectorNameSchema,
  enabled: z.boolean(),
  transport: ConnectorTransportSchema,
  auth: ConnectorAuthSchema,
  /** The names that have a secret: request headers (http) and environment variables (stdio). Never the values. */
  secrets: z.object({ headers: z.array(z.string()), env: z.array(z.string()) }),
  /** OAuth only: whether the daemon holds a token for it. */
  authorized: z.boolean(),
  status: ConnectorStatusSchema,
  /** Absent for one a person added. */
  origin: ConnectorOriginSchema.optional(),
  /** The names it needs a value for (written as `secrets.env`); those in `secrets.env` have one. */
  requires: z.array(z.string()).optional(),
});
export type Connector = z.infer<typeof ConnectorSchema>;

/** Written, never read back. A null value removes that name; a name not given keeps its value. */
export const ConnectorSecretsSchema = z.object({
  headers: z.record(SecretName, z.string().max(8192).nullable()).optional(),
  env: z.record(SecretName, z.string().max(8192).nullable()).optional(),
});
export type ConnectorSecrets = z.infer<typeof ConnectorSecretsSchema>;

const ConnectorId = z.string().min(1).max(64);

export const connectorsList = cycleMethod(
  "_cycle/connectors/list",
  z.object({}),
  z.object({ connectors: z.array(ConnectorSchema) }),
);

export const connectorsAdd = cycleMethod(
  "_cycle/connectors/add",
  z.object({
    name: ConnectorNameSchema,
    enabled: z.boolean().optional(),
    transport: ConnectorTransportSchema,
    auth: ConnectorAuthSchema,
    secrets: ConnectorSecretsSchema.optional(),
  }),
  z.object({ connector: ConnectorSchema }),
);

export const connectorsUpdate = cycleMethod(
  "_cycle/connectors/update",
  z.object({
    id: ConnectorId,
    name: ConnectorNameSchema.optional(),
    enabled: z.boolean().optional(),
    transport: ConnectorTransportSchema.optional(),
    auth: ConnectorAuthSchema.optional(),
    secrets: ConnectorSecretsSchema.optional(),
  }),
  z.object({ connector: ConnectorSchema }),
);

export const connectorsRemove = cycleMethod(
  "_cycle/connectors/remove",
  z.object({ id: ConnectorId }),
  DoneSchema,
);

/**
 * Starts signing in. `redirectUri` is the client's own loopback callback; the daemon keeps the PKCE
 * verifier, so the code the browser brings back is of no use anywhere else.
 */
export const connectorsAuthStart = cycleMethod(
  "_cycle/connectors/auth/start",
  z.object({ id: ConnectorId, redirectUri: z.string().min(1).max(2048) }),
  z.object({ flowId: z.string(), authorizationUrl: z.string() }),
);

/** Ends signing in with what the browser brought back to the callback: a code and state, or an error. */
export const connectorsAuthFinish = cycleMethod(
  "_cycle/connectors/auth/finish",
  z.object({
    flowId: z.string().min(1).max(64),
    code: z.string().min(1).max(4096).optional(),
    state: z.string().min(1).max(512).optional(),
    error: z.string().min(1).max(256).optional(),
  }),
  z.object({ connector: ConnectorSchema }),
);

/** Forgets the connector's token and registration. */
export const connectorsAuthClear = cycleMethod(
  "_cycle/connectors/auth/clear",
  z.object({ id: ConnectorId }),
  z.object({ connector: ConnectorSchema }),
);

/** Sent to every client when a connector is added, changed, removed, or its status moves. No params. */
export const CONNECTORS_CHANGED = "_cycle/connectors_changed";

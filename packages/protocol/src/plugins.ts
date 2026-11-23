import { z } from "zod";
import { cycleMethod } from "./method.ts";
import { DoneSchema } from "./methods.ts";

/**
 * Plugins (docs/protocol.md §15): an agent's own extension packages. They are the agent's: what is here is what
 * any agent's plugins have in common, and an `id` is the agent's to make sense of, never a client's to take apart.
 */

const AgentId = z.string().min(1).max(64);
/** Opaque to a client. Claude's is `name@source`. */
const PluginId = z.string().min(1).max(512);
const SourceId = z.string().min(1).max(256);

/** Where a source is: a fixed word, for a client to say it in its own words. */
export const PluginSourceKindSchema = z.enum(["builtin", "git", "directory", "url", "other"]);
export type PluginSourceKind = z.infer<typeof PluginSourceKindSchema>;

/** Where plugins come from (Claude: a marketplace). */
export const PluginSourceSchema = z.object({
  agentId: z.string(),
  id: z.string(),
  name: z.string(),
  kind: PluginSourceKindSchema,
  /** What the person gave when adding it, to show. */
  location: z.string().optional(),
  /** False for the directory an agent comes with. */
  removable: z.boolean(),
});
export type PluginSource = z.infer<typeof PluginSourceSchema>;

/** What a plugin brings, by how many. Hooks, commands and MCP servers are the parts that run code. */
export const PluginContentsSchema = z.object({
  skills: z.number().int().nonnegative(),
  commands: z.number().int().nonnegative(),
  agents: z.number().int().nonnegative(),
  hooks: z.number().int().nonnegative(),
  mcpServers: z.number().int().nonnegative(),
});
export type PluginContents = z.infer<typeof PluginContentsSchema>;

/**
 * An MCP server a plugin brings. `cycle`: through Cycle's gateway, as the connector named (§14), where it is signed
 * in to. `agent`: started by the agent itself, nothing of Cycle's in between.
 */
export const PluginServerSchema = z.object({
  name: z.string(),
  by: z.enum(["cycle", "agent"]),
  connectorId: z.string().optional(),
});
export type PluginServer = z.infer<typeof PluginServerSchema>;

export const PluginScopeSchema = z.enum(["user", "project"]);
export type PluginScope = z.infer<typeof PluginScopeSchema>;

export const PluginSchema = z.object({
  agentId: z.string(),
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  sourceId: z.string(),
  installed: z.boolean(),
  /** The rest only of an installed one. */
  enabled: z.boolean().optional(),
  scope: PluginScopeSchema.optional(),
  contents: PluginContentsSchema.optional(),
  servers: z.array(PluginServerSchema).optional(),
});
export type Plugin = z.infer<typeof PluginSchema>;

/** Why an agent's own machinery did not do it: a fixed word. What it said is in `detail`, for a person. */
export const PluginFailureReasonSchema = z.enum([
  "not_found",
  "needs_command",
  "unavailable",
  "timeout",
  "failed",
]);
export type PluginFailureReason = z.infer<typeof PluginFailureReasonSchema>;

/** Said by a client only after the person agreed: a plugin can run code on the daemon's machine. */
const Acknowledged = z.literal(true);

/** The installed plugins of an agent, and where its plugins come from. */
export const pluginsList = cycleMethod(
  "_cycle/plugins/list",
  z.object({ agentId: AgentId }),
  z.object({ sources: z.array(PluginSourceSchema), plugins: z.array(PluginSchema) }),
);

export const PLUGINS_PAGE_DEFAULT = 50;
export const PLUGINS_PAGE_MAX = 200;

/** What can be installed, a page at a time: an agent's directory can hold thousands. */
export const pluginsAvailable = cycleMethod(
  "_cycle/plugins/available",
  z.object({
    agentId: AgentId,
    sourceId: SourceId.optional(),
    query: z.string().max(256).optional(),
    cursor: z.string().max(64).optional(),
    limit: z.number().int().min(1).max(PLUGINS_PAGE_MAX).optional(),
  }),
  z.object({
    plugins: z.array(PluginSchema),
    nextCursor: z.string().optional(),
    total: z.number().int().nonnegative(),
  }),
);

export const pluginsInstall = cycleMethod(
  "_cycle/plugins/install",
  z.object({ agentId: AgentId, id: PluginId, acknowledged: Acknowledged }),
  z.object({ plugin: PluginSchema }),
);

export const pluginsUninstall = cycleMethod(
  "_cycle/plugins/uninstall",
  z.object({ agentId: AgentId, id: PluginId }),
  DoneSchema,
);

export const pluginsUpdate = cycleMethod(
  "_cycle/plugins/update",
  z.object({ agentId: AgentId, id: PluginId }),
  z.object({ plugin: PluginSchema, updated: z.boolean() }),
);

export const pluginsSetEnabled = cycleMethod(
  "_cycle/plugins/set_enabled",
  z.object({ agentId: AgentId, id: PluginId, enabled: z.boolean() }),
  z.object({ plugin: PluginSchema }),
);

/** `location` is the agent's to read (Claude: `owner/repo`, a git or https address, a path on the daemon's machine). */
export const pluginSourcesAdd = cycleMethod(
  "_cycle/plugins/sources/add",
  z.object({ agentId: AgentId, location: z.string().min(1).max(2048), acknowledged: Acknowledged }),
  z.object({ source: PluginSourceSchema }),
);

export const pluginSourcesRemove = cycleMethod(
  "_cycle/plugins/sources/remove",
  z.object({ agentId: AgentId, id: SourceId }),
  DoneSchema,
);

/** Fetches a source's list again; every source when none is named. */
export const pluginSourcesRefresh = cycleMethod(
  "_cycle/plugins/sources/refresh",
  z.object({ agentId: AgentId, id: SourceId.optional() }),
  DoneSchema,
);

/** Sent to every client when an agent's plugins or sources change. */
export const PLUGINS_CHANGED = "_cycle/plugins_changed";
export const PluginsChangedSchema = z.object({ agentId: z.string() });

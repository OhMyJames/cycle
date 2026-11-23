import { z } from "zod";
import { cycleMethod } from "./method.ts";
import { PromptCapabilitiesSchema } from "./prompt.ts";

const SessionId = z.string();

export const DoneSchema = z.object({});

/** What a daemon knows of an agent it can run. `configSchema` is JSON Schema. */
export const AgentInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  available: z.boolean(),
  configSchema: z.record(z.string(), z.unknown()),
  /** What the agent takes in a prompt beyond text and links (decision 0010). Absent: nothing more. */
  promptCapabilities: PromptCapabilitiesSchema.optional(),
  /** It can take a prompt into the turn that is running (docs/protocol.md §8). Absent: it cannot. */
  steer: z.boolean().optional(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const agentsList = cycleMethod(
  "_cycle/agents/list",
  z.object({}),
  z.object({ agents: z.array(AgentInfoSchema) }),
);

/** What a session of an agent is configured with: setting by name, each a string. */
export const AgentConfigSchema = z.record(z.string(), z.string());

export const agentDefaultsRead = cycleMethod(
  "_cycle/agent_defaults/read",
  z.object({ agent: z.string() }),
  z.object({ config: AgentConfigSchema }),
);

export const agentDefaultsSet = cycleMethod(
  "_cycle/agent_defaults/set",
  z.object({ agent: z.string(), config: AgentConfigSchema }),
  DoneSchema,
);

export const sessionDismissBackground = cycleMethod(
  "_cycle/session/dismiss_background",
  z.object({ sessionId: SessionId, taskIds: z.array(z.string()).min(1) }),
  z.object({ dismissed: z.number().int().nonnegative() }),
);

/**
 * Stops one sub-agent of a session, and nothing else (docs/protocol.md §9, CYCL-143). `stopping` is false when there was
 * nothing to stop: it is not running (any more), or its agent did not say it can be stopped. Its end comes as its
 * `subagent_update`, as any other.
 */
export const sessionStopSubagent = cycleMethod(
  "_cycle/session/stop_subagent",
  z.object({ sessionId: SessionId, childId: z.string().min(1) }),
  z.object({ stopping: z.boolean() }),
);

export const sessionArchive = cycleMethod(
  "_cycle/session/archive",
  z.object({ sessionId: SessionId }),
  DoneSchema,
);

export const sessionUnarchive = cycleMethod(
  "_cycle/session/unarchive",
  z.object({ sessionId: SessionId }),
  DoneSchema,
);

/** Until ACP's `session/set_title` leaves unstable. */
export const sessionSetTitle = cycleMethod(
  "_cycle/session/set_title",
  z.object({ sessionId: SessionId, title: z.string().min(1) }),
  DoneSchema,
);

/** What `_cycle/files/search` finds (docs/protocol.md §8): paths, never contents. */
export const FileEntrySchema = z.object({ path: z.string(), kind: z.enum(["file", "folder"]) });
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const filesSearch = cycleMethod(
  "_cycle/files/search",
  // In a session's folder, or in a folder of a conversation that has no session yet: exactly one of the two.
  z
    .object({
      sessionId: SessionId.optional(),
      cwd: z.string().min(1).max(4096).optional(),
      query: z.string().max(200),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .refine((p) => (p.sessionId === undefined) !== (p.cwd === undefined), {
      message: "Give either sessionId or cwd",
    }),
  z.object({ root: z.string(), entries: z.array(FileEntrySchema), truncated: z.boolean() }),
);

/** What `_cycle/folders/list` gives (docs/protocol.md §8): the names of folders, never files or contents. */
export const FolderListSchema = z.object({
  /** The real path (links resolved) of what was listed. */
  path: z.string(),
  /** One level up; null at the root. */
  parent: z.string().nullable(),
  home: z.string(),
  folders: z.array(z.object({ name: z.string() })),
  truncated: z.boolean(),
});
export type FolderList = z.infer<typeof FolderListSchema>;

export const foldersList = cycleMethod(
  "_cycle/folders/list",
  z.object({
    /** Absolute. Absent: the daemon's user's home. */
    path: z.string().min(1).max(4096).optional(),
    /** Names that start with a dot are given only when asked for. */
    hidden: z.boolean().optional(),
  }),
  FolderListSchema,
);

/**
 * Whether a folder may run the commands its own configuration names (hooks, MCP helpers), as the
 * daemon has it on record (docs/protocol.md §8 "信任文件夹"). `null`: nobody has decided.
 */
export const TrustSchema = z.object({
  /** The real path (links resolved) of the folder asked about. */
  path: z.string(),
  trusted: z.boolean().nullable(),
  /** The folder the decision is recorded on: `path` itself or one above it. Null when there is none. */
  from: z.string().nullable(),
});
export type Trust = z.infer<typeof TrustSchema>;

export const trustRead = cycleMethod(
  "_cycle/trust/read",
  z.object({ path: z.string().min(1).max(4096) }),
  TrustSchema,
);

export const trustSet = cycleMethod(
  "_cycle/trust/set",
  z.object({ path: z.string().min(1).max(4096), trusted: z.boolean() }),
  TrustSchema,
);

/**
 * Says the client has seen the session up to `seq`. `readSeq` only moves forward; `seq` beyond the
 * session's last record is refused. See docs/protocol.md §6 "已读".
 */
export const sessionMarkRead = cycleMethod(
  "_cycle/session/mark_read",
  z.object({ sessionId: SessionId, seq: z.number().int().nonnegative() }),
  DoneSchema,
);

/** Notifications the daemon sends. */
export const sessionListChanged = z.object({});

export const requestResolved = z.object({
  sessionId: SessionId,
  requestId: z.union([z.string(), z.number()]),
  /** What settled it: the chosen outcome, or why it was aborted. */
  outcome: z.unknown(),
});
export const NOTIFICATIONS = {
  sessionListChanged: "_cycle/session_list_changed",
  requestResolved: "_cycle/request_resolved",
  agentDefaultsChanged: "_cycle/agent_defaults_changed",
} as const;

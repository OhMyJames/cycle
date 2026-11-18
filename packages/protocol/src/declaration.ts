import type { AgentCapabilities, AttachmentKind } from "./model.ts";

/**
 * The operations an agent may do beyond what every agent does, by id: entity, a dot, the verb. The
 * agent contract's ids, not the wire's method names. A list that is closed, so a typo is an error
 * where a free string would be a silent "no".
 */
export const OPERATIONS = [
  // Every agent that exists declares these seven; a third agent may leave one out.
  "session.fork",
  "session.rename",
  "session.archive",
  "session.compact",
  "session.rewind",
  "turn.steer",
  "turn.review",
  "session.tag",
  "session.rewindFiles",
  "session.context",
  "session.commands",
  "task.stop",
  "mcp.reconnect",
  // shortcut: a parameter of `session.create`, named as an operation; upgrade when step 18 makes options
  "session.directories",
  // shortcut: codex's `features.*` switches; upgrade when step 19 separates AgentSettings
  "settings.features",
  // An agent that enters a worktree on its own says so, and Cycle makes the worktree it enters.
  "worktree.enter",
] as const;

export type OperationId = (typeof OPERATIONS)[number];

/** What an agent may be given besides its own tools. */
export type ExtensionKind = "mcp" | "plugins" | "skills" | "hooks" | "subagents";

/** Whether Cycle may change what an agent is given, or only read it. */
export type ExtensionAccess = "read" | "edit";

/** What an agent can do beyond what every agent does. */
export interface AgentDeclaration {
  /** The ids it does beyond the core, no duplicates. */
  operations: OperationId[];
  /** What a prompt may carry. */
  inputs: AttachmentKind[];
  /** What it is given, and whether Cycle may change it or only read it. A kind left out is refused. */
  extensions: Partial<Record<ExtensionKind, ExtensionAccess>>;
  /** Who signs the owner in: Cycle, its own command line, or nobody (no account is read). */
  account: "cycle" | "cli" | "none";
}

export const declares = (declaration: AgentDeclaration, id: OperationId): boolean =>
  declaration.operations.includes(id);

/** `gives(d, "mcp")` is true for read or edit; `gives(d, "mcp", "edit")` for edit alone. */
export const gives = (
  declaration: AgentDeclaration,
  kind: ExtensionKind,
  access: ExtensionAccess = "read",
): boolean => {
  const given = declaration.extensions[kind];
  return given === "edit" || (given === "read" && access === "read");
};

/** What every agent there is does, and the declaration of each says so. */
const ALWAYS: OperationId[] = [
  "session.fork",
  "session.rename",
  "session.archive",
  "session.compact",
  "session.rewind",
  "turn.steer",
  "turn.review",
];

/**
 * A declaration built the old way, from the flags and the two methods that had none.
 * shortcut: it goes with `AgentCapabilities`, when the daemon and the page read the declaration
 * alone; upgrade when `AgentCapabilities` is removed.
 */
export function declarationFromCapabilities(
  capabilities: AgentCapabilities,
  has: { stopTask: boolean; readContext: boolean },
): AgentDeclaration {
  const edits = capabilities.connector === "edit";
  const operations: OperationId[] = [...ALWAYS];
  if (capabilities.tags) operations.push("session.tag");
  if (capabilities.rewindFiles) operations.push("session.rewindFiles");
  if (has.readContext) operations.push("session.context");
  if (capabilities.commands) operations.push("session.commands");
  if (has.stopTask) operations.push("task.stop");
  if (capabilities.mcpReconnect) operations.push("mcp.reconnect");
  if (capabilities.directories) operations.push("session.directories");
  if (capabilities.features) operations.push("settings.features");
  const extensions: AgentDeclaration["extensions"] = {
    mcp: edits ? "edit" : "read",
    skills: capabilities.hooks ? "edit" : "read",
  };
  if (edits) extensions.plugins = "edit";
  if (capabilities.hooks) extensions.hooks = "edit";
  if (capabilities.subagents) extensions.subagents = "read";
  return {
    operations,
    inputs: [...capabilities.attachments],
    extensions,
    account: capabilities.login ? "cycle" : "cli",
  };
}

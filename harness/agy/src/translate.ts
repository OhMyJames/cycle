import {
  RequestError,
  type SessionUpdate,
  type ToolCallStatus,
} from "@agentclientprotocol/sdk/experimental/v2";
import { describePromptProblem, META, normalizePrompt } from "@cycle/protocol";
import type { V1SessionUpdate, V1ToolCallContent, V1ToolCallPayload } from "./v1.ts";
import { AGY_PROMPT_CAPABILITIES } from "./v1.ts";

const VALID_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

const VALID_STATUSES = new Set<ToolCallStatus>(["pending", "in_progress", "completed", "failed"]);
const MAX_PATCH_BYTES = 100_000;

const normalizeKind = (kind?: string) => (kind && VALID_KINDS.has(kind) ? kind : "other");

/**
 * agy's own task list: each call sends the whole list as `rawInput.steps` (`{ title, status }`). Seen in a real
 * session; agy never sends a v1 `plan` itself.
 */
export const AGY_PLAN_TOOL = "update_steps";

/** agy's step statuses as ACP's: `done` is `completed`; a `failed` step is over, not left to do, so it counts as done. */
const stepStatus = (status: unknown): "pending" | "in_progress" | "completed" =>
  status === "in_progress"
    ? "in_progress"
    : status === "done" || status === "completed" || status === "failed"
      ? "completed"
      : "pending";

/**
 * The session's `update_steps` calls, by id. An update carries only what changed, so the name and the steps a call
 * started with are remembered until it ends: its rows stay `think` and its plan is sent though the last update is
 * a bare status. The plan goes once the call has finished (a failed one changed nothing), with the session-wide
 * `planId` a v1 `plan` uses, so it replaces the one shown.
 */
export class StepsPlans {
  readonly #steps = new Map<string, unknown>();
  /** The plan last sent for a call, so an update that changes nothing sends nothing. */
  readonly #sent = new Map<string, string>();

  /** For a v1 tool call or its update: whether it is a plan call, and the plan it makes if it has just changed. */
  see(payload: V1ToolCallPayload, planId: string): { plan: boolean; update?: SessionUpdate } {
    const id = payload.toolCallId;
    if (payload.name === AGY_PLAN_TOOL && !this.#steps.has(id)) this.#steps.set(id, undefined);
    if (!this.#steps.has(id)) return { plan: false };
    const given = (payload.rawInput as { steps?: unknown } | undefined)?.steps;
    if (given !== undefined) this.#steps.set(id, given);
    const ended = payload.status === "completed" || payload.status === "failed";
    const steps = this.#steps.get(id);
    const sent = this.#sent.get(id);
    if (ended) {
      this.#steps.delete(id);
      this.#sent.delete(id);
    }
    // A failed call changed nothing; one still going shows its steps as soon as it has them, not when it ends.
    if (payload.status === "failed" || !Array.isArray(steps)) return { plan: true };
    const entries = steps.flatMap((step: { title?: unknown; status?: unknown } | null) =>
      typeof step?.title === "string" && step.title.trim() !== ""
        ? [{ content: step.title, priority: "medium", status: stepStatus(step.status) }]
        : [],
    );
    const key = JSON.stringify(entries);
    // Nothing to show yet, or nothing new.
    if (key === sent || (entries.length === 0 && !ended)) return { plan: true };
    if (!ended) this.#sent.set(id, key);
    return {
      plan: true,
      update: {
        sessionUpdate: "plan_update",
        plan: { type: "items", planId, entries },
      } as SessionUpdate,
    };
  }
}

const normalizeStatus = (status?: string): ToolCallStatus =>
  status && VALID_STATUSES.has(status as ToolCallStatus)
    ? (status as ToolCallStatus)
    : "in_progress";

/**
 * Checks a prompt before it goes to `agy`: as the protocol reads it (normalizePrompt), and then what agy itself cannot
 * take. agy 1.5.15 silently drops a binary `resource` (`blob`, such as a PDF).
 */
export const validatePromptBlocks = (blocks: readonly unknown[]): void => {
  const normalized = normalizePrompt(blocks, AGY_PROMPT_CAPABILITIES, {
    limits: false,
    pdf: false,
  });
  if (!normalized.ok) {
    throw new RequestError(-32602, describePromptProblem(normalized.problem), normalized.problem);
  }
};

const linesOf = (text: string): string[] => {
  if (text === "") return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

type TranslatedDiff = {
  block: {
    type: "diff";
    changes: Array<{ operation: "add" | "modify"; path: string }>;
    patch: { format: "git_patch"; text: string } | null;
  };
  additions: number;
  deletions: number;
  created: boolean;
};

const translateV1Diff = (
  path: string,
  oldText: string | null | undefined,
  newText: string,
): TranslatedDiff => {
  const created = oldText === null || oldText === undefined;
  const at = path.startsWith("/") ? path : `/${path}`;
  const header = [
    `diff --git a${at} b${at}`,
    created ? "--- /dev/null" : `--- a${at}`,
    `+++ b${at}`,
  ].join("\n");

  const newLines = linesOf(newText);
  if (created) {
    const additions = newLines.length;
    const body =
      additions > 0
        ? `${header}\n@@ -0,0 +1,${additions} @@\n${newLines.map((l) => `+${l}`).join("\n")}\n`
        : `${header}\n`;
    return {
      block: {
        type: "diff",
        changes: [{ operation: "add", path }],
        patch: body.length <= MAX_PATCH_BYTES ? { format: "git_patch", text: body } : null,
      },
      additions,
      deletions: 0,
      created: true,
    };
  }

  const oldLines = linesOf(oldText);
  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);
  const deletions = oldMid.length;
  const additions = newMid.length;

  if (deletions === 0 && additions === 0) {
    return {
      block: {
        type: "diff",
        changes: [{ operation: "modify", path }],
        patch: null,
      },
      additions: 0,
      deletions: 0,
      created: false,
    };
  }

  const ctxBefore = Math.min(3, prefix);
  const ctxAfter = Math.min(3, suffix);
  const oldStart = prefix - ctxBefore + 1;
  const newStart = prefix - ctxBefore + 1;
  const oldCount = ctxBefore + deletions + ctxAfter;
  const newCount = ctxBefore + additions + ctxAfter;
  const hunkLines = [
    ...oldLines.slice(prefix - ctxBefore, prefix).map((l) => ` ${l}`),
    ...oldMid.map((l) => `-${l}`),
    ...newMid.map((l) => `+${l}`),
    ...oldLines
      .slice(oldLines.length - suffix, oldLines.length - suffix + ctxAfter)
      .map((l) => ` ${l}`),
  ];
  const body = `${header}\n@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${hunkLines.join("\n")}\n`;
  return {
    block: {
      type: "diff",
      changes: [{ operation: "modify", path }],
      patch: body.length <= MAX_PATCH_BYTES ? { format: "git_patch", text: body } : null,
    },
    additions,
    deletions,
    created: false,
  };
};

const translateToolContent = (
  content: readonly V1ToolCallContent[] | undefined,
): {
  content?: unknown[];
  editStats?: { additions: number; deletions: number; created: boolean };
} => {
  if (!content) return {};
  const out: unknown[] = [];
  let additions = 0;
  let deletions = 0;
  let created = false;
  let hasDiff = false;

  for (const item of content) {
    if (item.type === "diff") {
      const translated = translateV1Diff(item.path, item.oldText, item.newText);
      out.push(translated.block);
      hasDiff = true;
      additions += translated.additions;
      deletions += translated.deletions;
      if (translated.created) created = true;
    } else {
      out.push(item);
    }
  }

  return {
    content: out,
    ...(hasDiff ? { editStats: { additions, deletions, created } } : {}),
  };
};

/** Extract structured `_meta["cycle/toolResult"]` where agy gives exact numbers (command exit code, edit diff counts). */
const toolResultMeta = (
  payload: V1ToolCallPayload,
  editStats?: { additions: number; deletions: number; created: boolean },
): Record<string, unknown> | undefined => {
  if (payload.status !== "completed" && payload.status !== "failed") return undefined;
  const raw = payload.rawOutput as Record<string, unknown> | undefined;
  if (
    payload.kind === "execute" &&
    raw &&
    typeof raw.exit_code === "number" &&
    Number.isInteger(raw.exit_code) &&
    raw.exit_code >= 0
  ) {
    return { [META.toolResult]: { run: { exitCode: raw.exit_code } } };
  }
  if (payload.kind === "read" && payload.status === "completed" && raw) {
    // UNVERIFIED shape: no real agy read-file output is captured in this repo (fixtures only have
    // the command's `{ output, exit_code }`). Assumed, by analogy with `exit_code`:
    // `rawOutput: { start_line, num_lines, total_lines? }`. Numbers only, never file content.
    const isCount = (v: unknown): v is number =>
      typeof v === "number" && Number.isInteger(v) && v >= 0;
    if (isCount(raw.start_line) && isCount(raw.num_lines)) {
      return {
        [META.toolResult]: {
          read: {
            startLine: raw.start_line,
            numLines: raw.num_lines,
            ...(isCount(raw.total_lines) ? { totalLines: raw.total_lines } : {}),
          },
        },
      };
    }
  }
  if (editStats) {
    return {
      [META.toolResult]: {
        edit: {
          additions: editStats.additions,
          deletions: editStats.deletions,
          ...(editStats.created ? { created: true } : {}),
        },
      },
    };
  }
  return undefined;
};

/** The title to show, or undefined when this payload says nothing new about it. */
const toolTitle = (payload: V1ToolCallPayload, start: boolean): string | undefined => {
  if (
    payload.name === "invoke_subagent" &&
    (payload.title === undefined || payload.title === "" || payload.title === "invoke_subagent")
  ) {
    const raw = payload.rawInput as { Role?: unknown; TypeName?: unknown } | undefined;
    const role =
      typeof raw?.Role === "string" && raw.Role.trim() !== "" ? raw.Role.trim() : undefined;
    if (role !== undefined) return `Sub-agent: ${role}`;
    // An update without the role would put the bare tool name back over the readable title.
    if (!start) return undefined;
  }
  return payload.title ?? (start ? payload.name : undefined);
};

/**
 * Normalize agy's PascalCase tool input keys (`CommandLine`, `Path`, `Query`, `Url`, `Pattern`, `Cwd`) into the
 * lowercase names Cycle's L1 model reads across all agents, without duplicating the values.
 */
const normalizeRawInput = (rawInput: unknown): unknown => {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) return rawInput;
  const input = rawInput as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  const copy = () => {
    out ??= { ...input };
    return out;
  };
  const rename = (from: string, to: string, keepIf: readonly string[] = [to]) => {
    if (typeof input[from] !== "string") return;
    if (keepIf.some((key) => input[key] !== undefined)) return;
    const next = copy();
    next[to] = input[from];
    delete next[from];
  };
  rename("CommandLine", "command");
  rename("Cwd", "cwd");
  rename("Path", "file_path", ["file_path", "path"]);
  rename("Query", "query");
  rename("Url", "url");
  rename("Pattern", "pattern");
  return out ?? rawInput;
};

/**
 * A v1 `tool_call` starts the call, so what it leaves out gets a default. A v1 `tool_call_update` only
 * carries what changed (ACP v1, like v2's `tool_call_update`): a field it leaves out is left out here
 * too, so a progress or result update never resets the title, kind or status shown before.
 */
export const toV2ToolCallUpdate = (payload: V1ToolCallPayload, start = true): SessionUpdate => {
  const { content, editStats } = translateToolContent(payload.content);
  const meta = toolResultMeta(payload, editStats);
  const title = toolTitle(payload, start);
  const rawInput = payload.rawInput !== undefined ? normalizeRawInput(payload.rawInput) : undefined;
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: payload.toolCallId,
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    ...(title !== undefined ? { title } : start ? { title: "Tool" } : {}),
    ...(payload.kind !== undefined || start ? { kind: normalizeKind(payload.kind) } : {}),
    ...(payload.status !== undefined || start
      ? { status: payload.status === undefined ? "pending" : normalizeStatus(payload.status) }
      : {}),
    ...(payload.locations !== undefined ? { locations: payload.locations } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(payload.rawOutput !== undefined ? { rawOutput: payload.rawOutput } : {}),
    ...(meta !== undefined ? { _meta: meta } : {}),
  } as SessionUpdate;
};

/**
 * Translate a single ACP v1 `session/update` payload into ACP v2.
 * Returns `undefined` for updates handled specially by the adapter (like config/mode updates)
 * or unknown future v1 updates that should be dropped safely.
 */
export const translateSimpleUpdate = (
  update: V1SessionUpdate,
  messageId: string,
  planId: string,
  logUnknown: (kind: string) => void,
): SessionUpdate | undefined => {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return {
        sessionUpdate: update.sessionUpdate,
        messageId,
        content: update.content,
      } as SessionUpdate;
    case "tool_call":
      return toV2ToolCallUpdate(update as V1ToolCallPayload);
    case "tool_call_update":
      return toV2ToolCallUpdate(update as V1ToolCallPayload, false);
    case "plan":
      // A v1 plan is the session's whole plan each time: one id for it, so it replaces the one shown.
      return {
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId,
          entries: (update as { entries: unknown[] }).entries,
        },
      } as SessionUpdate;
    case "session_info_update":
      return {
        sessionUpdate: "session_info_update",
        ...((update as { title?: string | null }).title !== undefined
          ? { title: (update as { title?: string | null }).title }
          : {}),
        ...((update as { updatedAt?: string | null }).updatedAt !== undefined
          ? { updatedAt: (update as { updatedAt?: string | null }).updatedAt }
          : {}),
      } as SessionUpdate;
    case "usage_update": {
      const u = update as {
        used: number;
        size: number;
        cost?: { amount: number; currency: string } | null;
      };
      return {
        sessionUpdate: "usage_update",
        used: u.used,
        size: u.size,
        ...(u.cost != null ? { cost: u.cost } : {}),
      } as SessionUpdate;
    }
    case "available_commands_update": {
      const rawCommands = (
        update as {
          availableCommands?: Array<{
            name: string;
            description?: string;
            input?: { hint?: string } | null;
          }>;
        }
      ).availableCommands;
      const availableCommands = (rawCommands ?? [])
        .filter((cmd) => typeof cmd?.name === "string" && cmd.name !== "")
        .map((cmd) => ({
          type: "command" as const,
          name: cmd.name,
          description: cmd.description ?? "",
          ...(typeof cmd.input?.hint === "string" && cmd.input.hint !== ""
            ? { input: { type: "text" as const, hint: cmd.input.hint } }
            : {}),
        }));
      return {
        sessionUpdate: "available_commands_update",
        availableCommands,
      } as SessionUpdate;
    }
    case "user_message_chunk":
      return undefined;
    default:
      logUnknown(String(update.sessionUpdate));
      return undefined;
  }
};

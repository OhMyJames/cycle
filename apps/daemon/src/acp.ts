// The daemon's typed edge with ACP (CYCL-259, D-02): where what comes in untyped (a client's answer, a prompt read back
// from the queue, a `_cycle/*` handler's result) is checked or narrowed once, so the rest of the daemon works with the
// SDK's own types and needs no `as never`.
import type {
  AgentApp,
  AgentContext,
  ContentBlock,
  CreateElicitationResponse,
  ElicitationAcceptAction,
  McpServer,
  RequestPermissionOutcome,
  SystemPrompt,
} from "@agentclientprotocol/sdk/experimental/v2";
import type { CycleMethod } from "@cycle/protocol";
import type { z } from "zod";
import { INTERNAL_ERROR, RpcError } from "./errors.ts";
import type { SessionEntry } from "./index-file.ts";
import type { Logger } from "./logger.ts";
import type { ClientConn } from "./session.ts";

/**
 * One client connection as the daemon uses it. A method is named by a string the daemon chose (an ACP method, or one
 * of Cycle's `_cycle/*`): the SDK's untyped overload takes it as it is.
 */
export const clientConn = (id: string, client: AgentContext): ClientConn => ({
  id,
  notify: (method, params) => client.notify<unknown, string>(method, params),
  request: (method, params) => client.request<unknown, unknown, string>(method, params),
  elicitation: false,
  ackReturns: false,
  updateNotify: false,
});

/**
 * A prompt as the daemon keeps it (in the queue, in the log): it was checked as a prompt (`checkPrompt`, and the SDK's
 * own params check) when it was taken, and nothing changes it since.
 */
export const asPrompt = (blocks: readonly unknown[]): ContentBlock[] => blocks as ContentBlock[];

/**
 * What the index keeps of the request a session was made with, to send again each time its agent starts. It was
 * written from a `session/new` the SDK had checked, and is read back as it was written.
 */
export const madeWith = (
  entry: SessionEntry,
): { mcpServers?: McpServer[]; systemPrompt?: SystemPrompt | null } => ({
  ...(entry.mcpServers !== undefined ? { mcpServers: entry.mcpServers as McpServer[] } : {}),
  ...(entry.systemPrompt !== undefined
    ? { systemPrompt: entry.systemPrompt as SystemPrompt | null }
    : {}),
});

const CANCELLED: RequestPermissionOutcome = { outcome: "cancelled" };

/**
 * A client's answer to a permission request as the agent may see it: a choice of one of the options it offered, or a
 * cancel. Anything else a client sends (an option that was not offered, another kind of outcome) is a cancel: the
 * agent is never handed what it did not offer.
 */
export const permissionOutcome =
  (offered: readonly { optionId: string }[]) =>
  (response: unknown): RequestPermissionOutcome => {
    const outcome = (response as { outcome?: unknown } | null | undefined)?.outcome as
      | { outcome?: unknown; optionId?: unknown }
      | null
      | undefined;
    const optionId = outcome?.optionId;
    if (
      outcome?.outcome === "selected" &&
      typeof optionId === "string" &&
      offered.some((option) => option.optionId === optionId)
    )
      return { outcome: "selected", optionId };
    return CANCELLED;
  };

export const PERMISSION_CANCELLED = CANCELLED;

/**
 * A client's answer to a form as the agent may see it: its action and its content, nothing else a client could add
 * (such as the daemon's own `_meta`). Anything that is not an answer is a cancel.
 */
export const elicitationAnswer = (response: unknown): CreateElicitationResponse => {
  const r = (typeof response === "object" && response !== null ? response : {}) as {
    action?: unknown;
    content?: unknown;
  };
  if (r.action === "accept" && typeof r.content === "object" && r.content !== null)
    return {
      action: "accept",
      content: r.content as NonNullable<ElicitationAcceptAction["content"]>,
    };
  if (r.action === "accept") return { action: "accept" };
  if (r.action === "decline") return { action: "decline" };
  return { action: "cancel" };
};

/** What a `_cycle/*` handler answers: what the method's result schema says, as a caller sends it. */
export type CycleHandler<P extends z.ZodType, R extends z.ZodType> = (
  params: z.output<P>,
) => Promise<z.input<R>> | z.input<R>;

/**
 * Registers one of Cycle's own methods. Its params are parsed by the method's schema before the handler sees them, and
 * its answer is checked against the method's result schema before the client does: an answer the schema refuses is a
 * daemon bug, logged (which method, and where in the answer, never its content) and answered as an internal error
 * rather than sent on for the client to trip over.
 */
export const onCycle = <P extends z.ZodType, R extends z.ZodType>(
  app: AgentApp,
  log: Logger,
  method: CycleMethod<P, R>,
  handler: CycleHandler<P, R>,
): void => {
  app.onRequest<z.output<P>, z.input<R>>(method.name, method.params, async ({ params }) => {
    const result = await handler(params);
    const checked = method.result.safeParse(result);
    if (!checked.success) {
      log.error("result_invalid", {
        method: method.name,
        paths: checked.error.issues.map((issue) => issue.path.join(".") || "(root)").join(","),
      });
      throw new RpcError(INTERNAL_ERROR, "The daemon's answer did not match the method's schema", {
        method: method.name,
      });
    }
    return result;
  });
};

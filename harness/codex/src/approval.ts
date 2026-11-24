import { type AgentContext, methods } from "@agentclientprotocol/sdk/experimental/v2";
import { RpcError } from "@cycle/line-rpc";
import type {
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
  PermissionsRequestApprovalParams,
} from "./wire.generated.ts";

export async function approval(
  method: string,
  raw: unknown,
  client: AgentContext | undefined,
  session: string | undefined,
  turnId: string | undefined,
  signal: AbortSignal | undefined,
  isChild: (threadId: string) => boolean = () => false,
) {
  const p = raw as
    | CommandExecutionRequestApprovalParams
    | FileChangeRequestApprovalParams
    | PermissionsRequestApprovalParams;
  const permissions = method === "item/permissions/requestApproval";
  const files = method === "item/fileChange/requestApproval";
  if (!permissions && !files && method !== "item/commandExecution/requestApproval")
    throw new RpcError(-32601, `Unsupported server request: ${method}`);
  let decision: "accept" | "decline" | "cancel" = "cancel";
  // A sub-agent asks in its own thread, and on its own turns: the daemon shows it in the parent's session (ACP v2).
  const child = isChild(p.threadId);
  if (
    client &&
    session &&
    signal &&
    !signal.aborted &&
    (child || (p.threadId === session && (!turnId || p.turnId === turnId)))
  ) {
    const command = "command" in p ? p.command : undefined;
    const detail = command ?? ("grantRoot" in p ? p.grantRoot : undefined);
    const requested = "permissions" in p ? p.permissions : undefined;
    const title = [
      permissions
        ? "Grant permissions for this turn?"
        : files
          ? "Allow file change?"
          : "Allow command?",
      detail,
      p.reason,
      requested ? JSON.stringify(requested) : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    const answer = await client
      .request(
        methods.client.session.requestPermission,
        {
          sessionId: child ? p.threadId : session,
          title,
          subject: {
            type: "tool_call",
            toolCall: {
              toolCallId: p.itemId,
              name: permissions ? "request_permissions" : files ? "apply_patch" : "exec_command",
              kind: files ? "edit" : permissions ? "other" : "execute",
              rawInput: {
                ...(command ? { command } : {}),
                ...(requested ? { permissions: requested } : {}),
              },
            },
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
        { cancellationSignal: signal, stopWaitingOnCancel: true },
      )
      .catch(() => undefined);
    if (!signal.aborted && answer?.outcome.outcome === "selected")
      decision = answer.outcome.optionId === "allow" ? "accept" : "decline";
  }
  // A refusal is `decline` even when the request's (experimental) `availableDecisions` leaves it out, as it does for a
  // command asking to leave the sandbox: Codex takes it, the command does not run and the turn goes on (seen with a
  // real model, 0.171.0). `cancel` there would end the whole turn.
  if (permissions) {
    const requested = (p as PermissionsRequestApprovalParams).permissions;
    return {
      permissions:
        decision === "accept"
          ? {
              ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
              ...(requested.network ? { network: requested.network } : {}),
            }
          : {},
      scope: "turn",
    };
  }
  return { decision };
}

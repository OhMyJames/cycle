import { type AgentContext, methods } from "@agentclientprotocol/sdk/experimental/v2";
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
) {
  const p = raw as
    | CommandExecutionRequestApprovalParams
    | FileChangeRequestApprovalParams
    | PermissionsRequestApprovalParams;
  const permissions = method === "item/permissions/requestApproval";
  const files = method === "item/fileChange/requestApproval";
  if (!permissions && !files && method !== "item/commandExecution/requestApproval")
    throw new Error("Unsupported server request");
  let decision: "accept" | "decline" | "cancel" = "cancel";
  if (
    client &&
    session &&
    signal &&
    !signal.aborted &&
    p.threadId === session &&
    (!turnId || p.turnId === turnId)
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
          sessionId: session,
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
        { signal } as never,
      )
      .catch(() => undefined);
    if (!signal.aborted && answer?.outcome.outcome === "selected")
      decision = answer.outcome.optionId === "allow" ? "accept" : "decline";
  }
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

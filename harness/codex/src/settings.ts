import type { SessionConfigOption } from "@agentclientprotocol/sdk/experimental/v2";
import { META } from "@cycle/protocol";
import type { Model } from "./wire.generated.ts";
export const modes = [
  {
    value: "default",
    name: "Ask when leaving the sandbox",
    description: "Write in the workspace and ask before going beyond it.",
  },
  {
    value: "untrusted",
    name: "Ask before commands",
    description: "Ask before running commands outside the trusted set.",
  },
  {
    value: "read-only",
    name: "Read only",
    description: "Read files and ask before making changes.",
  },
  {
    value: "auto-review",
    name: "Auto review",
    description: "Let Codex review requests to go beyond the sandbox.",
  },
  {
    value: "plan",
    name: "Plan mode",
    description: "Create a plan and wait before making changes.",
  },
  {
    value: "full-access",
    name: "Full access",
    description: "Run without sandbox restrictions or approval prompts.",
    _meta: { "cycle/danger": true },
  },
] as const;
export type Mode = (typeof modes)[number]["value"];
export type Catalog = readonly Model[];
export function policy(mode: Mode) {
  return {
    approvalPolicy:
      mode === "full-access" ? "never" : mode === "untrusted" ? "untrusted" : "on-request",
    approvalsReviewer: mode === "auto-review" ? "auto_review" : "user",
    sandbox:
      mode === "full-access"
        ? "danger-full-access"
        : mode === "read-only"
          ? "read-only"
          : "workspace-write",
  } as const;
}
export function turnPolicy(mode: Mode, writableRoots: string[] = []) {
  const { sandbox, ...rest } = policy(mode);
  const sandboxPolicy =
    sandbox === "workspace-write"
      ? {
          type: "workspaceWrite",
          writableRoots,
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        }
      : sandbox === "read-only"
        ? { type: "readOnly", networkAccess: false }
        : { type: "dangerFullAccess" };
  return { ...rest, sandboxPolicy };
}
export const options = (mode: Mode, catalog: Catalog = [], model = "default", effort = "default") =>
  [
    {
      configId: "mode",
      name: "Permission mode",
      type: "select",
      currentValue: mode,
      options: [...modes],
    },
    {
      configId: "model",
      name: "Model",
      type: "select" as const,
      currentValue: model,
      options: [
        { value: "default", name: "Default", _meta: { [META.open]: true } },
        ...catalog
          .filter((item) => !item.hidden)
          .map((item) => ({
            value: item.model,
            name: item.displayName,
            description: item.description,
            _meta: {
              [META.efforts]: item.supportedReasoningEfforts.map((item) => item.reasoningEffort),
            },
          })),
      ],
    },
    {
      configId: "effort",
      name: "Effort",
      type: "select" as const,
      currentValue: effort,
      options: [
        { value: "default", name: "Default" },
        ...(catalog.find((item) => item.model === model)?.supportedReasoningEfforts ?? []).map(
          (item) => ({
            value: item.reasoningEffort,
            name: item.description,
          }),
        ),
      ],
    },
  ] satisfies SessionConfigOption[];
export const configSchema = {
  type: "object",
  properties: Object.fromEntries(
    options("default").map((opt) => {
      return [
        opt.configId,
        {
          type: "string",
          title: opt.name,
          default: "default",
          ...(opt.configId === "model" || opt.configId === "effort"
            ? { _meta: { [META.open]: true } }
            : {}),
          oneOf: opt.options.map(({ value, name, ...rest }) => ({
            const: value,
            title: name,
            ...rest,
          })),
        },
      ];
    }),
  ),
};

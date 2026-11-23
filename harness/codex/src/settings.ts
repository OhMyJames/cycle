import type { SessionConfigOption } from "@agentclientprotocol/sdk/experimental/v2";
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
    value: "full-access",
    name: "Full access",
    description: "Run without sandbox restrictions or approval prompts.",
    _meta: { "cycle/danger": true },
  },
] as const;
export type Mode = (typeof modes)[number]["value"];
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
export function turnPolicy(mode: Mode) {
  const { sandbox, ...rest } = policy(mode);
  const sandboxPolicy =
    sandbox === "workspace-write"
      ? {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        }
      : sandbox === "read-only"
        ? { type: "readOnly", networkAccess: false }
        : { type: "dangerFullAccess" };
  return { ...rest, sandboxPolicy };
}
export const options = (mode: Mode) =>
  [
    {
      configId: "mode",
      name: "Permission mode",
      type: "select",
      currentValue: mode,
      options: [...modes],
    },
    ...["model", "effort"].map((id) => ({
      configId: id,
      name: id === "model" ? "Model" : "Effort",
      type: "select" as const,
      currentValue: "default",
      options: [{ value: "default", name: "Default" }],
    })),
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

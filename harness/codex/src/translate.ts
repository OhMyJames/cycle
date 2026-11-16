import type {
  CommandAction,
  HarnessSession,
  Item,
  ItemStatus,
  LimitWindow,
  McpServerInfo,
  McpToolInfo,
  McpServerInput,
  PluginCatalog,
  PluginDetail,
  PluginInfo,
  ModelInfo,
  PromptInput,
  ReviewTarget,
  SessionMode,
  SkillInfo,
  TokenCount,
  Turn,
  Usage,
} from "@cycle/protocol";
import { type ModeInfo, defineModes } from "@cycle/protocol";
import type {
  WireCommandAction,
  WireConfigEdit,
  WireItem,
  WireMcpConfig,
  WireMcpServer,
  WireModel,
  WirePlugin,
  WirePluginDetail,
  WirePluginList,
  WireSandboxPolicy,
  WireSkill,
  WireStatus,
  WireRateLimitWindow,
  WireThread,
  WireTokenBreakdown,
  WireTokenUsage,
  WireTurn,
  WireUnknownItem,
  WireUserInput,
} from "./wire.ts";

/** Pure translations between codex's wire shapes and Cycle's model. */

const STATUS: Record<WireStatus, ItemStatus> = {
  inProgress: "running",
  completed: "completed",
  failed: "failed",
  declined: "declined",
  interrupted: "failed",
};

function status(value: WireStatus | undefined): ItemStatus {
  return (value && STATUS[value]) ?? "running";
}

function json(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** The text of an MCP result: its text parts joined, else the JSON of the rest. */
function resultText(content: unknown[] | null | undefined, structured?: unknown): string | null {
  if (!content?.length) return structured == null ? null : json(structured);
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return json(part);
    })
    .join("\n");
}

function actions(raw: WireCommandAction[] | undefined): CommandAction[] {
  const out: CommandAction[] = [];
  for (const action of raw ?? []) {
    if (action.type === "read") out.push({ type: "read", path: action.path });
    else if (action.type === "listFiles") out.push({ type: "list", path: action.path });
    else if (action.type === "search") {
      out.push({ type: "search", query: action.query, path: action.path });
    }
  }
  return out;
}

function userText(content: WireUserInput[]): string {
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "skill") return `$${part.name}`;
      if (part.type === "mention") return `@${part.name}`;
      return "";
    })
    .join("");
}

function userImages(content: WireUserInput[]): string[] {
  const out: string[] = [];
  for (const part of content) {
    if (part.type === "image" && part.url) out.push(part.url);
    else if (part.type === "localImage") out.push(part.path);
  }
  return out;
}

const KNOWN = new Set([
  "userMessage",
  "agentMessage",
  "plan",
  "reasoning",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
  "sleep",
  "hookPrompt",
  "subAgentActivity",
  "functionCallOutput",
  "enteredReviewMode",
  "exitedReviewMode",
  "contextCompaction",
]);

function isKnown(raw: WireItem | WireUnknownItem): raw is WireItem {
  return KNOWN.has(raw.type);
}

/** Translate a codex thread item into the harness-agnostic model. */
export function toItem(raw: WireItem | WireUnknownItem): Item {
  if (!isKnown(raw)) return { id: raw.id, kind: "other", type: raw.type };
  switch (raw.type) {
    case "userMessage":
      return {
        id: raw.id,
        kind: "userMessage",
        text: userText(raw.content),
        images: userImages(raw.content),
      };
    case "agentMessage": {
      const questions = (raw.questions ?? []).map((question) => ({
        title: question.title,
        options: question.options ?? [],
      }));
      return {
        id: raw.id,
        kind: "agentMessage",
        text: raw.text,
        ...(questions.length ? { questions } : {}),
      };
    }
    case "plan":
      return { id: raw.id, kind: "plan", text: raw.text };
    case "reasoning":
      return {
        id: raw.id,
        kind: "reasoning",
        text: (raw.summary.length ? raw.summary : raw.content).join("\n\n"),
      };
    case "commandExecution":
      return {
        id: raw.id,
        kind: "command",
        command: raw.command,
        cwd: raw.cwd,
        output: raw.aggregatedOutput ?? "",
        exitCode: raw.exitCode,
        durationMs: raw.durationMs,
        actions: actions(raw.commandActions),
        status: status(raw.status),
      };
    case "fileChange":
      return {
        id: raw.id,
        kind: "fileChange",
        changes: raw.changes.map((change) => ({
          path: change.path,
          change:
            change.kind.type === "add"
              ? "add"
              : change.kind.type === "delete"
                ? "delete"
                : "update",
          ...(change.kind.move_path ? { movePath: change.kind.move_path } : {}),
          diff: change.diff,
        })),
        status: status(raw.status),
      };
    case "mcpToolCall":
      return {
        id: raw.id,
        kind: "toolCall",
        server: raw.server,
        tool: raw.tool,
        args: json(raw.arguments),
        result: resultText(raw.result?.content, raw.result?.structuredContent),
        error: raw.error?.message ?? null,
        durationMs: raw.durationMs,
        status: status(raw.status),
      };
    case "dynamicToolCall":
      return {
        id: raw.id,
        kind: "toolCall",
        server: null,
        tool: raw.tool,
        args: json(raw.arguments),
        result: resultText(raw.contentItems),
        error: raw.success === false ? "The tool reported a failure." : null,
        durationMs: raw.durationMs,
        status: status(raw.status),
      };
    case "collabAgentToolCall":
      return {
        id: raw.id,
        kind: "agentCall",
        tool: raw.tool,
        prompt: raw.prompt,
        receivers: raw.receiverThreadIds,
        status: status(raw.status),
      };
    case "webSearch":
      return { id: raw.id, kind: "webSearch", query: raw.query || raw.action?.url || "" };
    case "imageView":
      return { id: raw.id, kind: "image", path: raw.path };
    case "imageGeneration":
      return {
        id: raw.id,
        kind: "image",
        path: raw.savedPath ?? raw.revisedPrompt ?? "",
        generated: true,
        status: raw.failure ? "failed" : raw.status === "completed" ? "completed" : "running",
      };
    case "sleep":
      return {
        id: raw.id,
        kind: "wait",
        durationMs: raw.durationMs,
        status: raw.completedAtMs ? "completed" : "running",
      };
    case "hookPrompt":
      return {
        id: raw.id,
        kind: "hook",
        text: raw.fragments.map((fragment) => fragment.text).join("\n\n"),
      };
    case "subAgentActivity":
      return {
        id: raw.id,
        kind: "agentActivity",
        activity: raw.kind,
        agent: raw.agentPath,
        model: raw.model,
      };
    case "functionCallOutput":
      return {
        id: raw.id,
        kind: "toolCall",
        server: raw.namespace,
        tool: raw.name,
        args: "",
        result:
          typeof raw.output === "string"
            ? raw.output
            : resultText(raw.output.filter((part) => part.type === "input_text")),
        error: null,
        durationMs: null,
        status: "completed",
      };
    case "enteredReviewMode":
      return { id: raw.id, kind: "review", phase: "entered", text: raw.review };
    case "exitedReviewMode":
      return { id: raw.id, kind: "review", phase: "exited", text: raw.review };
    case "contextCompaction":
      return { id: raw.id, kind: "compaction" };
  }
}

export function toTurn(raw: WireTurn): Turn {
  const done = raw.status !== "inProgress";
  return {
    id: raw.id,
    status: raw.status === "inProgress" ? "running" : raw.status,
    error: raw.error?.message ?? null,
    startedAt: raw.startedAt === null ? null : raw.startedAt * 1000,
    durationMs: raw.durationMs,
    // An item a history keeps as running in a turn that ended will never finish, as live.
    items: raw.items.map((wire) => {
      const item = toItem(wire);
      return done && "status" in item && item.status === "running"
        ? { ...item, status: raw.status === "completed" ? "completed" : "failed" }
        : item;
    }),
    diff: null,
  };
}

/**
 * A history's turns. A turn that runs inside another, as a review's does, is kept by codex before
 * the one it belongs to: its items join that turn, which is how the conversation saw it live.
 */
export function toTurns(raw: readonly WireTurn[]): Turn[] {
  const out: Turn[] = [];
  let carried: Turn["items"] = [];
  raw.forEach((wire, index) => {
    const turn = toTurn(wire);
    const root = wire.rootTurnId;
    if (root && root !== wire.id && raw[index + 1]?.id === root) {
      carried = [...carried, ...turn.items];
      return;
    }
    out.push(carried.length ? { ...turn, items: [...carried, ...turn.items] } : turn);
    carried = [];
  });
  return out;
}

/** What this harness is known by: on its sessions, its models and its events. */
export const HARNESS_NAME = "codex";

export function toSession(
  thread: WireThread,
  extra?: { model?: string; effort?: string | null },
): HarnessSession {
  return {
    id: thread.id,
    harness: HARNESS_NAME,
    title: thread.name?.trim() || null,
    preview: thread.preview,
    cwd: thread.cwd,
    model: extra?.model ?? thread.model ?? "",
    effort: extra?.effort ?? thread.reasoningEffort,
    branch: thread.gitInfo?.branch ?? null,
    sandbox: null,
    sandboxCwd: null,
    createdAt: thread.createdAt * 1000,
    updatedAt: thread.updatedAt * 1000,
    forkedFrom: thread.forkedFromId,
  };
}

function toCount(raw: WireTokenBreakdown): TokenCount {
  return {
    total: raw.totalTokens,
    input: raw.inputTokens,
    cachedInput: raw.cachedInputTokens,
    // Codex does not say what it wrote to the cache.
    cacheWrite: 0,
    output: raw.outputTokens,
    reasoning: raw.reasoningOutputTokens,
  };
}

export function toUsage(raw: WireTokenUsage): Usage {
  return {
    total: toCount(raw.total),
    last: toCount(raw.last),
    contextWindow: raw.modelContextWindow,
    costUsd: null,
  };
}

/** A window's name as the owner reads it, from how long it is. */
function windowName(minutes: number | null, fallback: string): string {
  if (minutes === null) return fallback;
  if (minutes % (7 * 24 * 60) === 0)
    return minutes === 7 * 24 * 60 ? "Weekly limit" : `${minutes / (7 * 24 * 60)}-week limit`;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

/** Codex's two windows, the shorter first, as a list of limits. */
export function toLimits(raw: {
  primary: WireRateLimitWindow | null;
  secondary: WireRateLimitWindow | null;
}): LimitWindow[] {
  const out: LimitWindow[] = [];
  for (const [id, window, fallback] of [
    ["primary", raw.primary, "Short limit"],
    ["secondary", raw.secondary, "Long limit"],
  ] as const) {
    if (!window) continue;
    out.push({
      id,
      name: windowName(window.windowDurationMins, fallback),
      usedPercent: window.usedPercent,
      windowMinutes: window.windowDurationMins,
      resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
      status: window.usedPercent >= 100 ? "exceeded" : "ok",
      overage: false,
    });
  }
  return out;
}

export function toModel(raw: WireModel): ModelInfo {
  return {
    id: raw.model || raw.id,
    harness: HARNESS_NAME,
    name: raw.displayName || raw.model,
    description: raw.description,
    efforts: raw.supportedReasoningEfforts.map((effort) => ({
      id: effort.reasoningEffort,
      description: effort.description,
    })),
    defaultEffort: raw.defaultReasoningEffort,
    isDefault: raw.isDefault,
    images: raw.inputModalities?.includes("image") ?? true,
    sandbox: false,
    provider: null,
  };
}

export function toSkill(raw: WireSkill): SkillInfo {
  return {
    name: raw.name,
    description: raw.shortDescription ?? raw.description,
    path: raw.path,
    scope: raw.scope,
    enabled: raw.enabled,
  };
}

/**
 * About how many tokens a tool takes of a request it goes into whole: its definition as codex
 * sends it, at four characters a token. Good enough to say which tools weigh the most.
 */
export function toolTokens(name: string, description: string, schema: unknown): number {
  const definition = JSON.stringify({
    type: "function",
    name,
    description,
    strict: false,
    parameters: schema ?? {},
  });
  return Math.ceil(definition.length / 4);
}

/** The configuration writes that turn one of a server's tools on or off. */
export function mcpToolEdits(
  name: string,
  tool: string,
  enabled: boolean,
  existing: WireMcpConfig | undefined,
): WireConfigEdit[] {
  checkServerName(name);
  if (!existing) throw new Error(`No MCP server named ${name}.`);
  if (typeof tool !== "string" || !tool) throw new Error("Name the tool to turn on or off.");
  const disabled = (existing.disabled_tools ?? []).filter((entry) => entry !== tool);
  if (!enabled) disabled.push(tool);
  return [
    {
      keyPath: `mcp_servers.${name}.disabled_tools`,
      value: disabled.length ? disabled.toSorted() : null,
      mergeStrategy: "replace",
    },
  ];
}

const AUTH: Record<string, McpServerInfo["auth"]> = {
  notLoggedIn: "signedOut",
  oAuth: "signedIn",
  bearerToken: "token",
};

function toMcpServer(
  name: string,
  config: WireMcpConfig | undefined,
  raw: WireMcpServer | undefined,
): McpServerInfo {
  const enabled = config?.enabled !== false;
  const auth = AUTH[raw?.authStatus ?? ""] ?? "none";
  const offered: McpToolInfo[] = Object.entries(raw?.tools ?? {}).map(([tool, value]) => ({
    name: tool,
    description: value?.description ?? "",
    enabled: true,
    tokens: toolTokens(tool, value?.description ?? "", value?.inputSchema),
  }));
  // Codex lists only the tools it offers, so one turned off is known from the configuration.
  const off = (config?.disabled_tools ?? [])
    .filter((tool) => !offered.some((entry) => entry.name === tool))
    .map((tool) => ({ name: tool, description: "", enabled: false, tokens: null }));
  const tools = [...offered, ...off].toSorted((a, b) => a.name.localeCompare(b.name));
  const pluginId = raw?.pluginId ?? null;
  let transport: McpServerInfo["transport"] = null;
  if (config && !pluginId) {
    transport = config.url
      ? { kind: "http", url: config.url, bearerTokenEnvVar: config.bearer_token_env_var ?? null }
      : {
          kind: "stdio",
          command: config.command ?? "",
          args: config.args ?? [],
          env: Object.keys(config.env ?? {}).toSorted(),
        };
  }
  let state: McpServerInfo["status"] = "unknown";
  if (!enabled) state = "disabled";
  else if (auth === "signedOut" || raw?.runtimeStatus === "authenticationRequired") {
    state = "needsAuth";
  } else if (raw?.toolsError || raw?.runtimeStatus === "failed") state = "failed";
  else if (raw?.serverInfo || offered.length > 0 || raw?.runtimeStatus === "connected") {
    state = "connected";
  }
  return {
    name,
    enabled,
    transport,
    pluginId,
    status: state,
    auth,
    tools,
    error: raw?.toolsError ?? null,
  };
}

/**
 * The owner's servers and those plugins bring, by name. What is configured
 * comes from the configuration; what each offers, from asking the server.
 */
export function toMcpServers(
  configured: Record<string, WireMcpConfig | undefined>,
  statuses: WireMcpServer[],
): McpServerInfo[] {
  const byName = new Map(statuses.map((entry) => [entry.name, entry]));
  const names = new Set([...Object.keys(configured), ...byName.keys()]);
  return [...names]
    .toSorted((a, b) => a.localeCompare(b))
    .map((name) => toMcpServer(name, configured[name], byName.get(name)));
}

const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function checkServerName(name: string): void {
  if (!SERVER_NAME.test(name)) {
    throw new Error("A server's name is letters, digits, - and _, at most 64.");
  }
}

/**
 * The configuration writes that make `existing` what `input` says. Only the
 * keys Cycle shows are written, so a timeout or header set by hand stays. A
 * variable given without a value keeps the stored one.
 */
export function mcpServerEdits(
  input: McpServerInput,
  existing: WireMcpConfig | undefined,
): WireConfigEdit[] {
  checkServerName(input.name);
  const at = (key: string) => `mcp_servers.${input.name}.${key}`;
  const set = (key: string, value: unknown): WireConfigEdit => ({
    keyPath: at(key),
    value,
    mergeStrategy: "replace",
  });
  const { transport } = input;
  // The wire is not typed at run time, and this is written to a file the codex CLI reads too.
  if (transport?.kind !== "http" && transport?.kind !== "stdio") {
    throw new Error("A server is reached by a command or an address.");
  }
  if (transport.kind === "http") {
    if (typeof transport.url !== "string") {
      throw new Error("The address must be a full http or https URL.");
    }
    let url: URL;
    try {
      url = new URL(transport.url);
    } catch {
      throw new Error("The address must be a full http or https URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error("The address must be a full http or https URL.");
    }
    const variable =
      typeof transport.bearerTokenEnvVar === "string"
        ? transport.bearerTokenEnvVar.trim() || null
        : null;
    if (variable && !ENV_NAME.test(variable)) {
      throw new Error(`${variable} is not a variable name.`);
    }
    return [
      set("url", transport.url),
      set("bearer_token_env_var", variable),
      set("command", null),
      set("args", null),
      set("env", null),
    ];
  }
  const command = typeof transport.command === "string" ? transport.command.trim() : "";
  if (!command) throw new Error("A command is needed to start the server.");
  if (!Array.isArray(transport.args) || transport.args.some((arg) => typeof arg !== "string")) {
    throw new Error("A command's arguments are a list of words.");
  }
  const kept = existing?.env ?? {};
  const env: Record<string, string> = {};
  for (const [name, given] of Object.entries(transport.env ?? {})) {
    // `__proto__` is a variable name by its letters, and not one an object can be given safely.
    if (!ENV_NAME.test(name) || name === "__proto__") {
      throw new Error(`${name} is not a variable name.`);
    }
    const value = given ?? (Object.hasOwn(kept, name) ? kept[name] : undefined);
    if (typeof value !== "string") throw new Error(`${name} has no value.`);
    env[name] = value;
  }
  return [
    set("command", command),
    set("args", transport.args),
    set("env", Object.keys(env).length > 0 ? env : null),
    set("url", null),
    set("bearer_token_env_var", null),
  ];
}

const UNAVAILABLE: Record<string, string> = {
  disabled_by_admin: "Turned off by your organization.",
  plan_not_eligible: "Not included in your plan.",
  required_app_unavailable: "An app it needs is not available.",
};

export function toPlugin(raw: WirePlugin): PluginInfo {
  const available = raw.availability === "AVAILABLE" && raw.installPolicy !== "NOT_AVAILABLE";
  return {
    id: raw.id,
    name: raw.name,
    displayName: raw.interface?.displayName || raw.name,
    description: raw.interface?.shortDescription ?? "",
    version: raw.localVersion ?? raw.version,
    installed: raw.installed,
    enabled: raw.enabled,
    available,
    unavailable: available
      ? null
      : (UNAVAILABLE[raw.disabledReason ?? ""] ?? "Not available to install."),
  };
}

export function toCatalog(raw: WirePluginList): PluginCatalog {
  return {
    marketplaces: raw.marketplaces.map((marketplace) => ({
      name: marketplace.name,
      displayName: marketplace.interface?.displayName || marketplace.name,
      path: marketplace.path,
      plugins: marketplace.plugins.map(toPlugin),
    })),
    errors: raw.marketplaceLoadErrors.map((error) => `${error.marketplacePath}: ${error.message}`),
  };
}

export function toPluginDetail(raw: WirePluginDetail): PluginDetail {
  const plugin = toPlugin(raw.summary);
  return {
    plugin,
    description: raw.description ?? plugin.description,
    skills: raw.skills.map((skill) => ({ name: skill.name, description: skill.description })),
    mcpServers: raw.mcpServers,
    hooks: raw.hooks.length,
    apps: raw.apps.flatMap((app) => app.name ?? app.id ?? []),
  };
}

export function toInput(input: PromptInput): WireUserInput[] {
  const out: WireUserInput[] = [];
  if (input.text) out.push({ type: "text", text: input.text, text_elements: [] });
  for (const image of input.images) {
    if (/^(data:|https?:)/.test(image)) out.push({ type: "image", url: image });
    else out.push({ type: "localImage", path: image });
  }
  return out;
}

/** Codex's modes. Their ids are the ones Cycle had for every agent before each named its own. */
export const CODEX_MODES: readonly ModeInfo[] = defineModes(HARNESS_NAME, [
  {
    id: "readOnly",
    name: "Ask first",
    description: "Reads freely, asks before commands and edits",
    replaces: "readOnly",
  },
  {
    id: "auto",
    name: "Auto",
    description: "Works inside the project, asks to leave it",
    isDefault: true,
    replaces: "auto",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Reads and proposes a plan, changes nothing",
    plan: true,
  },
  {
    id: "fullAccess",
    name: "Full access",
    description: "Never asks, no sandbox",
    dangerous: true,
    replaces: "fullAccess",
  },
]);

/** How far a mode lets the agent reach, to tell a wider one from a narrower. */
export function modeReach(mode: SessionMode): number {
  return mode === "fullAccess" ? 2 : mode === "auto" ? 1 : 0;
}

/**
 * Codex's collaboration mode for a turn: its plan mode, or its default to leave it. Codex keeps a
 * thread in the one it was last given, so the default is given only to leave plan mode. Codex's
 * own instructions for each are kept. `planning` is the model a thread in plan mode was put there
 * with, which leaving it takes when the turn names none: a thread is never left planning unsaid.
 */
export function collaborationMode(
  mode: SessionMode,
  planning: string | undefined,
  settings: { model?: string | undefined; effort?: string | undefined },
): { collaborationMode: unknown } | Record<string, never> {
  const plan = mode === "plan";
  if (!plan && planning === undefined) return {};
  const model = settings.model ?? planning;
  if (!model) {
    throw new Error(
      plan
        ? "Choose a model for this session before it plans."
        : "Choose a model for this session to take it out of plan mode.",
    );
  }
  return {
    collaborationMode: {
      mode: plan ? "plan" : "default",
      settings: {
        model,
        reasoning_effort: settings.effort ?? null,
        developer_instructions: null,
      },
    },
  };
}

/**
 * How each mode is put to codex: when it asks, and what it may touch. `plan` reaches as `readOnly`
 * does, and is codex's plan collaboration mode besides. A mode codex does not offer asks first.
 */
export function modePolicy(mode: SessionMode): {
  approvalPolicy: "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  sandboxPolicy: WireSandboxPolicy;
} {
  switch (mode) {
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      };
    case "fullAccess":
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
    default:
      return {
        approvalPolicy: "on-request",
        sandbox: "read-only",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      };
  }
}

/** What codex is asked to review. A commit is named by a hash, and nothing else reaches git. */
export function toReviewTarget(target: ReviewTarget): unknown {
  switch (target?.kind) {
    case "uncommitted":
      return { type: "uncommittedChanges" };
    case "branch":
      if (typeof target.branch !== "string" || !target.branch.trim()) {
        throw new Error("Name the branch to review against.");
      }
      return { type: "baseBranch", branch: target.branch.trim() };
    case "commit":
      if (typeof target.sha !== "string" || !/^[0-9a-f]{4,64}$/i.test(target.sha.trim())) {
        throw new Error("A commit is named by its hash.");
      }
      return { type: "commit", sha: target.sha.trim(), title: null };
    case "custom":
      if (typeof target.instructions !== "string" || !target.instructions.trim()) {
        throw new Error("Say what to review.");
      }
      return { type: "custom", instructions: target.instructions.trim() };
    default:
      throw new Error("Say what to review.");
  }
}

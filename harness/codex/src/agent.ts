import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  type AgentContext,
  type AvailableCommand,
  agent,
  methods,
  type NewSessionRequest,
  RequestError,
  type ResumeSessionRequest,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import { describePromptProblem, META, normalizePrompt } from "@cycle/protocol";
import { approval } from "./approval.ts";
import {
  elicitationAnswer,
  elicitationForm,
  type Form,
  type FormAnswer,
  questionAnswers,
  questionForm,
} from "./ask.ts";
import { itemUpdate } from "./items.ts";
import { PLAN_USAGE_UPDATE, planWindowsOf } from "./plan-usage.ts";
import { CODEX_NOTIFICATION_METHODS, CODEX_PROMPT_CAPABILITIES } from "./protocol.ts";
import {
  loadBundledModels,
  PROVIDER_TOKEN_ENV,
  providerCatalog,
  providerCatalogDocument,
  providerThreadConfig,
  writeProviderCatalog,
} from "./providers.ts";
import { type AdapterConfig, AppServer, CodexRpcError } from "./server.ts";
import {
  type Catalog,
  effortsOf,
  type Mode,
  modes,
  options,
  policy,
  turnPolicy,
} from "./settings.ts";
import type {
  AccountRateLimitsUpdatedNotification,
  AgentMessageDeltaNotification,
  GetAccountRateLimitsResponse,
  ItemCompletedNotification,
  McpServerElicitationRequestParams,
  PlanDeltaNotification,
  SkillMetadata,
  SkillsListResponse,
  ThreadNameUpdatedNotification,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  TurnCompletedNotification,
  TurnError,
  TurnPlanUpdatedNotification,
  UserInput,
} from "./wire.generated.ts";

/**
 * An MCP server's name as Codex takes it: letters, digits, `_` and `-` (a name with anything else is refused and the
 * server left out). Cycle's names are a person's, "Linear (work)" say.
 */
export const serverName = (name: string) => name.replace(/[^A-Za-z0-9_-]+/g, "_") || "mcp";

/** In a form's answer: no client could show it (decision 0011). */
const NO_CLIENT = "cycle/noClient";
/** In a `subagent_update`'s `_meta`: what Codex says of the sub-agent beyond ACP's fields (decision 0014). */
const SUBAGENT_META = "cycle/subagent";

/**
 * Subdirectories under `<cwd>/.agents` that Cycle owns for agent work (managed git worktrees from CYC-273 and agent
 * decision notes). Codex 0.171.0 marks `<cwd>/.agents` read-only in `:workspace`; unlocking only these two keeps
 * `.agents/skills`, `.git`, `.codex`, and `.aws` protected.
 */
const CYCLE_AGENTS_WRITABLE = ["worktree", "notes"] as const;

export function cycleWritableSubpaths(cwd: string): string[] {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    return [];
  }
  const agentsDir = join(realCwd, ".agents");
  try {
    if (!lstatSync(agentsDir).isDirectory()) return [];
  } catch {
    return [];
  }
  const writable: string[] = [];
  for (const sub of CYCLE_AGENTS_WRITABLE) {
    const target = join(agentsDir, sub);
    try {
      // Never unlock a symlink or regular file: a symlink inside `.agents` could point outside the workspace, and
      // Codex's Seatbelt sandbox refuses symlinked writable roots anyway.
      if (!lstatSync(target).isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
    writable.push(target);
  }
  return writable;
}

/**
 * Absolute paths to deny reading in Codex's permission profile. On Linux, bubblewrap implements `"none"` by
 * bind-mounting `/dev/null` onto the path, which creates a 0-byte stub file on the host when the target does not exist
 * yet (breaking later loads of `providers.json` with `Unexpected EOF`), so only existing paths are passed there. macOS
 * Seatbelt matches path strings without touching the filesystem.
 */
export function effectiveDenyRead(
  paths: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return (paths ?? []).filter(
    (path) => isAbsolute(path) && (platform !== "linux" || existsSync(path)),
  );
}

/** A failed turn's message; one Codex failed for want of a login says how to sign in. */
export function turnErrorMessage(error: TurnError | null | undefined): string | undefined {
  if (error?.codexErrorInfo === "unauthorized")
    return "Codex is not signed in. Run `cycle login codex` on the daemon's machine.";
  return error?.message;
}
type Turn = {
  id?: string;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  approvals: AbortController;
  streamed: Set<string>;
  tools: Set<string>;
  /** Compactions begun in this turn and not yet ended: one left open when the turn ends has failed. */
  compactions: Set<string>;
};
export function createAdapter(config: AdapterConfig) {
  // One daemon session owns this adapter and its process.
  let session: string | undefined,
    server: AppServer | undefined,
    owner: AgentContext | undefined,
    turn: Turn | undefined;
  let mode: Mode = "default";
  let catalog: Catalog = [];
  /** The session runs on the owner's own models: what its thread began on, for as long as it lives. */
  let onProviders = false;
  let model = "default";
  let effort = "default";
  /** What the thread was opened with: what "default" means, since a turn's choices stay for the turns after it. */
  let threadModel: string | undefined;
  let threadEffort: string | null = null;
  /** The collaboration mode last sent: plan stays until a turn says otherwise. */
  let sentPlan = false;
  /** Closed on purpose (session/close, the adapter's end): any other end of the app-server is its death. */
  let closing = false;
  let additionalDirectories: string[] = [];
  /**
   * The thread's sandbox is Cycle's `:workspace`-extending permission profile (see `open`), not a `sandbox` mode: used
   * to unlock `.agents/{worktree,notes}` under `cwd` and/or deny reading `secrets.env` and `providers.json`.
   */
  let workspaceProfile = false;
  /**
   * A turn named a sandbox of its own (Read only, Full access). Codex keeps it for the turns after, and there is no way
   * to name the profile again, so from then on every turn names its sandbox as before, without the profile's overrides.
   */
  let sandboxNamed = false;
  let developerInstructions: string | undefined;
  let mcpConfig: Record<string, unknown> = {};
  let trusted: boolean | undefined;
  let codexConfig: Record<string, unknown> = {};
  /** The per-thread model catalog on disk, while a session on the owner's models is open. */
  let catalogDir: string | undefined;
  /** The client said it can show a form (ACP `capabilities.elicitation.form`): the daemon says so for its clients. */
  let clientCanElicit = false;
  let cwd: string | undefined;
  /** Codex's skills for the session's folder, offered as commands. */
  let skills: SkillMetadata[] = [];
  /** The plan usage last told: it is told again only when it changes. */
  let planUsage = "";
  /** Told already that the sandbox cannot start here. */
  let sandboxNoticed = false;
  const children = new Set<string>();
  /** "Always allow in this session" for commands, in memory only; sub-agent threads share it. */
  const allowedPrefixes = new Set<string>();
  const childTurns = new Map<string, string>();
  /** Items of sub-agent threads that came as deltas, for when no turn of the parent's is running. */
  const childStreamed = new Set<string>();
  /** Sub-agents' approvals are not a turn's of the parent's: they end with the session. */
  let childApprovals = new AbortController();
  /** What each sub-agent asks ends with its own turn too (it is stopped, or done): one per sub-agent. */
  const childAsks = new Map<string, AbortController>();
  /** Sub-agents told as ended (idle) and not running since: an end is told once. */
  const childEnded = new Set<string>();
  /** The catalog is for one session: its instructions and metadata never outlive the thread that read it. */
  function clearCatalog() {
    const dir = catalogDir;
    catalogDir = undefined;
    if (dir === undefined) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: the directory is private and the OS cleans it eventually.
    }
  }
  const childSignal = (threadId: string) => {
    let asks = childAsks.get(threadId);
    if (!asks) {
      asks = new AbortController();
      childAsks.set(threadId, asks);
    }
    return AbortSignal.any([childApprovals.signal, asks.signal]);
  };
  /** A sub-agent's turn is over: what it asked is withdrawn. */
  const endChildAsks = (threadId: string) => {
    childAsks.get(threadId)?.abort();
    childAsks.delete(threadId);
  };
  const planId = () => `${session ?? "codex"}-plan`;
  function notifyFor(sessionId: string, update: SessionUpdate) {
    if (owner)
      void owner.notify(methods.client.session.update, { sessionId, update }).catch(() => {});
  }
  function notify(update: SessionUpdate) {
    if (session) notifyFor(session, update);
  }
  /** A sub-agent's state, told in the parent's session: the daemon takes a child's state only from there. */
  function subagent(
    threadId: string,
    state: "running" | "idle",
    stopReason?: "end_turn" | "cancelled" | "error",
    announce?: { title?: string | undefined; toolCallId: string; parentId?: string },
  ) {
    if (state === "idle") {
      if (childEnded.has(threadId)) return;
      childEnded.add(threadId);
      endChildAsks(threadId);
    } else childEnded.delete(threadId);
    notify({
      sessionUpdate: "subagent_update",
      sessionId: threadId,
      state: { state, ...(stopReason ? { stopReason } : {}) },
      // Stopped alone with `session/cancel` of its own id: an interrupt of its own turn.
      ...(announce
        ? {
            ...(announce.title ? { title: announce.title } : {}),
            capabilities: { cancel: {} },
            _meta: {
              [SUBAGENT_META]: {
                toolCallId: announce.toolCallId,
                ...(announce.parentId ? { parentId: announce.parentId } : {}),
              },
            },
          }
        : {}),
    } as unknown as SessionUpdate);
  }
  /** Commands for the session: `/compact`, then each of Codex's enabled skills. */
  function commands(): AvailableCommand[] {
    const seen = new Set(["compact"]);
    const list: AvailableCommand[] = [
      { type: "command", name: "compact", description: "Compact the Codex conversation context." },
    ];
    for (const skill of skills) {
      if (!skill.enabled || seen.has(skill.name)) continue;
      seen.add(skill.name);
      list.push({
        type: "command",
        name: skill.name,
        description:
          skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description,
        input: { type: "text", hint: "What to do with it" },
      } as AvailableCommand);
    }
    return list;
  }
  /** Each listing in turn: one that answers after a later one began is out of date. */
  let skillsLoad = 0;
  /** The listing under way, for a prompt that names a skill before the first has come. */
  let skillsLoading: Promise<void> | undefined;
  function loadSkills(reload = false) {
    if (!server || cwd === undefined) return Promise.resolve();
    const load = ++skillsLoad;
    const loading = server
      .request<SkillsListResponse>("skills/list", { cwds: [cwd], forceReload: reload })
      .then(
        (listed) => {
          if (load === skillsLoad) skills = listed.data.flatMap((entry) => entry.skills);
        },
        () => {},
      );
    skillsLoading = loading;
    return loading;
  }
  /** The account's usage limits, told when they change. */
  function tellPlanUsage(snapshot: GetAccountRateLimitsResponse["rateLimits"] | undefined) {
    const windows = planWindowsOf(snapshot);
    const key = JSON.stringify(windows);
    if (windows.length === 0 || key === planUsage) return;
    planUsage = key;
    notify({
      sessionUpdate: PLAN_USAGE_UPDATE,
      windows,
      at: Date.now(),
    } as unknown as SessionUpdate);
  }
  /**
   * Asks the user a form, through the daemon. Ends when someone answers, or when `signal` ends it (the turn is
   * cancelled, the session closes). A client that did not say it can show a form is not sent one.
   */
  async function askForm(form: Form, signal: AbortSignal | undefined): Promise<FormAnswer> {
    if (!clientCanElicit || !owner || !session || !signal) return "unavailable";
    if (signal.aborted) return "aborted";
    const response = await owner
      .request(
        methods.client.elicitation.create,
        { sessionId: session, mode: "form", ...form } as never,
        { cancellationSignal: signal, stopWaitingOnCancel: true },
      )
      .then(
        (r) =>
          r as unknown as {
            action: "accept" | "decline" | "cancel";
            content?: Record<string, unknown> | null;
            _meta?: Record<string, unknown>;
          } | null,
        () => "failed" as const,
      );
    if (signal.aborted) return "aborted";
    if (response === "failed" || typeof response !== "object" || response === null)
      return "unavailable";
    if (response._meta?.[NO_CLIENT] === true) return "unavailable";
    return { action: response.action, content: response.content };
  }
  /** Codex's requests of the client: approvals, its questions, an MCP server's forms. */
  async function serverRequest(method: string, raw: unknown) {
    const threadId = (raw as { threadId?: string } | undefined)?.threadId ?? "";
    const child = children.has(threadId);
    const signal = child ? childSignal(threadId) : turn?.approvals.signal;
    const ours = child || (threadId === session && !!turn);
    if (method === "item/tool/requestUserInput") {
      const params = raw as ToolRequestUserInputParams;
      // Nobody to ask: no answers, which the model reads as the user not answering.
      return questionAnswers(
        params,
        ours ? await askForm(questionForm(params), signal) : "unavailable",
      );
    }
    if (method === "mcpServer/elicitation/request") {
      const params = raw as McpServerElicitationRequestParams;
      const form = elicitationForm(params);
      // An MCP server may ask between turns; the session's end ends it then.
      return elicitationAnswer(
        form && (child || threadId === session)
          ? await askForm(form, signal ?? childApprovals.signal)
          : undefined,
      );
    }
    return approval(
      method,
      raw,
      owner,
      session,
      turn?.id,
      signal,
      (id) => children.has(id),
      allowedPrefixes,
    );
  }
  function finish(stopReason: "end_turn" | "error" | "cancelled", message?: string) {
    if (!turn) return;
    turn.approvals.abort();
    clearTimeout(turn.timer);
    for (const compactionId of turn.compactions)
      notify({
        sessionUpdate: "compaction_update",
        compactionId,
        status: "failed",
      } as SessionUpdate);
    for (const toolCallId of turn.tools)
      notify({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: stopReason === "cancelled" ? "cancelled" : "failed",
      });
    turn = undefined;
    notify({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason,
      ...(stopReason === "error"
        ? { error: { code: -32603, message: message ?? "Codex turn failed" } }
        : {}),
    } as SessionUpdate);
  }
  function event(method: string, raw: unknown) {
    if (!(CODEX_NOTIFICATION_METHODS as readonly string[]).includes(method)) return;
    // The account's and the folder's, not a thread's.
    if (method === "account/rateLimits/updated") {
      if (session) tellPlanUsage((raw as AccountRateLimitsUpdatedNotification).rateLimits);
      return;
    }
    if (method === "skills/changed") {
      if (session)
        void loadSkills(true).then(() =>
          notify({ sessionUpdate: "available_commands_update", availableCommands: commands() }),
        );
      return;
    }
    if (!raw || typeof raw !== "object" || !("threadId" in raw)) return;
    const threadId = typeof raw.threadId === "string" ? raw.threadId : undefined;
    if (!threadId || (threadId !== session && !children.has(threadId))) return;
    const child = threadId !== session;
    const send = (update: SessionUpdate) => notifyFor(threadId, update);
    // The session's title and context use are the thread's, not a turn's: they are told whenever they come.
    if (method === "thread/name/updated") {
      if (!child)
        notify({
          sessionUpdate: "session_info_update",
          title: (raw as ThreadNameUpdatedNotification).threadName ?? null,
        } as SessionUpdate);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = raw as ThreadTokenUsageUpdatedNotification;
      if (usage.tokenUsage.modelContextWindow !== null)
        send({
          sessionUpdate: "usage_update",
          used: usage.tokenUsage.last.totalTokens,
          size: usage.tokenUsage.modelContextWindow,
        } as SessionUpdate);
      return;
    }
    // A sub-agent's thread runs on its own turns, and may outlive the parent's: it is not held to one.
    const active = turn;
    if (!child && !active) return;
    if (!child && active && "turnId" in raw && active.id && raw.turnId !== active.id) return;
    const streamed = active?.streamed ?? childStreamed;
    // A turn this adapter did not start itself (a /compact) is known by its id from here on.
    if (method === "turn/started") {
      const started = (raw as { turn?: { id?: unknown } }).turn?.id;
      // A sub-agent given more to do (`send_input`) runs again.
      if (child) {
        if (typeof started === "string") childTurns.set(threadId, started);
        subagent(threadId, "running");
        return;
      }
      if (!child && active && active.id === undefined && typeof started === "string") {
        active.id = started;
        if (active.cancelled) interrupt(active);
      }
      return;
    }
    // A sub-agent's own turn, the one a cancel of its session interrupts.
    if (child && "turnId" in raw && typeof raw.turnId === "string")
      childTurns.set(threadId, raw.turnId);
    if (method === "turn/completed") {
      const result = (raw as TurnCompletedNotification).turn;
      if (child) {
        childTurns.delete(threadId);
        subagent(
          threadId,
          "idle",
          result.status === "interrupted"
            ? "cancelled"
            : result.status === "completed"
              ? "end_turn"
              : "error",
        );
        return;
      }
      if (active?.id && result.id !== active.id) return;
      finish(
        result.status === "interrupted"
          ? "cancelled"
          : result.status === "completed"
            ? "end_turn"
            : "error",
        turnErrorMessage(result.error),
      );
    } else if (method === "item/started" || method === "item/completed") {
      const { item } = raw as ItemCompletedNotification;
      const completedItem = method === "item/completed";
      if (item.type === "contextCompaction") {
        if (!child && active) {
          if (completedItem) active.compactions.delete(item.id);
          else active.compactions.add(item.id);
        }
        send({
          sessionUpdate: "compaction_update",
          compactionId: item.id,
          status: completedItem ? "completed" : "in_progress",
        } as SessionUpdate);
        return;
      }
      // How the pinned Codex tells of a sub-agent with a real model (multi-agent v2): an activity item in the thread
      // that started it, with the sub-agent's own thread. Its conversation then comes on that thread.
      if (item.type === "subAgentActivity" && !completedItem) {
        if (item.kind === "started") {
          children.add(item.agentThreadId);
          subagent(item.agentThreadId, "running", undefined, {
            title: item.agentPath.split("/").filter(Boolean).at(-1),
            toolCallId: item.id,
            ...(child ? { parentId: threadId } : {}),
          });
        } else if (item.kind === "interrupted" && children.has(item.agentThreadId))
          subagent(item.agentThreadId, "idle", "cancelled");
        // Its own turn's end says it first, as a rule; this is for when that came before it was known.
        else if (item.kind === "completed" && children.has(item.agentThreadId))
          subagent(item.agentThreadId, "idle", "end_turn");
      }
      const update = itemUpdate(item, method === "item/completed", streamed.has(item.id), planId());
      if (!child && active && update?.sessionUpdate === "tool_call_update") {
        if (method === "item/started") active.tools.add(item.id);
        else active.tools.delete(item.id);
      }
      if (update) send(update);
      // On Linux a command runs in bubblewrap, which a container's default profile (or a kernel without unprivileged
      // user namespaces) does not let start: every command then fails the same way, and Codex does not fall back on
      // its own (seen in Docker, CYCL-208). Said once, with what to do.
      if (
        completedItem &&
        !sandboxNoticed &&
        item.type === "commandExecution" &&
        /bwrap: No permissions to create a new namespace/.test(item.aggregatedOutput ?? "")
      ) {
        sandboxNoticed = true;
        notify({
          sessionUpdate: "notice",
          severity: "warning",
          title:
            "Codex's sandbox cannot start on this machine, so its commands fail. Run Cycle where unprivileged user namespaces are allowed (in Docker: --security-opt seccomp=unconfined --security-opt apparmor=unconfined), or choose Full access.",
        } as SessionUpdate);
      }
      if (item.type === "collabAgentToolCall")
        for (const receiver of item.receiverThreadIds) {
          children.add(receiver);
          // The call ending is not the agent ending (a spawn ends once it is launched): its own state says.
          const status = item.agentsStates[receiver]?.status;
          const running =
            status === undefined
              ? !completedItem
              : status === "running" || status === "pendingInit";
          subagent(receiver, running ? "running" : "idle");
        }
    } else if (method === "turn/plan/updated") {
      const plan = raw as TurnPlanUpdatedNotification;
      send({
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          // The thread's task list, not the turn's: update_plan sends the whole list each time and the model keeps
          // changing the same one in later turns, so it replaces the one shown, as Claude's and agy's do. Not
          // planId(): that is plan mode's proposed plan, which this would overwrite.
          planId: `${plan.threadId}-tasks`,
          entries: plan.plan.map((item) => ({
            content: item.step,
            priority: "medium",
            status: item.status === "inProgress" ? "in_progress" : item.status,
          })),
        },
      } as unknown as SessionUpdate);
    } else if (method === "item/plan/delta") {
      const delta = raw as PlanDeltaNotification;
      send({
        sessionUpdate: "agent_message_chunk",
        messageId: delta.itemId,
        content: { type: "text", text: delta.delta },
      } as SessionUpdate);
    } else if (
      [
        "item/agentMessage/delta",
        "item/reasoning/textDelta",
        "item/reasoning/summaryTextDelta",
      ].includes(method)
    ) {
      const { itemId, delta } = raw as AgentMessageDeltaNotification;
      streamed.add(itemId);
      send({
        sessionUpdate:
          method === "item/agentMessage/delta" ? "agent_message_chunk" : "agent_thought_chunk",
        messageId: itemId,
        content: { type: "text", text: delta },
      } as SessionUpdate);
    }
  }
  function interrupt(active: Turn) {
    if (!active.id || !server) return;
    void server
      .request("turn/interrupt", { threadId: session, turnId: active.id })
      .catch((error) => {
        if (turn === active) server?.close(error);
      });
  }
  function requireSession(id: string) {
    if (id !== session || !server) throw new RequestError(-32002, "Codex session unavailable");
    return server;
  }
  /** The prompt as Codex's input: checked and read by the protocol, which refuses a PDF for it. */
  const inputOf = (prompt: readonly unknown[]): UserInput[] => {
    const normalized = normalizePrompt(prompt, CODEX_PROMPT_CAPABILITIES, {
      limits: false,
      pdf: false,
    });
    if (!normalized.ok) {
      throw new RequestError(-32602, describePromptProblem(normalized.problem), normalized.problem);
    }
    return normalized.blocks.map((block): UserInput => {
      if (block.type === "image")
        return { type: "image", url: `data:${block.mimeType};base64,${block.data}` };
      if (block.type === "link")
        return { type: "text", text: `${block.name}\n${block.uri}`, text_elements: [] };
      if (block.type === "file")
        return { type: "text", text: `${block.uri}\n${block.text}`, text_elements: [] };
      if (block.type === "pdf") throw new RequestError(-32602, "Codex takes no PDF");
      return { type: "text", text: block.text, text_elements: [] };
    });
  };
  /**
   * A prompt that begins `/<skill>` runs that skill, as Codex's own clients do: the skill as an input of its own, and
   * the text naming it with Codex's `$` (the model reads the mention, the input brings the skill's instructions).
   */
  async function withSkill(input: UserInput[]): Promise<UserInput[]> {
    const first = input[0];
    if (first?.type !== "text") return input;
    const match = /^\/([^\s/]+)(?=\s|$)/.exec(first.text);
    // `/compact` is Cycle's command, whatever skill shares its name.
    if (!match || match[1] === "compact") return input;
    if (skills.length === 0) await skillsLoading;
    const skill = skills.find((s) => s.enabled && s.name === match[1]);
    if (!skill) return input;
    return [
      { type: "skill", name: skill.name, path: skill.path },
      { ...first, text: `$${first.text.slice(1)}` },
      ...input.slice(1),
    ];
  }
  const optionsOf = () => options(mode, catalog, model, effort, threadModel);
  const supports = (forModel: string, value: string) =>
    effortsOf(catalog, forModel, threadModel).some((item) => item.reasoningEffort === value);
  /** The model and effort a turn runs with, always explicit: Codex keeps a turn's choice for the turns after it. */
  function resolved() {
    const chosenModel = model !== "default" ? model : threadModel;
    const chosenEffort =
      effort !== "default"
        ? effort
        : model === "default"
          ? threadEffort
          : (catalog.find((item) => item.model === model)?.defaultReasoningEffort ?? null);
    return { model: chosenModel, effort: chosenEffort };
  }
  function turnSettings() {
    const { model: chosenModel, effort: chosenEffort } = resolved();
    const plan = mode === "plan";
    // Into plan and out of it again: Codex needs the mode with its settings, which need a model.
    const collaborationMode =
      chosenModel !== undefined && (plan || sentPlan)
        ? {
            mode: plan ? "plan" : "default",
            settings: {
              model: chosenModel,
              reasoning_effort: chosenEffort,
              developer_instructions: null,
            },
          }
        : undefined;
    if (collaborationMode) sentPlan = plan;
    const turn = turnPolicy(mode, additionalDirectories);
    // The thread's own profile stands in the modes whose sandbox it is; naming one here would replace it.
    const { sandboxPolicy, ...withoutSandbox } = turn;
    const keepsProfile =
      workspaceProfile && !sandboxNamed && sandboxPolicy.type === "workspaceWrite";
    if (workspaceProfile && !keepsProfile) sandboxNamed = true;
    return {
      ...(keepsProfile ? withoutSandbox : turn),
      ...(chosenModel !== undefined ? { model: chosenModel } : {}),
      ...(chosenEffort !== null ? { effort: chosenEffort } : {}),
      ...(collaborationMode ? { collaborationMode } : {}),
    };
  }
  async function open(
    params: NewSessionRequest | ResumeSessionRequest,
    client: AgentContext,
    resume?: ResumeSessionRequest,
  ) {
    if (server) throw new RequestError(-32600, "This adapter already has a session");
    if (resume?.replayFrom) throw new RequestError(-32602, "Cycle owns the conversation replay");
    clearCatalog();
    mode = "default";
    sandboxNamed = false;
    model = "default";
    effort = "default";
    sentPlan = false;
    cwd = params.cwd;
    skills = [];
    planUsage = "";
    sandboxNoticed = false;
    allowedPrefixes.clear();
    closing = false;
    childApprovals = new AbortController();
    childAsks.clear();
    childEnded.clear();
    skillsLoading = undefined;
    additionalDirectories = params.additionalDirectories ?? [];
    developerInstructions =
      params.systemPrompt?.mode === "append"
        ? (params.systemPrompt.content as Array<{ type: string; text?: string }>)
            .filter((item) => item.type === "text")
            .map((item) => item.text ?? "")
            .join("\n")
        : undefined;
    // Two names that come out the same are kept apart: one would silently replace the other.
    const taken = new Set<string>();
    const serverKey = (name: string) => {
      const base = serverName(name);
      let key = base;
      for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
      taken.add(key);
      return key;
    };
    mcpConfig = Object.fromEntries(
      (params.mcpServers ?? []).map((server) => {
        if (server.type === "http")
          return [
            serverKey(String(server.name)),
            {
              url: server.url,
              http_headers: Object.fromEntries(
                ((server.headers ?? []) as unknown as { name: string; value: string }[]).map(
                  (header) => [header.name, header.value],
                ),
              ),
            },
          ];
        if (server.type === "stdio")
          return [
            serverKey(String(server.name)),
            {
              command: server.command,
              args: server.args ?? [],
              env: Object.fromEntries(
                ((server.env ?? []) as unknown as { name: string; value: string }[]).map(
                  (entry) => [entry.name, entry.value],
                ),
              ),
            },
          ];
        throw new RequestError(-32602, "Unsupported MCP transport");
      }),
    );
    trusted =
      typeof params._meta?.["cycle/trusted"] === "boolean"
        ? params._meta["cycle/trusted"]
        : undefined;
    const sessionEnv = config.sessionEnv ?? {};
    codexConfig = {
      ...(Object.keys(mcpConfig).length > 0 ? { mcp_servers: mcpConfig } : {}),
      // The session's variables, for its commands only, one dotted key each: a `shell_environment_policy` table would
      // replace the person's own (their `inherit`, `set`) for this thread, where a key per variable is merged into it.
      // Checked with 0.171.0 on thread/start and thread/resume (docs/protocol.md §6 "环境").
      ...Object.fromEntries(
        Object.entries(sessionEnv)
          // A name with a dot would be a path of its own in Codex's config: the daemon sends none, and none is taken.
          .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
          .map(([name, value]) => [`shell_environment_policy.set.${name}`, value]),
      ),
      ...(trusted !== undefined
        ? { projects: { [params.cwd]: { trust_level: trusted ? "trusted" : "untrusted" } } }
        : {}),
    };
    // A session is on Codex's own models or on the owner's, by the model it begins with (a thread stays with the model
    // provider it began on, and Codex refuses a turn of another).
    const wanted = params._meta?.[META.model];
    const chosen = config.providers?.models.find((item) => item.id === wanted);
    // A session that began on one of the owner's models, whose provider or model is gone, cannot go on under Codex's own
    // provider: its thread is the gateway's. Said plainly, not resumed as something else.
    if (resume && chosen === undefined && typeof wanted === "string" && wanted.includes("/"))
      throw new RequestError(
        -32602,
        `This session runs on ${wanted}, which is no longer in your model providers. Add it back to continue it.`,
      );
    onProviders = chosen !== undefined;
    const child = new AppServer(
      config.providers && chosen
        ? { ...config, env: { ...config.env, [PROVIDER_TOKEN_ENV]: config.providers.token } }
        : config,
      event,
      (error) => {
        finish(turn?.cancelled ? "cancelled" : "error", error.message);
        clearCatalog();
        // The session cannot go on without it: the adapter ends too, so the daemon starts a new one and resumes.
        if (session !== undefined && !closing) config.onServerExit?.();
      },
      serverRequest,
    );
    server = child;
    // A profile and a `sandbox` on the thread cannot both be (Codex ignores the profile when `sandbox` is given: checked
    // with 0.166.0 and 0.171.0, `activePermissionProfile` stays null), so the thread has the profile alone. Built on
    // `:workspace` it gives the same sandbox `workspace-write` gives, unlocks Cycle's `.agents/{worktree,notes}` under
    // `cwd` (leaving `.agents/skills`, `.git`, `.codex`, and `.aws` read-only), adds extra folders as writable entries,
    // and sets `denyRead` files as `none` (last, so denials always win). A turn in Read only or Full access still names
    // its own sandbox below.
    const workspaceWritable = cycleWritableSubpaths(params.cwd);
    const deny = effectiveDenyRead(config.denyRead);
    workspaceProfile = workspaceWritable.length > 0 || deny.length > 0;
    if (workspaceProfile)
      codexConfig = {
        ...codexConfig,
        default_permissions: "cycle",
        permissions: {
          cycle: {
            extends: ":workspace",
            filesystem: {
              ...Object.fromEntries(additionalDirectories.map((path) => [path, "write"])),
              ...Object.fromEntries(workspaceWritable.map((path) => [path, "write"])),
              ...Object.fromEntries(deny.map((path) => [path, "none"])),
            },
          },
        },
      };
    const { sandbox: _sandbox, ...threadPolicy } = policy(mode);
    type Thread = { thread: { id: string }; model?: string; reasoningEffort?: string | null };
    try {
      await child.initialize();
      if (onProviders && config.providers) {
        const bundled = await loadBundledModels({
          codexExecutable: config.codexExecutable,
          env: config.env,
        });
        const written = await writeProviderCatalog(
          providerCatalogDocument(config.providers.models, bundled),
        );
        catalogDir = written.dir;
        codexConfig = {
          ...codexConfig,
          ...providerThreadConfig(config.providers, written.path),
        };
        catalog = providerCatalog(config.providers.models);
      } else {
        try {
          let cursor: string | null = null;
          do {
            const page: { data: Catalog[number][]; nextCursor: string | null } =
              await child.request("model/list", { cursor, limit: 100 });
            catalog = [...catalog, ...page.data];
            cursor = page.nextCursor;
          } while (cursor !== null);
        } catch {
          catalog = [];
        }
      }
      const settings = {
        cwd: params.cwd,
        ...(workspaceProfile ? threadPolicy : policy(mode)),
        ...(chosen !== undefined ? { model: chosen.id } : {}),
        ...(Object.keys(codexConfig).length > 0 ? { config: codexConfig } : {}),
        ...(developerInstructions ? { developerInstructions } : {}),
      };
      let result: Thread;
      if (resume) {
        try {
          result = await child.request<Thread>("thread/resume", {
            ...settings,
            threadId: resume.sessionId,
            excludeTurns: true,
          });
        } catch (error) {
          if (
            resume._meta?.["cycle/hadTurn"] === true ||
            !(error instanceof CodexRpcError) ||
            error.code !== -32600 ||
            error.message !== `no rollout found for thread id ${resume.sessionId}`
          )
            throw error;
          result = await child.request<Thread>("thread/start", settings);
        }
      } else result = await child.request<Thread>("thread/start", settings);
      owner = client;
      session = result.thread.id;
      threadModel = result.model;
      threadEffort = result.reasoningEffort ?? null;
      if (resume)
        await client.notify(methods.client.session.update, {
          sessionId: session,
          update: { sessionUpdate: "state_update", state: "idle" },
        });
      // Codex's skills, as commands once they are listed: the session does not wait on them.
      void loadSkills().then(() => {
        if (skills.length > 0 && session === result.thread.id)
          notify({ sessionUpdate: "available_commands_update", availableCommands: commands() });
      });
      // The account's limits as they stand; after that, as each response tells them.
      void child
        .request<GetAccountRateLimitsResponse>("account/rateLimits/read", {})
        .then((limits) => tellPlanUsage(limits.rateLimits))
        .catch(() => {});
      return {
        sessionId: session,
        configOptions: optionsOf(),
        availableCommands: commands(),
        ...(resume && session !== resume.sessionId
          ? { _meta: { "cycle/agentSessionId": session } }
          : {}),
      };
    } catch (error) {
      child.close();
      clearCatalog();
      server = undefined;
      throw error;
    }
  }
  const app = agent({ name: "cycle-codex-adapter" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      clientCanElicit =
        (params as { capabilities?: { elicitation?: { form?: unknown } } }).capabilities
          ?.elicitation?.form != null;
      return {
        protocolVersion: 2,
        info: { name: "cycle-codex-adapter", version: "0.0.0" },
        capabilities: {
          session: {
            prompt: CODEX_PROMPT_CAPABILITIES,
            mcp: { http: {}, stdio: {} },
            additionalDirectories: {},
            systemPrompt: {},
          },
        },
      };
    })
    .onRequest(methods.agent.session.new, ({ params, client }) => open(params, client))
    .onRequest(methods.agent.session.resume, ({ params, client }) => open(params, client, params))
    .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
      requireSession(params.sessionId);
      if (params.type !== "id") throw new RequestError(-32602, "Expected an option ID");
      if (params.configId === "mode") {
        const choice = modes.find((m) => m.value === params.value);
        if (!choice) throw new RequestError(-32602, "Unknown permission mode");
        mode = choice.value;
      } else if (params.configId === "model") {
        if (typeof params.value !== "string")
          throw new RequestError(-32602, "Expected a string value");
        if (params.value !== "default" && !catalog.some((item) => item.model === params.value)) {
          // The other kind of model is real, but not this session's: its thread began with the other provider.
          if (
            (config.providers?.models.some((item) => item.id === params.value) ?? false) !==
            onProviders
          )
            throw new RequestError(
              -32602,
              onProviders
                ? "This session runs on your own models; start a new session to use Codex's"
                : "This session runs on Codex's models; start a new session to use your own",
            );
          throw new RequestError(-32602, "Unknown Codex model");
        }
        model = params.value;
        if (effort !== "default" && !supports(model, effort)) effort = "default";
      } else if (params.configId === "effort") {
        if (typeof params.value !== "string")
          throw new RequestError(-32602, "Expected a string value");
        if (params.value !== "default" && !supports(model, params.value))
          throw new RequestError(-32602, "Unknown Codex reasoning effort");
        effort = params.value;
      } else throw new RequestError(-32602, "Unknown Codex setting");
      const configOptions = optionsOf();
      notify({ sessionUpdate: "config_option_update", configOptions });
      return { configOptions };
    })
    .onRequest(methods.agent.session.prompt, async ({ params }) => {
      const child = requireSession(params.sessionId);
      if (child.closed) throw new RequestError(-32600, "Codex app-server has exited");
      const compact =
        params._meta?.["cycle/steer"] !== true &&
        params.prompt.length === 1 &&
        params.prompt[0]?.type === "text" &&
        (params.prompt[0] as { text?: unknown }).text === "/compact";
      const input = compact ? [] : await withSkill(inputOf(params.prompt));
      if (params._meta?.["cycle/steer"] === true) {
        if (!turn?.id) throw new RequestError(-32600, "No Codex turn is running");
        const messageId = crypto.randomUUID();
        await child.request("turn/steer", {
          threadId: session,
          expectedTurnId: turn.id,
          clientUserMessageId: messageId,
          input,
        });
        notify({ sessionUpdate: "user_message", messageId, content: params.prompt });
        return { messageId };
      }
      if (turn) throw new RequestError(-32600, "A Codex turn is already running");
      const messageId = crypto.randomUUID();
      const active: Turn = {
        cancelled: false,
        approvals: new AbortController(),
        streamed: new Set(),
        tools: new Set(),
        compactions: new Set(),
      };
      turn = active;
      notify({ sessionUpdate: "user_message", messageId, content: params.prompt });
      notify({ sessionUpdate: "state_update", state: "running" });
      if (compact) {
        // Codex compacts in a turn of its own: its contextCompaction item and turn/completed end it like any other.
        void child.request("thread/compact/start", { threadId: session }).catch((error) => {
          if (turn === active) finish(active.cancelled ? "cancelled" : "error", String(error));
        });
        return { messageId };
      }
      void child
        .request<{ turn: { id: string } }>("turn/start", {
          threadId: session,
          input,
          ...turnSettings(),
        })
        .then(({ turn: started }) => {
          // turn/started may have said it first, and an early cancel has then been sent.
          if (turn !== active || active.id !== undefined) return;
          active.id = started.id;
          if (active.cancelled) interrupt(active);
        })
        .catch((error) => {
          if (turn === active) finish(active.cancelled ? "cancelled" : "error", String(error));
        });
      return { messageId };
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      if (children.has(params.sessionId)) {
        endChildAsks(params.sessionId);
        const childTurn = childTurns.get(params.sessionId);
        if (childTurn && server)
          void server
            .request("turn/interrupt", { threadId: params.sessionId, turnId: childTurn })
            .catch(() => {});
        return;
      }
      if (params.sessionId !== session || !turn || turn.cancelled) return;
      turn.cancelled = true;
      turn.approvals.abort();
      turn.timer = setTimeout(
        () => server?.close(new Error("Codex did not acknowledge cancellation")),
        4000,
      );
      interrupt(turn);
    })
    .onRequest(methods.agent.session.close, ({ params }) => {
      requireSession(params.sessionId);
      closing = true;
      childApprovals.abort();
      finish("cancelled");
      server?.close();
      server = undefined;
      session = undefined;
      clearCatalog();
      return {};
    });
  return {
    app,
    close: () => {
      closing = true;
      childApprovals.abort();
      server?.close();
      clearCatalog();
    },
  };
}

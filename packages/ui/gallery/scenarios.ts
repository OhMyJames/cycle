// The gallery's scenarios: one state of the interface each, drawn by the real components over a scripted
// bridge. DESIGN.md says what each is for. Add one when a surface gets a new state.
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import type {
  AccountStatus,
  AppEvent,
  ConnectorInfo,
  EnvironmentConfig,
  EnvironmentStatus,
  PermissionRequest,
  PlanUsage,
  PluginInfo,
  PluginSourceInfo,
  SessionSnapshot,
  SessionSummary,
  UpdateState,
} from "../src/api.ts";
import type { Attachment } from "../src/attachments.ts";
import { type CodeThemeId, codeTheme } from "../src/code-theme.ts";
import { displayMode } from "../src/display-mode.ts";
import { applyUpdate, emptyConversation } from "../src/model/index.ts";
import { READING, READING_STREAMING } from "../test/markdown-samples.ts";
import {
  BEFORE_DROP,
  OLD_UPDATES_SENT,
  PARALLEL,
  PARALLEL_PROMPT,
  RECONNECT_PROMPT,
  turnOf,
  WHILE_AWAY,
} from "../test/samples.ts";
import { SAMPLE_PNG } from "./sample-image.ts";

export type Scenario = {
  title: string;
  environments?: EnvironmentConfig[];
  status?: EnvironmentStatus[];
  sessions?: SessionSummary[];
  /** The conversation of the session that is opened. Without it nothing is opened. */
  history?: SessionUpdate[];
  permissions?: PermissionRequest[];
  update?: UpdateState;
  /** What the daemons keep as connectors (the Connectors page); the environments' `status` must say they can. */
  connectors?: ConnectorInfo[];
  /** An agent's plugins: what can be installed (the installed ones among them), and where it comes from. */
  plugins?: { sources: PluginSourceInfo[]; all: PluginInfo[] };
  /** Usage statistics have somewhere to report to, and are on: Settings shows their switch. */
  analytics?: boolean;
  /** The language the person chose for the interface. Without it: the system's, which here is en-US. */
  language?: "zh-CN";
  /** The agent takes images: the composer shows how to attach them. */
  attach?: boolean;
  /** The environment has a second agent (Codex): sessions say which agent they are of, and a new one can choose. */
  secondAgent?: boolean;
  /** The environment has no available agent: the blank view explains why and offers a re-check. */
  noAgents?: boolean;
  /** Folder trust: the daemon keeps it, and this is the decision for every folder (null: nobody has decided). */
  trust?: boolean | null;
  /** What the environment's daemon heard of each agent's plan limits (docs/protocol.md §8 "套餐用量"). */
  planUsage?: Record<string, PlanUsage>;
  /** Presses Tab this many times with real input events, so :focus-visible shows as it does for a keyboard. */
  tabs?: number;
  /**
   * A blank conversation is opened, in this folder. `starting`: this first message is sent, and the session it makes is
   * never answered, so that the page stays as it is while a session is being made.
   */
  blank?: { cwd?: string; starting?: string };
  /** Each session's own conversation, by its id, when the sessions differ; others open `history`. */
  histories?: Record<string, SessionUpdate[]>;
  /** The first session's right panel is open beside the conversation (CYCL-90): the columns at this window's width. */
  sidePanel?: boolean;
  /** How the account stands (.agents/notes/2026-11-23-sso-login-desktop-must-sign-in.md). Without it: signed in. */
  account?: AccountStatus;
  /** A message is sent from the open session and refused in these words: the red line under its title bar. */
  fails?: string;
  /** What the open session's message box holds when it is drawn: words, and files attached to them. */
  draft?: { text: string; attachments?: Attachment[] };
  /** Runs once the page has drawn: open a dialog, press a key, or send an event as the app's main process would. */
  after?: (root: HTMLElement, emit: (event: AppEvent) => void) => Promise<void>;
};

const u = (update: object) => update as SessionUpdate;

// For the scenarios that act on the page after it has drawn: wait for a condition, and fail loudly if it never comes.
const until = async (condition: () => boolean, what: string, ms = 4000) => {
  for (let waited = 0; waited < ms; waited += 25) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`gallery: timed out waiting for ${what}`);
};
const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r(undefined)));
};
const conversationOf = (root: HTMLElement): HTMLElement => {
  const el = root.querySelector<HTMLElement>('[data-slot="conversation"]');
  if (el === null) throw new Error("gallery: no conversation on the page");
  return el;
};
const drawnIn = (el: HTMLElement): number => el.querySelectorAll('[data-slot="block"]').length;
const LOCAL: EnvironmentConfig = { id: "local", name: "This computer", kind: "local" };
const BUILD: EnvironmentConfig = {
  id: "build",
  name: "build-1",
  kind: "remote",
  transport: { type: "ssh", host: "build-1" },
};
const UP = (environmentId: string): EnvironmentStatus => ({ environmentId, state: "connected" });

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  environmentId: "local",
  sessionId: id,
  cwd: "/home/dev/cycle-v1",
  archived: false,
  agent: "claude",
  state: "idle",
  lastSeq: 1,
  // What a session made since the daemon records its settings has: the composer shows them.
  config: { mode: "auto", model: "opus", effort: "medium" },
  ...over,
});

const say = (id: string, t: string) =>
  u({ sessionUpdate: "agent_message", messageId: id, content: [{ type: "text", text: t }] });
const you = (id: string, t: string) =>
  u({ sessionUpdate: "user_message", messageId: id, content: [{ type: "text", text: t }] });
const tool = (id: string, name: string, status: string, rawInput: object) => [
  u({ sessionUpdate: "tool_call_update", toolCallId: id, name, status: "pending" }),
  u({ sessionUpdate: "tool_call_update", toolCallId: id, status, rawInput }),
];
/** A finished call with the result an agent sent for it: its content, rawOutput and locations. */
const done = (id: string, name: string, rawInput: object, result: object) => [
  u({ sessionUpdate: "tool_call_update", toolCallId: id, name, status: "pending" }),
  u({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", rawInput }),
  u({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", ...result }),
];
const text = (t: string) => [{ type: "content", content: { type: "text", text: t } }];
const diff = (path: string, created: boolean, hunks: string) => ({
  type: "diff",
  changes: [{ operation: created ? "add" : "modify", path }],
  patch: {
    format: "git_patch",
    text: `diff --git a/${path} b/${path}\n${created ? "--- /dev/null" : `--- a/${path}`}\n+++ b/${path}\n${hunks}`,
  },
});
const idle = (extra: object = {}) => u({ sessionUpdate: "state_update", state: "idle", ...extra });
const running = () => u({ sessionUpdate: "state_update", state: "running" });

const MARKDOWN = [
  "The build fails in two places. Both come from the same change.",
  "",
  "| File | Problem |",
  "| --- | --- |",
  "| `packages/daemon/src/daemon.ts` | the cwd is not checked |",
  "| `apps/daemon/src/proxy.ts` | the log is not kept |",
  "",
  "```ts",
  "if (!(await stat(params.cwd).then((s) => s.isDirectory(), () => false)))",
  '  throw new RpcError(INVALID_PARAMS, "The working directory does not exist");',
  "```",
  "",
  "- check the directory first",
  "- keep the daemon's output in a file",
].join("\n");

const LONG_PATH = `/home/dev/${"very-long-directory-name-".repeat(12)}file.ts`;

const CODE = [
  "Here is the same change in four languages.",
  "",
  "```ts",
  "export const toolSummary = (tool: ToolItem): string => {",
  "  // A line saying what a tool is doing.",
  "  const input = (tool.rawInput ?? {}) as Record<string, unknown>;",
  '  return typeof input.command === "string" ? input.command : "";',
  "};",
  "```",
  "",
  "```bash",
  'bun run check && git commit -m "ui: search" # the gate runs first',
  'for f in *.ts; do echo "$f"; done',
  "```",
  "",
  "```json",
  '{ "name": "cycle", "version": "0.1.1", "private": true, "scripts": { "check": "bun scripts/check.ts" } }',
  "```",
  "",
  "```diff",
  "- const radius = 0;",
  "+ const radius = 8;",
  "```",
  "",
  "```python",
  "def total(items: list[int]) -> int:",
  "    return sum(x for x in items if x > 0)",
  "```",
].join("\n");

/** 240 turns: about 1200 blocks. */
const LONG: SessionUpdate[] = Array.from({ length: 240 }, (_, n) => [
  you(`u${n}`, `Question ${n + 1}: what does step ${n + 1} do?`),
  ...tool(`r${n}`, "Read", "completed", { file_path: `src/step-${n + 1}.ts` }),
  ...tool(`b${n}`, "Bash", "completed", { command: `bun test step-${n + 1}` }),
  say(
    `m${n}`,
    `Step ${n + 1} reads its input, checks it, and passes it on. ${"It keeps no state between calls. ".repeat(6)}`,
  ),
  idle({ stopReason: "end_turn" }),
]).flat();

const tryoutGoal = {
  condition: "The remote session reconnects after the laptop sleeps, and every test passes",
  iterations: 0,
  setAt: Date.UTC(2026, 10, 22, 9, 30),
};
const hello: SessionUpdate[] = [
  u({
    sessionUpdate: "user_message",
    messageId: "h1",
    content: [{ type: "text", text: "Say hello" }],
  }),
  u({
    sessionUpdate: "agent_message_chunk",
    messageId: "h2",
    content: { type: "text", text: "Hello." },
  }),
  u({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }),
];

export const conversation: SessionUpdate[] = [
  you("u1", "Why does the remote session fail, and fix it."),
  u({
    sessionUpdate: "agent_thought_chunk",
    messageId: "t1",
    content: { type: "text", text: "The error mentions libc, but the directory may be missing." },
  }),
  ...tool("c1", "Bash", "completed", { command: "ls /data/workspaces" }),
  ...tool("c2", "Read", "failed", { file_path: "/data/workspaces/missing.ts" }),
  ...tool("c3", "Bash", "in_progress", { command: "bun test packages/daemon" }),
  u({
    sessionUpdate: "plan_update",
    plan: {
      type: "items",
      planId: "p",
      entries: [
        { content: "Find the cause", priority: "high", status: "completed" },
        { content: "Check the directory in the daemon", priority: "high", status: "in_progress" },
        { content: "Add a test", priority: "medium", status: "pending" },
      ],
    },
  }),
  say("a1", MARKDOWN),
  u({ sessionUpdate: "usage_update", used: 41_200, size: 200_000 }),
  idle({ stopReason: "end_turn" }),
];

/** The session to try the panel on: the conversation, a goal, a command running on in the background, a watcher lost. */
const tryout: SessionUpdate[] = [
  ...conversation,
  u({ sessionUpdate: "_cycle/goal_update", goal: tryoutGoal }),
  u({
    sessionUpdate: "_cycle/task_update",
    taskId: "b1",
    kind: "shell",
    title: "bun test packages/daemon",
    toolCallId: "c3",
    state: "running",
  }),
  u({
    sessionUpdate: "_cycle/task_update",
    taskId: "m1",
    kind: "monitor",
    title: "Watch the daemon log for reconnects",
    toolCallId: "c1",
    state: "unknown",
  }),
];

const permission = (title: string, command: string): PermissionRequest => ({
  key: "local:s1:p1",
  environmentId: "local",
  sessionId: "s1",
  title,
  subject: { type: "tool_call", toolCall: { name: "Bash", rawInput: { command } } },
  options: [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "always", name: "Allow always", kind: "allow_always" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
});

/** An element's accessible name: its label, what names it (an icon-only button's tip), else its text. */
const nameOf = (e: Element): string =>
  e.getAttribute("aria-label") ??
  (e
    .getAttribute("aria-labelledby")
    ?.split(" ")
    .map((id) => e.ownerDocument.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim() ||
    (e.textContent?.trim() ?? ""));

const click = async (root: HTMLElement, text: string) => {
  for (let i = 0; i < 50; i++) {
    const found = Array.from(root.querySelectorAll('button, [role="menuitem"]')).find(
      // By its name: a button's label when it has one (the sidebar's actions also show their shortcut), else its text.
      (b) => nameOf(b) === text,
    );
    if (found) return void (found as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no button "${text}"`);
};

/** Cmd+K / Ctrl+K, as the keyboard does it (the page reads either). */
const openSearch = async (root: HTMLElement) => {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true }),
  );
  for (
    let i = 0;
    i < 40 && root.ownerDocument.querySelector('[data-palette="search"]') === null;
    i++
  )
    await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200));
};

const clickByLabel = async (root: HTMLElement, label: string) => {
  for (let i = 0; i < 50; i++) {
    const found = Array.from(root.querySelectorAll("[aria-label], [aria-labelledby]")).find(
      (e) => nameOf(e) === label,
    ) as HTMLElement | undefined;
    if (found) return void found.click();
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`nothing labelled "${label}"`);
};

/** The settings page, opened as its button does, on one of its sections. */
const openSettings = async (root: HTMLElement, section?: string) => {
  await until(
    () => root.querySelector('[data-kind="settings-open"]') !== null,
    "the settings button",
  );
  root.querySelector<HTMLElement>('[data-kind="settings-open"]')?.click();
  await until(() => root.querySelector('[data-kind="page"]') !== null, "the settings page");
  if (section !== undefined) {
    const tab = Array.from(root.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      (t) => t.textContent === section,
    );
    if (tab === undefined) throw new Error(`no section "${section}"`);
    tab.click();
  }
  await new Promise((r) => setTimeout(r, 250));
};

/** The Connectors page, opened as the sidebar's row does. */
const openConnectors = async (root: HTMLElement, section: "plugins" | "mcp" = "mcp") => {
  await until(
    () => root.querySelector('[data-page-open="connectors"]') !== null,
    "the Connectors row",
  );
  root.querySelector<HTMLElement>('[data-page-open="connectors"]')?.click();
  await until(() => root.querySelector('[data-kind="page"]') !== null, "the Connectors page");
  // The page opens on Plugins, its first section; the second is a tab away.
  if (section === "mcp") root.querySelectorAll<HTMLElement>('[data-slot="tabs-tab"]')[1]?.click();
  await new Promise((r) => setTimeout(r, 400));
};
/** An environment whose daemon keeps connectors. */
const KEEPS = (environmentId: string): EnvironmentStatus => ({
  ...UP(environmentId),
  capabilities: { queue: true, files: true, folders: true, connectors: true },
});
const connector = (id: string, name: string, over: Partial<ConnectorInfo> = {}): ConnectorInfo => ({
  id,
  name,
  enabled: true,
  transport: { type: "http", url: `https://mcp.${name}.example/mcp` },
  auth: { type: "none" },
  secrets: { headers: [], env: [] },
  authorized: false,
  status: { state: "ready" },
  ...over,
});
const CONNECTORS: ConnectorInfo[] = [
  connector("c1", "linear", { secrets: { headers: ["Authorization"], env: [] } }),
  connector("c2", "notion", { auth: { type: "oauth" }, status: { state: "needs_auth" } }),
  connector("c3", "a-connector-with-the-longest-name", {
    transport: {
      type: "stdio",
      command: "/Users/me/.local/share/tools/node_modules/.bin/some-mcp-server",
      args: ["--root", "/Users/me/work/a/very/long/path/to/a/repository", "--read-only"],
    },
    status: { state: "error", reason: "spawn_failed" },
  }),
  connector("c4", "sentry", { enabled: false, status: { state: "disabled" } }),
];

/** An environment whose daemon keeps connectors, and whose Claude has plugins. */
const EXTENDS = (environmentId: string): EnvironmentStatus => ({
  ...UP(environmentId),
  capabilities: { queue: true, files: true, folders: true, connectors: true, plugins: ["claude"] },
});
const PLUGIN_SOURCES: PluginSourceInfo[] = [
  {
    agentId: "claude",
    id: "directory",
    name: "anthropic-plugin-directory",
    kind: "builtin",
    removable: false,
  },
  {
    agentId: "claude",
    id: "team",
    name: "team-plugins",
    kind: "git",
    location: "acme/team-plugins",
    removable: true,
  },
  {
    agentId: "claude",
    id: "local",
    name: "a-source-with-a-long-name-kept-in-a-folder",
    kind: "directory",
    location: "/Users/me/work/a/very/long/path/to/a/repository/of/plugins/kept/locally",
    removable: true,
  },
];
const plugin = (name: string, description: string, over: Partial<PluginInfo> = {}): PluginInfo => ({
  agentId: "claude",
  id: `${name}@directory`,
  name,
  description,
  sourceId: "directory",
  installed: false,
  ...over,
});
const PLUGINS: PluginInfo[] = [
  plugin(
    "linear",
    "Linear issue tracking integration. Create issues, manage projects, update statuses.",
    {
      installed: true,
      enabled: true,
      scope: "user",
      contents: { skills: 0, commands: 0, agents: 0, hooks: 0, mcpServers: 1 },
      servers: [{ name: "linear", by: "cycle", connectorId: "p1" }],
    },
  ),
  plugin(
    "superpowers",
    "Core skills library: TDD, debugging, collaboration patterns, and proven techniques, described at a length that does not fit on one line of this page however wide it is made",
    {
      installed: true,
      enabled: true,
      scope: "user",
      version: "7.0.2",
      contents: { skills: 14, commands: 3, agents: 1, hooks: 2, mcpServers: 0 },
    },
  ),
  plugin("reviewer", "Reviews a change before it is committed", {
    id: "reviewer@team",
    sourceId: "team",
    installed: true,
    enabled: false,
    scope: "user",
    version: "0.4.0",
    contents: { skills: 1, commands: 2, agents: 2, hooks: 0, mcpServers: 0 },
  }),
  plugin(
    "figma",
    "Figma design platform integration. Access design files and translate designs into code.",
  ),
  plugin("frontend-design", "Frontend design skill for UI/UX implementation"),
  plugin("github", "Official GitHub MCP server for repository management."),
  ...Array.from({ length: 60 }, (_, i) =>
    plugin(`plugin-${String(i + 1).padStart(2, "0")}`, "One of the many a directory lists"),
  ),
];
const PLUGIN_SERVERS: ConnectorInfo[] = [
  connector("p1", "linear-linear", {
    transport: { type: "http", url: "https://mcp.linear.app/mcp" },
    auth: { type: "oauth" },
    status: { state: "needs_auth" },
    origin: {
      type: "plugin",
      agentId: "claude",
      pluginId: "linear@directory",
      pluginName: "linear",
      server: "linear",
    },
  }),
];

/** An item of a remote environment's menu in Settings, opened as a click would. */
const environmentAction = async (root: HTMLElement, name: string, item: string) => {
  await openSettings(root, "Environments");
  await clickByLabel(root, `Actions for ${name}`);
  await new Promise((r) => setTimeout(r, 200));
  await click(root.ownerDocument.body, item);
};

// The context ring opened into its details, in each of the states it has something to say about.
const openContext = async (root: HTMLElement) => {
  await until(() => root.querySelector('[data-kind="context-meter"]') !== null, "the context ring");
  root.querySelector<HTMLElement>('[data-kind="context-meter"]')?.click();
  await until(
    () => document.querySelector('[data-kind="context"]') !== null,
    "the context details",
  );
  await new Promise((r) => setTimeout(r, 250));
};
const contextScenario = (title: string, history: SessionUpdate[]): Scenario => ({
  title,
  sessions: [
    session("s1", {
      title: "Redesign the composer",
      config: { mode: "auto", model: "opus", effort: "high" },
    }),
  ],
  history,
  after: openContext,
});
// A turn's usage as Claude Code counts it: the window it measures against, and what is in it.
const part = (id: string, name: string, tokens: number, kind = "used") => ({
  id,
  name,
  tokens,
  kind,
});
const measured = u({
  sessionUpdate: "usage_update",
  used: 161_300,
  size: 200_000,
  cost: { amount: 2.37, currency: "USD" },
  _meta: {
    "cycle/context": {
      window: 200_000,
      autoCompactAt: 167_000,
      parts: [
        part("system_prompt", "System prompt", 6_000),
        part("system_tools", "System tools", 8_700),
        part("mcp_tools", "MCP tools", 1_500),
        part("mcp_tools_deferred", "MCP tools (deferred)", 89_300, "deferred"),
        part("skills", "Skills", 2_900),
        part("messages", "Messages", 142_200),
        part("autocompact_buffer", "Autocompact buffer", 33_000, "buffer"),
        part("free_space", "Free space", 5_700, "free"),
      ],
    },
  },
});

export const scenarios: Record<string, Scenario> = {
  empty: { title: "Connected, no sessions", sessions: [] },
  conversation: {
    title: "A finished turn: thought, tools (done, failed, running), plan, markdown, usage",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
  },
  turns: {
    title:
      "Three turns: a card of tool calls that went well; a turn that failed (the failure pulled out, how it ended); a turn that is going (the step)",
    sessions: [session("s1", { title: "Ship the fix", state: "running" })],
    history: [
      // A mention: the text says @path, and the link that goes with it is not drawn again.
      u({
        sessionUpdate: "user_message",
        messageId: "u1",
        content: [
          { type: "text", text: "Run the tests in @packages/daemon and fix what fails." },
          {
            type: "resource_link",
            name: "daemon",
            uri: "file:///home/dev/cycle-v1/packages/daemon/",
            _meta: { "cycle/mention": "packages/daemon" },
          },
        ],
      }),
      ...tool("a1", "Read", "completed", { file_path: "packages/daemon/src/daemon.ts" }),
      ...tool("a2", "Read", "completed", { file_path: "packages/daemon/test/daemon.test.ts" }),
      ...tool("a3", "Edit", "completed", { file_path: "packages/daemon/src/daemon.ts" }),
      ...tool("a4", "Bash", "completed", {
        command: "bun test packages/daemon",
        description: "Run the daemon tests",
      }),
      say(
        "m1",
        "Two tests failed because the working directory was never checked. I fixed it and the suite passes.",
      ),
      idle({ stopReason: "end_turn" }),
      you("u2", "Now deploy it."),
      ...tool("b1", "Bash", "completed", { command: "bun run build" }),
      ...tool("b2", "Bash", "completed", { command: "scp dist/cycle-daemon build-1:" }),
      ...tool("b3", "Bash", "failed", { command: "ssh build-1 ./cycle-daemon --version" }),
      idle({ stopReason: "error", error: { message: "The agent exited unexpectedly (code 1)" } }),
      you("u3", "Try again, with the staging profile."),
      running(),
      ...tool("c1", "Read", "completed", { file_path: "deploy/staging.json" }),
      ...tool("c2", "Bash", "in_progress", {
        command: "bun run deploy --profile staging",
        description: "Deploy to staging",
      }),
    ],
  },
  stepLine: {
    title:
      "The line at the end of a turn that is going, after its calls: the brand's loader, the words, the whole turn's time",
    sessions: [session("s1", { title: "Ship the fix", state: "running" })],
    history: [
      you("u1", "Run the tests and fix what fails."),
      running(),
      ...tool("d1", "Bash", "completed", { command: "bun test packages/daemon" }),
      ...tool("d2", "Read", "completed", { file_path: "packages/daemon/src/daemon.ts" }),
      u({
        sessionUpdate: "agent_thought",
        messageId: "t1",
        content: [{ type: "text", text: "The working directory is never checked." }],
      }),
    ],
  },
  plan: {
    title:
      "The plan above the input box, opened: what is open first, what is done ticked, struck and below",
    sessions: [session("s1", { title: "Overview panel", state: "running" })],
    history: [
      you("u1", "Build the overview panel."),
      u({
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: "tasks",
          entries: [
            {
              content: "CYCL-85 research overview data sources",
              priority: "medium",
              status: "completed",
            },
            {
              content: "CYCL-86 design overview hierarchy & interactions",
              priority: "medium",
              status: "completed",
            },
            {
              content: "CYCL-87 add missing L1 events (protocol doc first, mapping, replay)",
              priority: "medium",
              status: "completed",
            },
            { content: "CYCL-90 right panel container", priority: "medium", status: "in_progress" },
            {
              content: "CYCL-88 overview panel implementation",
              priority: "medium",
              status: "pending",
            },
          ],
        },
      }),
    ],
    after: async (root) => {
      await until(
        () => root.querySelector('[data-kind="plan-strip"] > button') !== null,
        "the plan strip",
      );
      root.querySelector<HTMLElement>('[data-kind="plan-strip"] > button')?.click();
      await new Promise((r) => setTimeout(r, 300));
    },
  },
  work: {
    title:
      "A command's output and errors apart, a sub-agent in the background, a compaction, a plan proposed, and the plan above the input box",
    sessions: [session("s1", { title: "Speed up the build", state: "running" })],
    history: [
      you("u1", "The build is slow. Find out why and make a plan."),
      u({
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: "tasks",
          entries: [
            { content: "Profile the build", priority: "medium", status: "completed" },
            { content: "Cache the dependency step", priority: "medium", status: "in_progress" },
            { content: "Measure again", priority: "medium", status: "pending" },
          ],
        },
      }),
      ...done(
        "b1",
        "Bash",
        { command: "bun run build --profile", description: "Profile the build" },
        {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: Array.from(
                  { length: 60 },
                  (_, n) =>
                    `\x1b[2m[${n + 1}/60]\x1b[0m step ${n + 1} ${n % 7 === 0 ? "\x1b[33m(slow)\x1b[0m" : "\x1b[32mok\x1b[0m"}`,
                ).join("\n"),
              },
            },
            {
              type: "content",
              content: {
                type: "text",
                text: "warning: cache directory not found, building from scratch",
              },
              _meta: { "cycle/stream": "stderr" },
            },
          ],
          _meta: { "cycle/toolResult": { run: { timedOutMs: 120000, background: true } } },
        },
      ),
      say(
        "m1",
        "Most of the time is in installing dependencies. A sub-agent is checking the cache settings.",
      ),
      ...tool("a1", "Agent", "completed", { description: "Check the cache settings", prompt: "…" }),
      u({
        sessionUpdate: "subagent_update",
        sessionId: "task-1",
        state: { state: "running" },
        _meta: { "cycle/subagent": { toolCallId: "a1", background: true, lastTool: "Grep" } },
      }),
      u({ sessionUpdate: "compaction_update", compactionId: "k1", status: "completed" }),
      ...done(
        "p1",
        "ExitPlanMode",
        { plan: "## Cache the install\n\n1. Keep `node_modules` between runs\n2. Measure again" },
        {},
      ),
    ],
    after: async (root) => {
      for (const label of ["Profile the build", "Proposed a plan"]) {
        const row = [...root.querySelectorAll<HTMLElement>('[data-kind="tool"] > button')].find(
          (b) => b.textContent?.includes(label),
        );
        row?.click();
      }
      (document.activeElement as HTMLElement | null)?.blur();
      await frames(4);
    },
  },
  web: {
    title:
      "The web and MCP: a search's hits as links with their sites, a fetch that failed (404), an MCP tool by its title and the first short line of its input, and a tool nothing knows",
    sessions: [session("s1", { title: "Check the docs" })],
    history: [
      you("u1", "How do I run one test file with Bun? Then file an issue to update our docs."),
      ...done(
        "w1",
        "WebSearch",
        { query: "bun test run a single file" },
        {
          content: [
            { type: "content", content: { type: "text", text: "Three results look relevant." } },
            ...[
              ["Test runner – Bun docs", "https://bun.sh/docs/cli/test"],
              ["Writing tests | Bun Docs", "https://www.bun.sh/docs/test/writing"],
              [
                "How to run a single test file with bun test? A long question title that wraps onto a second line in a narrow window",
                "https://stackoverflow.com/questions/77000000/bun-test-single-file",
              ],
            ].map(([name, uri]) => ({
              type: "content",
              content: { type: "resource_link", uri, name },
            })),
          ],
        },
      ),
      say("m1", "The docs say to pass the file's path. Let me check the old page we link to."),
      ...done(
        "w2",
        "WebFetch",
        { url: "https://bun.sh/docs/old-test-page", prompt: "What does it say about one file?" },
        {
          content: [{ type: "content", content: { type: "text", text: "Page not found." } }],
          _meta: { "cycle/toolResult": { fetch: { status: 404, bytes: 1534 } } },
        },
      ),
      say("m2", "That page is gone. Filing the issue."),
      u({
        sessionUpdate: "tool_call_update",
        toolCallId: "w3",
        name: "mcp__linear__create_issue",
        title: "linear · create_issue",
        status: "completed",
        rawInput: {
          title: "Update the test docs link",
          team: "CYCL",
          description: "The link in…\nlong",
        },
        content: [{ type: "content", content: { type: "text", text: "Created CYCL-52" } }],
      }),
      ...done(
        "w4",
        "CronList",
        {},
        { content: [{ type: "content", content: { type: "text", text: "No jobs." } }] },
      ),
      say("m3", "Done: `bun test path/to/file.test.ts`, and CYCL-52 tracks the docs."),
      idle({ stopReason: "end_turn" }),
    ],
    after: async (root) => {
      const row = [...root.querySelectorAll<HTMLElement>('[data-kind="tool"] > button')].find((b) =>
        b.textContent?.includes("bun test run a single file"),
      );
      row?.click();
      root.querySelector<HTMLElement>('[data-kind="work"] > button')?.click();
      (document.activeElement as HTMLElement | null)?.blur();
      await frames(4);
    },
  },
  ask: {
    title:
      "The agent asks: a question with choices and an answer of one's own, as a form above the input box",
    sessions: [session("s1", { state: "requires_action", title: "Pick a validation library" })],
    history: [you("u1", "Add validation to the config file."), running()],
    permissions: [
      {
        key: "local:s1:f1",
        environmentId: "local",
        sessionId: "s1",
        title: "Claude has some questions",
        options: [],
        form: {
          message: "Claude has some questions",
          schema: {
            type: "object",
            properties: {
              q0: {
                type: "string",
                title: "Library",
                description: "Which library should we use?",
                oneOf: [
                  {
                    const: "zod",
                    title: "zod",
                    description: "Already a dependency of the protocol package",
                  },
                  { const: "valibot", title: "valibot", description: "Smaller, newer" },
                ],
              },
              q0_other: {
                type: "string",
                title: "Other",
                description: "Your own answer, if none of the choices fits",
                maxLength: 2000,
              },
              q1: {
                type: "array",
                title: "Checks",
                description: "What should be checked?",
                items: {
                  anyOf: [
                    { const: "types", title: "Types" },
                    { const: "ranges", title: "Ranges" },
                    { const: "paths", title: "Paths exist" },
                  ],
                },
              },
              q1_other: {
                type: "string",
                title: "Other",
                description: "Your own answer, if none of the choices fits",
                maxLength: 2000,
              },
            },
          },
        },
      },
    ],
    after: async (root) => {
      root.querySelector<HTMLInputElement>('[data-slot="form-option"] input')?.click();
      root
        .querySelector<HTMLInputElement>('[data-slot="form-option"] input[type="checkbox"]')
        ?.click();
      (document.activeElement as HTMLElement | null)?.blur();
      await frames(2);
    },
  },
  files: {
    title:
      "File tools with what they amount to: an edit's own lines (+2 −1), a new file, the lines a read read, a picture read, what searches found",
    sessions: [session("s1", { title: "Tidy the daemon's config" })],
    history: [
      you("u1", "Make the port configurable and add a README for it."),
      ...done(
        "f1",
        "Read",
        { file_path: "packages/daemon/src/config.ts", offset: 20, limit: 40 },
        {
          content: text("    20\texport const PORT = 4100;\n    21\t"),
          _meta: { "cycle/toolResult": { read: { startLine: 20, numLines: 40, totalLines: 212 } } },
        },
      ),
      say("m1", "The port is a constant. I'll read it from the environment instead."),
      ...done(
        "f2",
        "Edit",
        { file_path: "packages/daemon/src/config.ts", old_string: "…", new_string: "…" },
        {
          content: [
            diff(
              "packages/daemon/src/config.ts",
              false,
              '@@ -19,4 +19,5 @@\n import { env } from "./env.ts";\n \n-export const PORT = 4100;\n+export const PORT = Number(env.CYCLE_PORT ?? 4100);\n+export const HOST = "127.0.0.1";\n \n',
            ),
          ],
          _meta: { "cycle/toolResult": { edit: { additions: 2, deletions: 1 } } },
        },
      ),
      say("m2", "Now the README."),
      ...done(
        "f3",
        "Write",
        { file_path: "packages/daemon/README.md", content: "…" },
        {
          content: [
            diff(
              "packages/daemon/README.md",
              true,
              "@@ -0,0 +1,3 @@\n+# Daemon\n+\n+Set `CYCLE_PORT` to change the port (default 4100).\n",
            ),
          ],
          _meta: { "cycle/toolResult": { edit: { additions: 3, deletions: 0, created: true } } },
        },
      ),
      say("m3", "And where else the port is used:"),
      ...done(
        "f4",
        "Grep",
        { pattern: "PORT", output_mode: "count" },
        {
          content: text("src/config.ts:2\nsrc/serve.ts:3"),
          _meta: { "cycle/toolResult": { search: { files: 2, matches: 5 } } },
        },
      ),
      say("m4", "The diagram the README should show:"),
      ...done(
        "f5",
        "Glob",
        { pattern: "docs/**/*.png" },
        {
          content: text("docs/daemon.png"),
          _meta: { "cycle/toolResult": { search: { files: 1 } } },
        },
      ),
      say("m6", "Here it is."),
      ...done(
        "f6",
        "Read",
        { file_path: "docs/daemon.png" },
        {
          content: [
            {
              type: "content",
              content: { type: "image", data: SAMPLE_PNG, mimeType: "image/png" },
            },
          ],
        },
      ),
      say("m5", "Done: the port comes from `CYCLE_PORT`, and the README says so."),
      idle({ stopReason: "end_turn" }),
    ],
    after: async (root) => {
      for (const id of ["config.ts", "README.md", "daemon.png"]) {
        const row = [...root.querySelectorAll<HTMLElement>('[data-kind="tool"] > button')].find(
          (b) =>
            b.textContent?.includes(id) && (id !== "config.ts" || b.textContent.includes("Edited")),
        );
        row?.click();
      }
      (document.activeElement as HTMLElement | null)?.blur();
      await frames(4);
      const list = conversationOf(root);
      list.scrollTop = list.scrollHeight;
      await frames(4);
    },
  },
  long: {
    title:
      "A long conversation (240 turns): only the end is drawn; scrolling to the top adds earlier blocks without moving what is being read",
    sessions: [session("s1", { title: "A very long session" })],
    history: LONG,
    after: async (root) => {
      const el = conversationOf(root);
      // Chromium keeps the reader in place by itself (scroll anchoring); WebKit does not. Turn it off, so that this checks
      // the view's own correction, which is what a browser without anchoring would need.
      el.style.overflowAnchor = "none";
      await until(
        () => el.scrollHeight > el.clientHeight + 2200,
        "the conversation to have content to scroll",
      );
      const first = drawnIn(el);
      // 240 turns have about 1200 blocks; only the last page is drawn.
      if (first > 80) console.error(`long: ${first} blocks drawn, expected about 60`);
      el.scrollTop = 1800;
      await until(() => Math.abs(el.scrollTop - 1800) < 2, "the scroll to 1800");
      // A block in view stays where it is, whatever is added above it.
      const reading = Array.from(el.querySelectorAll<HTMLElement>('[data-slot="block"]')).find(
        (b) => b.getBoundingClientRect().top > el.getBoundingClientRect().top + 20,
      );
      if (reading === undefined) throw new Error("long: no block in view to read");
      const offset = () => reading.getBoundingClientRect().top - el.getBoundingClientRect().top;
      const before = offset();
      const was = el.scrollTop;
      el.scrollTop = 100;
      await until(() => drawnIn(el) > first, "earlier blocks to be drawn");
      await frames(3);
      // It moved only by what the scroll itself moved, not by the blocks added above it.
      const moved = Math.abs(offset() - (before - (100 - was)));
      if (moved > 4) console.error(`long: the block being read jumped by ${moved}px`);
      el.scrollTop = el.scrollHeight;
      await frames(3);
    },
  },
  "long-back": {
    title:
      "Going back to a long session finds the reader where they were (scrolled up, with earlier blocks drawn)",
    sessions: [
      session("s1", { title: "A very long session", lastSeq: 2 }),
      session("s2", { title: "Another one", lastSeq: 1 }),
    ],
    history: LONG,
    after: async (root) => {
      const el = conversationOf(root);
      await until(
        () => el.scrollHeight > el.clientHeight + 2200,
        "the conversation to have content to scroll",
      );
      // Up near the top, so that a second page is drawn, and a place that is neither the top nor the end.
      el.scrollTop = 100;
      await until(() => drawnIn(el) > 80, "earlier blocks to be drawn");
      await frames(3);
      el.scrollTop = 1500;
      await until(() => Math.abs(el.scrollTop - 1500) < 2, "the scroll to 1500");
      await frames(3);
      const where = el.scrollTop;
      const drawn = drawnIn(el);
      const title = () => root.querySelector('[data-slot="session-header"] h1')?.textContent;
      const open = (text: string) =>
        Array.from(root.querySelectorAll<HTMLElement>('[role="option"]'))
          .find((o) => o.textContent?.includes(text))
          ?.click();
      open("Another one");
      await until(
        () => title() === "Another one" && conversationOf(root) !== el,
        "the other session to open",
      );
      open("A very long session");
      await until(() => title() === "A very long session", "the long session to open again");
      const back = conversationOf(root);
      await until(
        () => back.getAttribute("aria-busy") === "false" && back !== el,
        "it to be loaded",
      );
      await frames(3);
      if (Math.abs(back.scrollTop - where) > 4)
        console.error(`long-back: was at ${where}, came back to ${back.scrollTop}`);
      if (drawnIn(back) !== drawn)
        console.error(`long-back: ${drawn} blocks were drawn, ${drawnIn(back)} after`);
    },
  },
  "turn-stopped": {
    title: "A turn that was stopped, a turn that ran out of length, a turn the agent declined",
    sessions: [session("s1", { title: "Stops" })],
    history: [
      you("u1", "Rewrite everything."),
      ...tool("a1", "Bash", "in_progress", { command: "bun test" }),
      idle({ stopReason: "cancelled" }),
      you("u2", "Explain the whole codebase."),
      say("m2", "The codebase has four layers. The first is"),
      idle({ stopReason: "max_tokens" }),
      you("u3", "Do the other thing."),
      idle({ stopReason: "refusal" }),
    ],
  },
  "thinking-shown": {
    title:
      "A session in detailed mode (Session settings): its thinking shown as italic quotes, one done, one still streaming",
    sessions: [session("s1", { title: "Think it through", state: "running" })],
    history: [
      you("u1", "Why is it slow?"),
      u({
        sessionUpdate: "agent_thought",
        messageId: "t1",
        content: [
          {
            type: "text",
            text: [
              "The log is read whole on every resume; that may be it.",
              "",
              "Resume calls `readAll`, which parses every line of the JSONL before it can find the last turn. A session",
              "with a long history has tens of thousands of lines, so that is seconds of parsing for one number.",
              "",
              "There is an index file next to the log. If it is kept up to date, resume could seek to the last",
              "turn's offset and read from there. I should check whether anything writes it, and whether it is",
              "read anywhere at all.",
              "",
              "If it is stale, the cheaper fix may be to read the log backwards until the last `turn_end`.",
              "",
              "Reading backwards needs care with a line cut in half at the end of the file, which a crash can leave.",
              "",
              "Either way, the test for resume should use a log of realistic size, or this will come back.",
            ].join("\n"),
          },
        ],
      }),
      ...tool("a1", "Read", "completed", { file_path: "packages/daemon/src/log/jsonl.ts" }),
      ...tool("a2", "Grep", "completed", { pattern: "readAll" }),
      say("m1", "It reads the whole log on every resume."),
      idle({ stopReason: "end_turn" }),
      you("u2", "And now?"),
      running(),
      u({
        sessionUpdate: "agent_thought",
        messageId: "t2",
        content: [{ type: "text", text: "Checking whether the index is used at all." }],
      }),
    ],
    after: async () => {
      displayMode.set("local:s1", "detailed");
    },
  },
  code: {
    title: "Code blocks in five languages (syntax colours, light and dark)",
    sessions: [session("s1", { title: "Colour the code" })],
    history: [you("u1", "Show it."), say("a1", CODE), idle({ stopReason: "end_turn" })],
  },
  markdown: {
    title:
      "A long answer read again: headings, nested lists, a task list, a quote, a wide table, a long code block in part, links",
    sessions: [session("s1", { title: "Fix the reconnect" })],
    history: [
      you("u1", "What did you change?"),
      say("a1", READING),
      idle({ stopReason: "end_turn" }),
    ],
    after: async (root) => {
      // Colours arrive after the first layout; the conversation still opens at its end.
      await until(
        () => root.querySelector('[data-streamdown="code-block-body"] span[style]') !== null,
        "colours",
      );
      await frames(4);
      const c = conversationOf(root);
      const gap = c.scrollHeight - c.scrollTop - c.clientHeight;
      if (gap > 2) throw new Error(`gallery: the conversation opened ${gap}px above its end`);
    },
  },
  "markdown-top": {
    title: "The same answer, read from its top",
    sessions: [session("s1", { title: "Fix the reconnect" })],
    history: [
      you("u1", "What did you change?"),
      say("a1", READING),
      idle({ stopReason: "end_turn" }),
    ],
    after: async (root) => {
      conversationOf(root).scrollTop = 0;
      await frames(3);
    },
  },
  "markdown-expand": {
    title:
      "A long block shown whole at the end of a conversation: all of it, no scroll inside it, the view stays",
    sessions: [session("s1", { title: "Fix the reconnect" })],
    history: [
      you("u1", "What did you change?"),
      say("a1", READING),
      idle({ stopReason: "end_turn" }),
    ],
    after: async (root) => {
      await until(
        () => root.querySelector('[data-streamdown="code-block-body"] span[style]') !== null,
        "colours",
      );
      await frames(4);
      const c = conversationOf(root);
      const toggle = root.querySelector<HTMLElement>('[data-slot="code-fold-toggle"]');
      if (toggle === null) throw new Error("gallery: no folded block");
      const top = c.scrollTop;
      toggle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      toggle.click();
      await frames(6);
      const body = toggle.parentElement?.querySelector<HTMLElement>(
        '[data-streamdown="code-block-body"]',
      );
      const problems: string[] = [];
      if (body !== undefined && body !== null && body.scrollHeight > body.clientHeight + 1)
        problems.push(
          `the block scrolls inside itself (${body.clientHeight} of ${body.scrollHeight}px)`,
        );
      if (Math.abs(c.scrollTop - top) > 2) problems.push(`the view moved ${c.scrollTop - top}px`);
      if (problems.length > 0) throw new Error(`gallery: ${problems.join("; ")}`);
    },
  },
  "markdown-link": {
    title: "A link in a message asks before it opens: the whole address, its words aside",
    sessions: [session("s1", { title: "Fix the reconnect" })],
    history: [
      you("u1", "Where is it documented?"),
      say(
        "a1",
        "In [the protocol](https://example.com/docs/protocol/reconnect?section=backoff&version=0.3.11#retry), under backoff.",
      ),
      idle({ stopReason: "end_turn" }),
    ],
    after: async (root) => {
      const link = root.querySelector<HTMLElement>('[data-slot="message"] a');
      if (link === null) throw new Error("gallery: no link in the message");
      link.click();
      await until(() => document.querySelector('[role="alertdialog"]') !== null, "the question");
      await frames(4);
    },
  },
  "markdown-stream": {
    title:
      "The answer written on screen, batch by batch: the view follows the end, no block is drawn again, colours never drop",
    sessions: [session("s1", { state: "running", title: "Fix the reconnect" })],
    history: [you("u1", "What did you change?"), running()],
    after: async (root, emit) => {
      const c = conversationOf(root);
      const BATCH = 40;
      let version = 2;
      let block: Element | null = null;
      let coloured = 0;
      const problems: string[] = [];
      const send = (update: SessionUpdate) =>
        emit({
          type: "update",
          environmentId: "local",
          sessionId: "s1",
          update,
          version: ++version,
        });
      for (let at = 0; at < READING.length; at += BATCH) {
        send(
          u({
            sessionUpdate: "agent_message_chunk",
            messageId: "a1",
            content: { type: "text", text: READING.slice(at, at + BATCH) },
          }),
        );
        await frames(2);
        const gap = c.scrollHeight - c.scrollTop - c.clientHeight;
        if (gap > 48) problems.push(`${gap}px from the end at ${at}`);
        if (block !== null && !block.isConnected)
          problems.push(`a code block was drawn again at ${at}`);
        const last = Array.from(root.querySelectorAll('[data-streamdown="code-block"]')).at(-1);
        if (last !== undefined && last !== block) {
          block = last;
          coloured = 0;
        }
        const spans =
          block?.querySelectorAll('[data-streamdown="code-block-body"] span[style]').length ?? 0;
        if (spans < coloured) problems.push(`colours dropped at ${at}`);
        coloured = spans;
      }
      const held = block;
      send(idle({ stopReason: "end_turn" }));
      await frames(6);
      if (held !== null && !held.isConnected)
        problems.push("the code block was drawn again when the turn ended");
      if (root.querySelector("[data-folded]") !== null)
        problems.push("a block written on screen was folded");
      if (problems.length > 0) throw new Error(`gallery: ${problems.slice(0, 5).join("; ")}`);
    },
  },
  "markdown-streaming": {
    title: "The same answer while it streams, cut inside its code block",
    sessions: [session("s1", { state: "running", title: "Fix the reconnect" })],
    history: [
      you("u1", "What did you change?"),
      running(),
      u({
        sessionUpdate: "agent_message_chunk",
        messageId: "a1",
        content: { type: "text", text: READING_STREAMING },
      }),
    ],
  },
  // The same code in each of the five colour choices.
  ...Object.fromEntries(
    (["github", "github-high-contrast", "vscode", "one", "catppuccin"] as CodeThemeId[]).map(
      (id) => [
        `code-${id}`,
        {
          title: `Code colours: ${id}`,
          sessions: [session("s1", { title: "Colour the code" })],
          history: [you("u1", "Show it."), say("a1", CODE), idle({ stopReason: "end_turn" })],
          after: async () => {
            codeTheme.set(id);
            // The highlighter loads a language when a block first needs it.
            await new Promise((r) => setTimeout(r, 2500));
          },
        } satisfies Scenario,
      ],
    ),
  ),
  "image-open-set": {
    title:
      "A picture you sent opened large (CYCL-212): the whole window on a dark scrim, Copy, Download and Close at the top right, the zoom at the bottom, steps to the other picture of the message",
    sessions: [session("s1", { title: "Look at the mock" })],
    history: [
      u({
        sessionUpdate: "user_message",
        messageId: "u1",
        content: [
          { type: "text", text: "Does this match the design?" },
          { type: "image", data: SAMPLE_PNG, mimeType: "image/png", uri: "file:///mock.png" },
          { type: "image", data: SAMPLE_PNG, mimeType: "image/png", uri: "file:///design.png" },
        ],
      }),
      idle({ stopReason: "end_turn" }),
    ],
    after: async (root) => {
      const thumbnail = root.querySelector<HTMLElement>('[data-slot="image"]');
      thumbnail?.click();
      await until(
        () => document.querySelector('[data-slot="lightbox-image"][data-shown]') !== null,
        "the picture to be shown large",
      );
      await frames(12);
    },
  },
  images: {
    title:
      "Images in a conversation: one you sent, one the agent sent between two paragraphs, one that cannot be shown",
    sessions: [session("s1", { title: "Look at the mock" })],
    history: [
      u({
        sessionUpdate: "user_message",
        messageId: "u1",
        content: [
          { type: "text", text: "Does this match the design?" },
          {
            type: "image",
            data: SAMPLE_PNG,
            mimeType: "image/png",
            uri: "file:///Users/dev/mock.png",
          },
        ],
      }),
      u({
        sessionUpdate: "agent_message",
        messageId: "a1",
        content: [
          { type: "text", text: "Close. The colours match; the sun sits lower in the design:" },
          { type: "image", data: SAMPLE_PNG, mimeType: "image/png" },
          { type: "text", text: "And one more, which I could not render as a picture." },
          { type: "image", data: "PHN2Zz48L3N2Zz4=", mimeType: "image/svg+xml" },
        ],
      }),
      idle({ stopReason: "end_turn" }),
    ],
  },
  review: {
    title:
      "A code review the agent reported, in its order: a long one cut, one outside the folder, one with no verdict",
    status: [
      {
        environmentId: "local",
        state: "connected",
        capabilities: { queue: true, files: true, folders: true, fs: true },
      },
    ],
    sessions: [session("s1", { title: "Review the composer change" })],
    history: [
      you("u1", "/code-review high"),
      running(),
      ...tool("r1", "Bash", "completed", {
        command: "git diff main",
        description: "Read the diff",
      }),
      ...tool("r2", "ReportFindings", "completed", {
        level: "high",
        findings: [
          {
            file: "packages/ui/src/react/markdown-input.tsx",
            line: 182,
            summary:
              "Shift+Enter in a code block inside a list item makes a new item instead of a line.",
            short_summary: "Shift+Enter in a listed code block splits the list",
            failure_scenario:
              "Type `1. a`, then a fenced code block in the item, then Shift+Enter: the code block is cut and a new item starts.",
            category: "correctness",
            verdict: "PLAUSIBLE",
          },
          {
            file: "packages/ui/src/styles/app.css",
            line: 2598,
            summary:
              "The thumbnail grid's width is computed from the column, so in a very narrow side panel each square shrinks below a size anyone can see, and a long run of pictures becomes a wall of slivers that cannot be told apart or aimed at with a pointer; this sentence goes on to show how a long finding is cut on its row and shown whole when the row is opened.",
            failure_scenario:
              "Open a session in a 320px panel and send nine pictures: each square is about 70px.",
            category: "ux",
            verdict: "CONFIRMED",
          },
          {
            file: "/etc/hosts",
            summary: "A path outside the folder is shown, but not as a link.",
            failure_scenario: "The agent names a file it cannot open in Files.",
          },
          {
            file: "packages/ui/src/model/review.ts",
            line: 88,
            summary: "Findings are sorted twice.",
            failure_scenario: "Every redraw of the turn sorts the list again.",
            category: "efficiency",
            verdict: "CONFIRMED",
          },
        ],
      }),
      say("a1", "Two confirmed, one plausible. The narrow-panel grid is the one to fix first."),
      idle({ stopReason: "end_turn" }),
    ],
  },
  "review-none": {
    title: "A code review that found nothing says so",
    sessions: [session("s1", { title: "Review the composer change" })],
    history: [
      you("u1", "/code-review"),
      running(),
      ...tool("r1", "ReportFindings", "completed", { level: "medium", findings: [] }),
      say("a1", "Nothing to fix."),
      idle({ stopReason: "end_turn" }),
    ],
  },
  "review-fixed": {
    title: "A code review reported again after fixing: what became of each finding",
    sessions: [session("s1", { title: "Review the composer change" })],
    history: [
      you("u1", "/code-review --fix"),
      running(),
      ...tool("r1", "ReportFindings", "completed", {
        findings: [
          {
            file: "packages/ui/src/react/review.tsx",
            line: 40,
            summary: "The tally counts fixed findings twice.",
            failure_scenario: "Report three findings, two fixed: the line says five.",
            verdict: "CONFIRMED",
            outcome: "fixed",
          },
          {
            file: "packages/ui/src/react/review.tsx",
            line: 72,
            summary: "The tag's edge is the only thing that differs between verdicts.",
            failure_scenario: "In high contrast the words still differ, so nothing to do.",
            verdict: "PLAUSIBLE",
            outcome: "no_change_needed",
          },
          {
            file: "packages/ui/src/model/blocks.ts",
            summary: "A review cuts the stretch of calls around it.",
            failure_scenario: "Two calls, a review, two calls: two cards around the review.",
            verdict: "PLAUSIBLE",
            outcome: "skipped",
          },
        ],
      }),
      idle({ stopReason: "end_turn" }),
    ],
  },
  "review-skill": {
    title:
      "A code review from the /code-review skill: its result's findings on the card, what it said around them above",
    status: [
      {
        environmentId: "local",
        state: "connected",
        capabilities: { queue: true, files: true, folders: true, fs: true },
      },
    ],
    sessions: [session("s1", { title: "Review the composer change" })],
    history: [
      you("u1", "/code-review high"),
      running(),
      ...done(
        "r1",
        "Skill",
        { skill: "code-review", args: "high origin/main...HEAD" },
        {
          content: text(
            [
              'Skill "code-review" completed (forked execution).',
              "",
              "Result:",
              "Reviewed `origin/main...HEAD`: the composer's paste path and the thumbnail grid. Two findings.",
              "",
              "```json",
              JSON.stringify(
                [
                  {
                    file: "packages/ui/src/react/markdown-input.tsx",
                    line: 182,
                    summary:
                      "Pasting a picture while a mention is open drops the mention's text instead of keeping it.",
                    failure_scenario:
                      "Type `@ma`, then paste an image before picking: the `@ma` is gone from the box.",
                  },
                  {
                    file: "packages/ui/src/styles/app.css",
                    line: 2598,
                    summary: "The thumbnail grid has no minimum size in a narrow side panel.",
                    failure_scenario:
                      "Open a session in a 320px panel and send nine pictures: each square is about 70px.",
                  },
                ],
                null,
                2,
              ),
              "```",
            ].join("\n"),
          ),
        },
      ),
      say("a1", "The paste one is the one to fix first."),
      idle({ stopReason: "end_turn" }),
    ],
  },
  "review-skill-plain": {
    title: "A /code-review skill whose result has no findings block is shown as its call",
    sessions: [session("s1", { title: "Review the release" })],
    history: [
      you("u1", "/code-review"),
      running(),
      ...done(
        "r1",
        "Skill",
        { skill: "code-review" },
        {
          content: text(
            'Skill "code-review" completed (forked execution).\n\nResult:\n(none)\n\nOnly the version changed.',
          ),
        },
      ),
      idle({ stopReason: "end_turn" }),
    ],
  },
  "images-many": {
    title:
      "A message with eight pictures, one that cannot be shown and a file: thumbnails above the words, then the file",
    sessions: [session("s1", { title: "Look at the mocks" })],
    history: [
      u({
        sessionUpdate: "user_message",
        messageId: "u1",
        content: [
          { type: "text", text: "Here are the screens.\n1. The composer\n2. The sidebar" },
          ...Array.from({ length: 8 }, () => ({
            type: "image",
            data: SAMPLE_PNG,
            mimeType: "image/png",
          })),
          { type: "image", data: "PHN2Zz48L3N2Zz4=", mimeType: "image/svg+xml" },
          {
            type: "resource",
            resource: {
              uri: "file:///Users/dev/notes.md",
              mimeType: "text/markdown",
              text: "# Notes",
            },
          },
        ],
      }),
      u({
        sessionUpdate: "user_message",
        messageId: "u2",
        content: [{ type: "image", data: SAMPLE_PNG, mimeType: "image/png" }],
      }),
      say("a1", "Got them. The composer's plus sits closer to its edge than to the text."),
      idle({ stopReason: "end_turn" }),
    ],
  },
  attach: {
    title: "Images attached to a message (two pictures and one the agent cannot take)",
    attach: true,
    sessions: [session("s1", { title: "Look at the mock" })],
    history: [
      you("u1", "Here is the design."),
      say("a1", "Got it. Send me the screenshot."),
      idle({ stopReason: "end_turn" }),
    ],
    after: async () => {
      const bytes = Uint8Array.from(atob(SAMPLE_PNG), (c) => c.charCodeAt(0));
      const files = new DataTransfer();
      files.items.add(new File([bytes], "mock.png", { type: "image/png" }));
      files.items.add(
        new File([bytes], "a-rather-long-screenshot-name-2026-11-18.png", { type: "image/png" }),
      );
      files.items.add(new File(["x"], "notes.bmp", { type: "image/bmp" }));
      const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      if (input === null) throw new Error("no file input");
      input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 600));
    },
  },
  "image-open": {
    title: "An image opened large",
    sessions: [session("s1", { title: "Look at the mock" })],
    history: [
      u({
        sessionUpdate: "agent_message",
        messageId: "a1",
        content: [{ type: "image", data: SAMPLE_PNG, mimeType: "image/png" }],
      }),
      idle({ stopReason: "end_turn" }),
    ],
    after: async () => {
      (document.querySelector('[data-slot="image"]') as HTMLElement | null)?.click();
      await new Promise((r) => setTimeout(r, 400));
    },
  },
  "empty-conversation": {
    title: "A session with nothing said yet",
    sessions: [session("s1")],
    history: [],
  },
  streaming: {
    title: "The agent is working: the answer is half written",
    sessions: [session("s1", { state: "running", title: "Fix the remote session" })],
    history: [
      you("u1", "Explain the retry logic."),
      running(),
      u({
        sessionUpdate: "agent_message_chunk",
        messageId: "a1",
        content: {
          type: "text",
          text: "The client waits 250 ms, then doubles the wait up to 5 s. Each attempt asks the daemon for what",
        },
      }),
    ],
  },
  permission: {
    title: "The agent waits for a decision (a long command)",
    sessions: [session("s1", { state: "requires_action", title: "Clean the build" })],
    history: [you("u1", "Clean the build."), running()],
    permissions: [
      permission("Allow Bash?", `rm -rf ${LONG_PATH} && find . -name '*.tmp' -delete && echo done`),
    ],
  },
  subagents: {
    title: "Sub-agents as cards of their own: one at work, one back with the start of its answer",
    sessions: [session("s1", { state: "running", title: "Find the flaky test" })],
    history: [
      you("u1", "Find out why CI is flaky and check the cache settings."),
      running(),
      say("m1", "I'll send two sub-agents: one for the flaky test, one for the cache."),
      ...done(
        "a1",
        "Agent",
        {
          description: "Find the flaky test",
          subagent_type: "Explore",
          prompt: "Find which test in apps/daemon fails now and then, and why.",
        },
        {
          content: text(
            "**`queue.test.ts` › hands back in order** is flaky. It sleeps 50 ms instead of waiting for the queue to drain, so on a slow runner the second item is not there yet.\n\nFix: await `queue.idle()` before the assertion. Nothing else in the suite sleeps.",
          ),
        },
      ),
      u({
        sessionUpdate: "subagent_update",
        sessionId: "task-1",
        state: { state: "idle", stopReason: "end_turn" },
        _meta: {
          "cycle/subagent": {
            toolCallId: "a1",
            usage: { tokens: 18200, toolUses: 9, durationMs: 41000 },
          },
        },
      }),
      ...tool("a2", "Agent", "in_progress", {
        description: "Check the cache settings",
        subagent_type: "general-purpose",
        prompt: "Check whether CI caches node_modules between runs.",
      }),
      u({
        sessionUpdate: "subagent_update",
        sessionId: "task-2",
        state: { state: "running" },
        _meta: { "cycle/subagent": { toolCallId: "a2", background: false, lastTool: "Read" } },
      }),
    ],
  },
  "permission-edit": {
    title: "An edit waits for a decision: the change it would make is shown before it is answered",
    sessions: [session("s1", { state: "requires_action", title: "Move the port to config" })],
    history: [you("u1", "Read the port from config."), running()],
    permissions: [
      {
        ...permission("Allow Edit?", ""),
        subject: {
          type: "tool_call",
          toolCall: {
            name: "Edit",
            rawInput: {
              file_path: `${LONG_PATH}/server.ts`,
              old_string: [
                'import { serve } from "bun";',
                "",
                "const port = 3000;",
                "serve({ port, fetch: handle });",
              ].join("\n"),
              new_string: [
                'import { serve } from "bun";',
                'import { config } from "./config.ts";',
                "",
                "const port = config.port ?? 3000;",
                "serve({ port, fetch: handle });",
              ].join("\n"),
            },
          },
        },
      },
      { ...permission("Allow Bash?", "bun test"), key: "local:s1:p2" },
    ],
  },
  "permission-queue": {
    title: "Several permissions wait without pushing the composer out of the window",
    sessions: [session("s1", { state: "requires_action", title: "Check the build" })],
    history: [you("u1", "Check the build and compare the logs."), running()],
    permissions: [
      permission("Read the build log?", `cat ${LONG_PATH}`),
      { ...permission("Compare the logs?", "diff build.log reference.log"), key: "local:s1:p2" },
    ],
  },
  "turn-error": {
    title: "A turn that ended in an error",
    sessions: [session("s1")],
    history: [
      you("u1", "Run it."),
      running(),
      idle({ stopReason: "error", error: { code: -32012, message: "The agent exited" } }),
    ],
  },
  "turn-error-changed": {
    title:
      "A turn that failed after running a command: Send again asks first, as the message may do it again",
    sessions: [session("s1")],
    history: [
      you("u1", "Bump the version and publish the package."),
      running(),
      ...done("b1", "Bash", { command: "npm version patch" }, { content: text("v1.4.3") }),
      u({ sessionUpdate: "tool_call_update", toolCallId: "b1", kind: "execute" }),
      idle({
        stopReason: "error",
        error: { message: "API Error: 529 Overloaded. The service is busy; try again later." },
      }),
    ],
    after: async (root) => {
      const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === "Send again",
      );
      button?.click();
      await until(() => document.querySelector('[role="alertdialog"]') !== null, "the dialog");
      await frames(4);
    },
  },
  "turn-error-resent": {
    title: "Send again: the message is back in the input box, to read and send",
    sessions: [session("s1")],
    history: [
      you("u1", "Summarise the open issues by label."),
      running(),
      idle({
        stopReason: "error",
        error: { code: -32018, message: "Cycle was stopped while this turn was running" },
      }),
    ],
    after: async (root) => {
      [...root.querySelectorAll<HTMLButtonElement>("button")]
        .find((b) => b.textContent === "Send again")
        ?.click();
      await frames(4);
    },
  },
  "turn-retrying": {
    title: "The agent's request failed and it is trying again by itself: a state, not a row",
    sessions: [session("s1", { state: "running" })],
    history: [
      you("u1", "Explain the queue hand-off."),
      running(),
      u({
        sessionUpdate: "notice",
        severity: "info",
        title: "Retrying the request (attempt 2 of 10)",
        _meta: { "cycle/retry": { attempt: 2, maxRetries: 10, delayMs: 1200, status: 529 } },
      }),
    ],
  },
  // CYCL-50: the samples the tests compare live, replayed and after a reconnect (packages/ui/test/samples.ts).
  parallel: {
    title:
      "Calls made together, results back out of order: one card in call order; counts only where whose is known",
    sessions: [session("s1")],
    history: turnOf("u1", PARALLEL_PROMPT, PARALLEL),
    after: async (root) => {
      root.querySelector<HTMLElement>('[data-kind="work"] > button')?.click();
      (document.activeElement as HTMLElement | null)?.blur();
      await frames(4);
    },
  },
  reconnected: {
    title:
      "Back after a dropped connection mid-turn: what was missed is drawn once, the open permission and form once",
    sessions: [session("s1", { state: "requires_action", title: "Run the tests" })],
    history: [
      you("u1", RECONNECT_PROMPT),
      running(),
      ...BEFORE_DROP,
      ...WHILE_AWAY,
      u({ sessionUpdate: "state_update", state: "requires_action" }),
    ],
    permissions: [
      { ...permission("Allow it?", "bun test"), key: "local:s1:r1" },
      {
        key: "local:s1:r2",
        environmentId: "local",
        sessionId: "s1",
        title: "Which one?",
        options: [],
        form: {
          message: "Which one?",
          schema: { type: "object", properties: { pick: { type: "string" } } },
        },
      },
    ],
  },
  "history-0.3.4": {
    title:
      "A history written before 0.3.5, replayed: plain rows, no counts or diffs, TaskCreate shown as then",
    sessions: [session("s1", { title: "Add a --verbose flag" })],
    history: OLD_UPDATES_SENT,
    after: async (root) => {
      for (const button of root.querySelectorAll<HTMLElement>('[data-kind="work"] > button'))
        button.click();
      (document.activeElement as HTMLElement | null)?.blur();
      await frames(4);
    },
  },
  "host-down": {
    title: "The remote host cannot be reached (its own words shown)",
    environments: [BUILD, LOCAL],
    status: [
      {
        environmentId: "build",
        state: "closed",
        error: "ssh: connect to host build-1 port 22: Connection refused",
      },
      UP("local"),
    ],
    sessions: [],
  },
  "host-reconnecting": {
    title: "The connection dropped and is being retried",
    environments: [LOCAL],
    status: [{ environmentId: "local", state: "reconnecting" }],
    sessions: [session("s1", { title: "Fix the remote session" })],
  },
  "session-reconnecting": {
    title: "An open session can still take a draft during reconnection",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
    after: async (_root, emit) => {
      emit({ type: "environment-status", environmentId: "local", state: "reconnecting" });
    },
  },
  "notice-error": {
    title: "What was just done failed: a red line under the title bar, its own words, and Dismiss",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
    fails: "The session is working on a turn. Wait for it to end, or stop it, then send again.",
  },
  "notice-away": {
    title:
      "The open session's environment went away: an amber line under the title bar, and Connect again",
    environments: [BUILD],
    status: [UP("build")],
    sessions: [session("s1", { environmentId: "build", title: "Fix the remote session" })],
    history: conversation,
    after: async (_root, emit) => {
      emit({
        type: "environment-status",
        environmentId: "build",
        state: "closed",
        error: "ssh: connect to host build-1 port 22: Connection refused",
      });
    },
  },
  "notice-both": {
    title:
      "A failure while the connection is being retried: two lines, the failure first; a long one stays on one line and fades out at its end",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
    fails:
      "session/prompt failed: the daemon closed the stream before it answered (ECONNRESET at /home/dev/.cycle/daemon/sock/7f3a9c1e-4b2d-4e8a-9f61-0c5d2b7a8e44.sock, after 30012 ms), so the message was kept in the box and not sent",
    after: async (_root, emit) => {
      emit({ type: "environment-status", environmentId: "local", state: "reconnecting" });
    },
  },
  "session-groups": {
    title:
      "The session list: what needs you, what is working, then projects (one with more than a page, two with the same last folder name)",
    sessions: [
      session("ask", { title: "Approve the deploy", state: "requires_action", lastSeq: 90 }),
      session("run1", {
        title: "Index the logs",
        state: "running",
        cwd: "/home/dev/docs-site",
        lastSeq: 80,
      }),
      session("run2", { title: "Port the tests", state: "running", lastSeq: 70 }),
      ...Array.from({ length: 24 }, (_, n) =>
        session(`c${n}`, { title: `Cycle task ${n + 1}`, lastSeq: 24 - n }),
      ),
      session("d1", { title: "Fix the sidebar", cwd: "/home/dev/docs-site", lastSeq: 30 }),
      session("d2", { title: "Write the guide", cwd: "/home/dev/docs-site", lastSeq: 29 }),
      session("a1", { title: "Another app", cwd: "/home/other/app", lastSeq: 40 }),
      session("a2", { title: "The app", cwd: "/home/dev/app", lastSeq: 35 }),
      session("old", { title: "Archived thing", archived: true, lastSeq: 2 }),
    ],
    history: [you("u1", "Where were we?"), say("a1", "Here.")],
  },
  "session-times": {
    title:
      "Each row ends with when its session last changed; a long title fades before the time, which never gives way",
    sessions: [
      session("ask", {
        title: "Approve the deploy",
        state: "requires_action",
        lastSeq: 90,
        updatedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      }),
      session("run", {
        title: "Port the tests",
        state: "running",
        lastSeq: 80,
        updatedAt: new Date(Date.now() - 30_000).toISOString(),
      }),
      session("t1", {
        title: "Make the sidebar's rows line up with the traffic lights and the actions above",
        lastSeq: 70,
        updatedAt: new Date(Date.now() - 25 * 60_000).toISOString(),
      }),
      session("t2", {
        title: "Fix the flaky daemon test",
        lastSeq: 60,
        updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      }),
      session("y1", {
        title: "Write the guide",
        lastSeq: 50,
        updatedAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
      }),
      session("e1", {
        title: "Index the logs",
        lastSeq: 40,
        updatedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      }),
      session("e2", {
        title: "Tidy the docs",
        lastSeq: 30,
        updatedAt: "2026-09-03T10:00:00.000Z",
      }),
    ],
    history: [you("u1", "Where were we?"), say("a1", "Here.")],
  },
  "session-focus": {
    title: "A row that starts working moves to the Working group and keeps the keyboard focus",
    sessions: [
      session("one", { title: "First", lastSeq: 1 }),
      session("two", { title: "Second", lastSeq: 2 }),
    ],
    history: [you("u1", "Hello"), say("a1", "Hi.")],
    after: async (root, emit) => {
      const option = (id: string) => root.querySelector<HTMLElement>(`[data-session="${id}"]`);
      const first = option("one");
      if (first === null) throw new Error("gallery: no row for the first session");
      first.focus();
      if (document.activeElement !== first)
        throw new Error("gallery: the row did not take the focus");
      emit({
        type: "sessions",
        environmentId: "local",
        sessions: [
          session("one", { title: "First", lastSeq: 3, state: "running" }),
          session("two", { title: "Second", lastSeq: 2 }),
        ],
      });
      await until(
        () => option("one")?.closest('[data-kind="running"]') !== null,
        "the row to move to Working",
      );
      await frames(3);
      if (document.activeElement !== option("one"))
        console.error("session-focus: the row moved and the keyboard focus was lost");
    },
  },
  "two-agents": {
    title:
      "Two agents on the environment: each session says which it is of, in the list and in its header",
    secondAgent: true,
    sessions: [
      session("s1", { title: "Fix the remote session", agent: "codex" }),
      session("s2", { title: "Speed up the build", state: "running" }),
      session("s3", {
        title: "A title that goes on and on and on, well past the width a row of the sidebar has",
        agent: "codex",
      }),
      session("s4", { title: "Made with an agent that is gone", agent: "old-agent" }),
    ],
    history: conversation,
  },
  "many-sessions": {
    title: "800 sessions, long titles, every state",
    sessions: Array.from({ length: 800 }, (_, i) =>
      session(`s${i}`, {
        title:
          i % 5 === 0
            ? `${"A title that goes on and on and on, "}${i}`
            : i % 7 === 0
              ? undefined
              : `Session ${i}`,
        cwd: i % 3 === 0 ? LONG_PATH : "/home/dev/cycle-v1",
        state: (["idle", "running", "requires_action", "stopped"] as const)[i % 4] ?? "idle",
        archived: i % 11 === 0,
        lastSeq: 1000 - i,
      }),
    ),
    history: conversation,
  },
  "sign-in": {
    title: "Nobody is signed in: the sign-in page",
    account: { state: "signed-out", open: false, signingIn: false },
  },
  "sign-in-waiting": {
    title: "The sign-in page, waiting for the browser",
    account: { state: "signed-out", open: false, signingIn: true },
  },
  "sign-in-expired": {
    title: "The sign-in page after 30 days without the sign-in service",
    account: { state: "signed-out", open: false, signingIn: false, reason: "expired" },
  },
  "sign-in-failed": {
    title: "The sign-in page after a sign-in that could not reach the service",
    account: { state: "signed-out", open: false, signingIn: false, problem: "unreachable" },
  },
  "sign-in-zh": {
    title: "The sign-in page in Chinese",
    language: "zh-CN",
    account: { state: "signed-out", open: false, signingIn: false, reason: "revoked" },
  },
  "account-offline": {
    title: "Offline within the grace: online features wait",
    sessions: [session("s1")],
    account: {
      state: "offline",
      open: true,
      signingIn: false,
      user: { name: "Ada Lovelace", email: "ada@example.com" },
    },
  },
  "account-reauth": {
    title: "The login was refused while the app was open",
    sessions: [session("s1")],
    account: {
      state: "reauth",
      open: true,
      signingIn: false,
      user: { name: "Ada Lovelace", email: "ada@example.com" },
    },
  },
  "notices-collapsed": {
    title: "With the sidebar folded away, what concerns the whole app is at the top of the page",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
    update: { current: "0.1.0", kind: "available", version: "0.1.1" },
    after: async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", metaKey: true, ctrlKey: true }),
      );
      await new Promise((r) => setTimeout(r, 300));
    },
  },
  "update-available": {
    title: "An update is available",
    sessions: [session("s1")],
    update: { current: "0.1.0", kind: "available", version: "0.1.1" },
  },
  "update-failed": {
    title: "An install failed",
    sessions: [session("s1")],
    update: {
      current: "0.1.0",
      kind: "error",
      message: "The update could not be unpacked: no space left on device",
      version: "0.1.1",
    },
  },
  "daemon-old": {
    title: "The remote daemon is older than the app",
    environments: [BUILD, LOCAL],
    status: [
      {
        environmentId: "build",
        state: "connected",
        daemon: {
          version: "0.1.0",
          upgrade: {
            to: "0.1.1",
            command: "cycle stop; curl -fsSL https://example.invalid/install.sh | sh",
          },
        },
      },
      UP("local"),
    ],
    sessions: [],
  },
  "daemon-incompatible": {
    title: "The remote daemon speaks an incompatible protocol major version",
    environments: [BUILD, LOCAL],
    status: [
      {
        environmentId: "build",
        state: "reconnecting",
        incompatible: {
          with: "daemon",
          supported: ["0.2"],
          requested: "1.0",
          command: "cycle stop; curl -fsSL https://example.invalid/install.sh | sh",
        },
      },
      UP("local"),
    ],
    sessions: [],
  },
  "menu-session": {
    title: "The session's menu is open",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
    after: async (root) => {
      await clickByLabel(root, "Session actions");
      await new Promise((r) => setTimeout(r, 200));
    },
  },
  // The right panel beside the conversation (CYCL-66): at 1200 the conversation gives way, at 720 the sidebar folds.
  "panel-open": {
    title: "The right panel is open on the Overview beside the conversation",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: [
      ...conversation,
      // What the Overview shows besides (CYCL-88): a goal, a background command that runs on, one that ended.
      u({
        sessionUpdate: "_cycle/goal_update",
        goal: {
          condition: "The remote session reconnects after the laptop sleeps, and every test passes",
          iterations: 2,
          setAt: Date.UTC(2026, 10, 22, 9, 30),
          lastReason: "The reconnect test still times out on the second attempt",
        },
      }),
      u({
        sessionUpdate: "_cycle/task_update",
        taskId: "b1",
        kind: "shell",
        title: "Run the daemon with verbose logging",
        state: "running",
      }),
      u({
        sessionUpdate: "_cycle/task_update",
        taskId: "m1",
        kind: "monitor",
        title: "Watch the daemon log for reconnects",
        state: "unknown",
      }),
      u({
        sessionUpdate: "_cycle/task_update",
        taskId: "b0",
        kind: "shell",
        title: "bun test",
        state: "failed",
      }),
      // What is set to wake it (CYCL-146): a wakeup it set itself, a loop, and one saved in the project.
      u({
        sessionUpdate: "_cycle/schedule_update",
        jobs: [
          {
            id: "w1",
            kind: "wakeup",
            schedule: "50 10 * * *",
            recurring: false,
            durable: false,
            prompt: "Check whether the reconnect test passes after the retry change",
            nextFireAt: Date.UTC(2026, 10, 22, 10, 50),
          },
          {
            id: "c1",
            kind: "cron",
            schedule: "*/30 * * * *",
            humanSchedule: "Every 30 minutes",
            recurring: true,
            durable: false,
            prompt: "Look at the daemon log and say whether it reconnected since the last check",
            nextFireAt: Date.UTC(2026, 10, 22, 11, 0),
          },
          {
            id: "d1",
            kind: "cron",
            schedule: "0 9 * * 1-5",
            humanSchedule: "Weekdays at 9 AM",
            recurring: true,
            durable: true,
            prompt: "Summarise yesterday's failing tests",
          },
        ],
      }),
    ],
    sidePanel: true,
  },
  // To try the right panel by hand (CYCL-90, CYCL-88): two sessions with their own panels, and an Overview that changes
  // while it is watched. Nothing is opened for you; the news below arrives over the first half minute.
  "panel-tryout": {
    title: "Try the right panel: two sessions, an Overview whose goal and background change live",
    sessions: [
      session("s1", { title: "Fix the remote session" }),
      session("s2", { title: "Say hello" }),
    ],
    history: tryout,
    histories: { s1: tryout, s2: hello },
    after: async (_root, emit) => {
      let version = tryout.length;
      const news = (update: SessionUpdate) =>
        emit({
          type: "update",
          environmentId: "local",
          sessionId: "s1",
          update,
          version: ++version,
        });
      const at = (seconds: number, update: SessionUpdate) =>
        setTimeout(() => news(update), seconds * 1000);
      at(
        5,
        u({
          sessionUpdate: "_cycle/goal_update",
          goal: { ...tryoutGoal, iterations: 1, lastReason: "Two reconnect tests still fail" },
        }),
      );
      at(
        10,
        u({
          sessionUpdate: "_cycle/task_update",
          taskId: "w1",
          kind: "workflow",
          title: "Review the daemon changes",
          state: "running",
        }),
      );
      at(15, u({ sessionUpdate: "_cycle/task_update", taskId: "b1", state: "completed" }));
      at(20, u({ sessionUpdate: "_cycle/task_update", taskId: "w1", state: "failed" }));
      at(25, u({ sessionUpdate: "_cycle/goal_update", goal: null }));
    },
  },
  "panel-empty": {
    title: "The Overview of a session that has nothing besides its messages",
    sessions: [session("s1", { title: "Say hello" })],
    history: [
      u({
        sessionUpdate: "user_message",
        messageId: "u1",
        content: [{ type: "text", text: "Say hello" }],
      }),
      u({
        sessionUpdate: "agent_message_chunk",
        messageId: "a1",
        content: { type: "text", text: "Hello." },
      }),
      u({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }),
    ],
    sidePanel: true,
  },
  // The composer's pickers are menus like every other (CYCL-65): opened, on the session's choice.
  ...Object.fromEntries(
    (["mode", "model"] as const).map((setting) => [
      `menu-${setting}`,
      {
        title: `The ${setting === "mode" ? "permission mode" : "model"} picker is open`,
        sessions: [session("s1", { title: "Fix the remote session" })],
        history: conversation,
        after: async (root: HTMLElement) => {
          const chip = `[data-kind="setting-chip"][data-setting="${setting}"]`;
          await until(() => root.querySelector(chip) !== null, "the setting chip");
          root.querySelector<HTMLElement>(chip)?.click();
          await new Promise((r) => setTimeout(r, 250));
        },
      } satisfies Scenario,
    ]),
  ),
  "menu-host": {
    title: "A remote environment's menu is open, in Settings",
    environments: [BUILD, LOCAL],
    status: [UP("build"), UP("local")],
    sessions: [],
    after: async (root) => {
      await openSettings(root, "Environments");
      await clickByLabel(root, "Actions for build-1");
      await new Promise((r) => setTimeout(r, 200));
    },
  },
  // Where keyboard focus lands after 1 to 7 Tabs, and that it shows.
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7].map((n) => [
      `focus-tab-${n}`,
      {
        title: `Keyboard focus after ${n} Tab${n > 1 ? "s" : ""}`,
        sessions: [
          session("s1", { title: "Fix the remote session" }),
          session("s2", { title: "Second" }),
        ],
        history: conversation,
        tabs: n,
      } satisfies Scenario,
    ]),
  ),
  "sidebar-collapsed": {
    title:
      "The sidebar folded away (Cmd+B); on a Mac the traffic lights sit where the title starts",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
    after: async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", metaKey: true, ctrlKey: true }),
      );
      await new Promise((r) => setTimeout(r, 300));
    },
  },
  "search-open": {
    title: "The session search, opened with nothing typed (two environments, several states)",
    environments: [LOCAL, BUILD],
    status: [UP("local"), UP("build")],
    sessions: [
      session("s1", { title: "Fix the remote session", state: "running", lastSeq: 9 }),
      session("s2", { title: "Clean the build", state: "requires_action", lastSeq: 8 }),
      session("s3", { cwd: "/home/dev/docs", agent: "claude", lastSeq: 7 }),
      session("s4", { title: "Old idea", archived: true, lastSeq: 1 }),
      session("b1", {
        environmentId: "build",
        title: "Nightly release",
        cwd: "/srv/release",
        lastSeq: 6,
      }),
    ],
    after: openSearch,
  },
  "search-typed": {
    title: "The session search with a query that matches by folder and by host",
    environments: [LOCAL, BUILD],
    status: [UP("local"), UP("build")],
    sessions: [
      session("s1", { title: "Fix the remote session", lastSeq: 9 }),
      session("b1", {
        environmentId: "build",
        title: "Nightly release",
        cwd: "/srv/release",
        lastSeq: 6,
      }),
      session("b2", {
        environmentId: "build",
        title: "Cache warm-up",
        cwd: "/srv/cache",
        lastSeq: 5,
      }),
    ],
    after: async (root) => {
      await openSearch(root);
      const input = document.querySelector(
        '[data-palette="search"] input',
      ) as HTMLInputElement | null;
      if (input === null) throw new Error("no search input");
      // As a keyboard types: through the input's own value setter, so the framework sees it.
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(input, "build");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
    },
  },
  "search-none": {
    title: "The session search with a query nothing matches",
    sessions: [session("s1", { title: "Fix the remote session" })],
    after: async (root) => {
      await openSearch(root);
      const input = document.querySelector(
        '[data-palette="search"] input',
      ) as HTMLInputElement | null;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      set?.call(input, "zzz");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
    },
  },
  "new-session": {
    title: "New session: a blank conversation, with no workspace yet",
    sessions: [],
    after: (root) => click(root, "New session"),
  },
  "new-session-workspace": {
    title: "New session in the workspace that is shown: its folder, the agent's defaults",
    sessions: [session("s1", { title: "Fix the remote session" })],
    attach: true,
    blank: { cwd: "/Users/me/work/app" },
  },
  "new-session-folders": {
    title: "New session: the folder's menu, with the folders this environment has sessions in",
    sessions: [
      session("s1", { title: "Fix the remote session", cwd: "/Users/me/work/app" }),
      session("s2", {
        title: "Tidy the docs",
        cwd: "/Users/me/work/clients/northwind/a-very-long-repository-name-for-the-billing-service",
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
      session("s3", {
        title: "Notes",
        cwd: "/Users/me/notes",
        updatedAt: "2019-12-01T00:00:00.000Z",
      }),
    ],
    blank: { cwd: "/Users/me/work/app" },
    after: async (root) => {
      await until(() => root.querySelector('[data-kind="blank-folder"]') !== null, "the folder");
      root.querySelector<HTMLElement>('[data-kind="blank-folder"]')?.click();
      await until(() => document.querySelector('[data-kind="blank-folders"]') !== null, "the menu");
      await frames(4);
    },
  },
  "new-session-environments": {
    title: "New session with two environments: one chip names both, and its menu offers each",
    environments: [LOCAL, BUILD],
    sessions: [session("s1", { title: "Fix the remote session", cwd: "/Users/me/work/app" })],
    blank: { cwd: "/Users/me/work/app" },
    after: async (root) => {
      await until(() => root.querySelector('[data-kind="blank-folder"]') !== null, "the folder");
      root.querySelector<HTMLElement>('[data-kind="blank-folder"]')?.click();
      await until(() => document.querySelector('[data-kind="blank-folders"]') !== null, "the menu");
      await frames(4);
    },
  },
  "new-session-untrusted": {
    title:
      "New session in a folder nobody has decided on, with a long name: marked before the first message",
    sessions: [],
    trust: null,
    blank: {
      cwd: "/Users/me/work/clients/northwind/a-very-long-repository-name-for-the-billing-service-and-more",
    },
    after: (root) =>
      until(() => root.querySelector('[data-slot="blank-trust"]') !== null, "the trust mark"),
  },
  "new-session-offline": {
    title:
      "New session whose environment dropped: says so once, with Connect again; the draft stays",
    sessions: [session("s1", { title: "Fix the remote session", cwd: "/Users/me/work/app" })],
    blank: { cwd: "/Users/me/work/app" },
    after: async (root, emit) => {
      await until(() => root.querySelector('[data-kind="blank-folder"]') !== null, "the folder");
      emit({
        type: "environment-status",
        environmentId: "local",
        state: "closed",
        error: "daemon exited (code 1)",
      });
      await until(() => root.querySelector('[data-slot="blank-lead"]') !== null, "the state");
      await frames(2);
    },
  },
  "new-session-starting": {
    title: "The first message is sent, and the session is being made",
    sessions: [session("s1", { title: "Fix the remote session" })],
    blank: {
      cwd: "/Users/me/work/app",
      starting: "Find why the remote session drops after a minute, and fix it.",
    },
  },
  "new-session-trust": {
    title: "The first message, in a folder nobody has decided on: asked whether to trust it",
    sessions: [session("s1", { title: "Fix the remote session" })],
    trust: null,
    blank: {
      cwd: "/Users/me/work/app",
      starting: "Find why the remote session drops after a minute, and fix it.",
    },
    after: () =>
      until(
        () => document.querySelector('[role="dialog"] [data-slot="decision-path"]') !== null,
        "the trust question",
      ),
  },
  "menu-trust": {
    title: "The environment menu offers to trust the shown workspace's folder",
    sessions: [session("s1", { title: "Fix the remote session" })],
    trust: null,
    after: async (root) => {
      await clickByLabel(root, "Workspace actions");
      await new Promise((r) => setTimeout(r, 200));
    },
  },
  "dialog-add-host": {
    title: "Add environment dialog, over Settings",
    sessions: [],
    after: async (root) => {
      await openSettings(root, "Environments");
      await click(root, "Add environment");
    },
  },
  "connectors-page": {
    title: "Connectors, MCP servers: two environments keep them; ready, needs sign-in, failed, off",
    environments: [LOCAL, BUILD],
    status: [KEEPS("local"), KEEPS("build")],
    sessions: [session("s1", { title: "Fix the remote session" })],
    connectors: CONNECTORS,
    after: (root) => openConnectors(root),
  },
  "connectors-empty": {
    title: "Connectors, MCP servers: none yet",
    status: [KEEPS("local")],
    sessions: [],
    after: (root) => openConnectors(root),
  },
  "connectors-none": {
    title: "Connectors: no connected environment can keep them",
    sessions: [],
    after: (root) => openConnectors(root),
  },
  "connectors-form": {
    title: "Add a connector, over the Connectors page",
    status: [KEEPS("local")],
    sessions: [],
    connectors: CONNECTORS.slice(0, 1),
    after: async (root) => {
      await openConnectors(root);
      await click(root, "Add connector");
    },
  },
  "plugins-page": {
    title:
      "Connectors, Plugins: one wants a sign-in, one has a long description, one is off; many can be installed",
    status: [EXTENDS("local")],
    sessions: [session("s1", { title: "Fix the remote session" })],
    plugins: { sources: PLUGIN_SOURCES, all: PLUGINS },
    connectors: PLUGIN_SERVERS,
    after: (root) => openConnectors(root, "plugins"),
  },
  "plugins-empty": {
    title: "Connectors, Plugins: none installed, and a source that lists none",
    status: [EXTENDS("local")],
    sessions: [],
    plugins: { sources: PLUGIN_SOURCES.slice(0, 1), all: [] },
    after: (root) => openConnectors(root, "plugins"),
  },
  "plugins-install": {
    title: "Installing a plugin asks first, and says what a plugin can do",
    status: [EXTENDS("local")],
    sessions: [],
    plugins: { sources: PLUGIN_SOURCES, all: PLUGINS },
    after: async (root) => {
      await openConnectors(root, "plugins");
      await clickByLabel(root, "Install figma");
      await new Promise((r) => setTimeout(r, 250));
    },
  },
  "plugins-zh": {
    title: "Connectors, Plugins, in Chinese",
    status: [EXTENDS("local")],
    sessions: [],
    plugins: { sources: PLUGIN_SOURCES, all: PLUGINS },
    connectors: PLUGIN_SERVERS,
    language: "zh-CN",
    after: (root) => openConnectors(root, "plugins"),
  },
  "connectors-plugin-server": {
    title: "Connectors, MCP servers: one a plugin brings, among the person's own",
    status: [EXTENDS("local")],
    sessions: [],
    plugins: { sources: PLUGIN_SOURCES, all: PLUGINS },
    connectors: [...CONNECTORS.slice(0, 2), ...PLUGIN_SERVERS],
    after: (root) => openConnectors(root, "mcp"),
  },
  "connectors-zh": {
    title: "Connectors, in Chinese",
    status: [KEEPS("local")],
    sessions: [],
    connectors: CONNECTORS,
    language: "zh-CN",
    after: (root) => openConnectors(root),
  },
  "settings-general": {
    title: "Settings, General: an update is ready, usage statistics are on",
    sessions: [session("s1", { title: "Fix the remote session" })],
    update: { current: "0.3.11", kind: "available", version: "0.3.12" },
    analytics: true,
    after: (root) => openSettings(root),
  },
  "settings-general-dev": {
    title: "Settings, General: a run from source (no updates, nowhere to report to)",
    sessions: [],
    update: { current: "0.0.0", kind: "disabled", reason: "Updates are for the installed app." },
    after: (root) => openSettings(root),
  },
  "settings-general-zh": {
    title: "Settings, General, in Chinese: the language is chosen, an update is ready",
    sessions: [session("s1", { title: "Fix the remote session" })],
    update: { current: "0.3.11", kind: "available", version: "0.3.12" },
    analytics: true,
    language: "zh-CN",
    after: (root) => openSettings(root),
  },
  "settings-shortcuts": {
    title: "Settings, Keyboard shortcuts: every shortcut and its keys",
    sessions: [],
    after: (root) => openSettings(root, "Keyboard shortcuts"),
  },
  "conversation-zh": {
    title: "A conversation with the interface in Chinese (what the agent wrote stays as it came)",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
    language: "zh-CN",
  },
  "settings-appearance": {
    title: "Settings, Appearance: the colours of code, with a sample",
    sessions: [],
    after: (root) => openSettings(root, "Appearance"),
  },
  "settings-environments": {
    title:
      "Settings, Environments: one connected, one away with its own words, one with a long name",
    environments: [
      LOCAL,
      BUILD,
      {
        id: "long",
        name: "staging-europe-west-3-gpu-worker-pool-with-a-name-that-goes-on-and-on-and-on",
        kind: "remote",
        transport: {
          type: "ssh",
          host: "deploy@staging-europe-west-3-gpu-worker-pool-17.internal.example.com",
        },
      },
    ],
    status: [
      UP("local"),
      {
        environmentId: "build",
        state: "closed",
        error: "ssh: connect to host build-1 port 22: Connection refused",
      },
      { environmentId: "long", state: "reconnecting" },
    ],
    sessions: [],
    after: (root) => openSettings(root, "Environments"),
  },
  "settings-defaults": {
    title: "Settings, Session defaults: an agent's settings on one of two environments",
    environments: [LOCAL, BUILD],
    sessions: [],
    after: (root) => openSettings(root, "Session defaults"),
  },
  "settings-defaults-away": {
    title: "Settings, Session defaults: no environment is connected",
    status: [{ environmentId: "local", state: "closed", error: "spawn cycle ENOENT" }],
    sessions: [],
    after: (root) => openSettings(root, "Session defaults"),
  },
  "new-session-no-agent": {
    title: "New session with no available agent: explains why and offers to check again",
    sessions: [],
    noAgents: true,
    blank: {},
  },
  "dialog-edit-host": {
    title: "Edit environment dialog",
    environments: [BUILD, LOCAL],
    sessions: [],
    after: (root) => environmentAction(root, "build-1", "Edit"),
  },
  "dialog-delete-session": {
    title: "Destructive confirmation dialog for deleting a session",
    sessions: [session("s1", { title: "Fix the remote session" })],
    history: conversation,
    after: async (root) => {
      await clickByLabel(root, "Session actions");
      await new Promise((r) => setTimeout(r, 200));
      await click(root.ownerDocument.body, "Delete");
      await until(
        () => document.querySelector('[role="alertdialog"], [role="dialog"]') !== null,
        "the delete confirmation dialog",
      );
    },
  },
  "danger-setting": {
    title: "High-risk permission mode chip and menu option marked with caution",
    sessions: [
      session("s1", {
        title: "Fix the remote session",
        config: { mode: "bypassPermissions", model: "default" },
      }),
    ],
    history: conversation,
    after: async (root) => {
      await clickByLabel(root, "Permission mode: Bypass permissions");
      await new Promise((r) => setTimeout(r, 200));
    },
  },
  "step-live": {
    title: "Live inline AI status while the agent is thinking",
    sessions: [session("s1", { title: "Audit the design tokens", state: "running" })],
    history: [
      you("u1", "Check contrast ratios across dark and light modes."),
      running(),
      u({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Measuring luminance for every surface pair." },
      }),
    ],
  },
  "composer-model": {
    title: "The Model menu open, the Effort chip beside it",
    attach: true,
    sessions: [
      session("s1", {
        title: "Redesign the composer",
        config: { mode: "auto", model: "opus", effort: "high" },
      }),
    ],
    history: conversation,
    after: async (root) => {
      await clickByLabel(root, "Model: Opus");
      await new Promise((r) => setTimeout(r, 200));
    },
  },
  "composer-effort": {
    title: "The Effort menu open: the levels by name, the model's default named as such",
    attach: true,
    sessions: [
      session("s1", {
        title: "Redesign the composer",
        config: { mode: "auto", model: "opus", effort: "high" },
      }),
    ],
    history: conversation,
    after: async (root) => {
      await clickByLabel(root, "Effort: High");
      await new Promise((r) => setTimeout(r, 200));
    },
  },
  "composer-expanded": {
    title: "Composer expanded with extension tray (plan + queued) and multi-line draft",
    attach: true,
    status: [
      {
        environmentId: "local",
        state: "connected",
        capabilities: { queue: true, files: true, folders: true },
      },
    ],
    sessions: [
      session("s1", {
        title: "Redesign the composer",
        state: "running",
        config: { mode: "bypassPermissions", model: "opus", effort: "medium" },
      }),
    ],
    history: [
      you("u1", "Refactor the composer into three bands."),
      running(),
      u({
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: "p1",
          entries: [
            {
              content: "Wire reasoning effort into Claude adapter",
              priority: "high",
              status: "completed",
            },
            {
              content: "Build three-band composer layout",
              priority: "high",
              status: "in_progress",
            },
            {
              content: "Verify Electron screenshots in dark and light mode",
              priority: "medium",
              status: "pending",
            },
          ],
        },
      }),
      u({
        sessionUpdate: "_cycle/queue_update",
        entries: [
          {
            queueId: "q1",
            prompt: [{ type: "text", text: "Also add unit tests for Model + Effort keyboard nav" }],
          },
        ],
      }),
      u({
        sessionUpdate: "usage_update",
        used: 41_200,
        size: 200_000,
        cost: { amount: 0.88, currency: "USD" },
      }),
    ],
  },
  "composer-context": contextScenario(
    "The context ring's details: the total, a bar of the parts, a row a part, then when it compacts and the cost",
    [you("u1", "Why does the remote session fail, and fix it."), say("a1", "Fixed."), measured],
  ),
  "composer-context-plan": {
    ...contextScenario(
      "The context ring's details with the account's plan limits under them: one getting close, one quiet",
      [you("u1", "Why does the remote session fail, and fix it."), say("a1", "Fixed."), measured],
    ),
    planUsage: {
      claude: {
        at: Date.now(),
        windows: [
          {
            kind: "five_hour",
            utilization: 0.74,
            resetsAt: Date.now() + 43 * 60_000,
            status: "allowed",
          },
          {
            kind: "seven_day",
            utilization: 0.31,
            resetsAt: Date.now() + 3 * 86_400_000,
            status: "allowed",
          },
        ],
      },
    },
  },
  "composer-context-plain": contextScenario(
    "The context ring's details from an agent that does not say what the window holds",
    [
      you("u1", "Why does the remote session fail, and fix it."),
      say("a1", "Fixed."),
      u({ sessionUpdate: "usage_update", used: 41_200, size: 200_000 }),
    ],
  ),
  "composer-context-empty": contextScenario(
    "The context ring's details before any usage is reported",
    [you("u1", "Why does the remote session fail, and fix it.")],
  ),
  "composer-context-compacted": contextScenario(
    "The context ring's details after a compaction, before the next reply reports usage",
    [
      you("u1", "Why does the remote session fail, and fix it."),
      say("a1", "Fixed."),
      measured,
      u({ sessionUpdate: "compaction_update", compactionId: "k1", status: "started" }),
      u({ sessionUpdate: "compaction_update", compactionId: "k1", status: "completed" }),
    ],
  ),
  "composer-working": {
    title:
      "The composer while the agent works: one line, Enter queues, the queue key on the button",
    status: [
      {
        environmentId: "local",
        state: "connected",
        capabilities: { queue: true, files: true, folders: true },
      },
    ],
    sessions: [
      session("s1", {
        title: "Redesign the composer",
        state: "running",
        config: { mode: "auto", model: "opus", effort: "high" },
      }),
    ],
    history: [you("u1", "Refactor the composer into three bands."), running(), measured],
  },
  // CYCL-214: on many lines the + and Send keep the corners they have on one line; the text takes its own inset.
  "composer-multiline": {
    title: "The composer on many lines: the + and Send stay where one line has them",
    attach: true,
    sessions: [
      session("s-multiline", {
        title: "Redesign the composer",
        config: { mode: "auto", model: "opus", effort: "high" },
      }),
    ],
    history: [you("u1", "Refactor the composer into three bands."), measured],
    draft: {
      text: "Make the buttons a step smaller.\nKeep the hit areas at 32px.\nCheck both themes.",
    },
  },
  "composer-attached": {
    title: "A picture attached in the composer, above the words, under the extension tray",
    attach: true,
    status: [
      {
        environmentId: "local",
        state: "connected",
        capabilities: { queue: true, files: true, folders: true },
      },
    ],
    sessions: [
      session("s-attached", {
        title: "Redesign the composer",
        state: "running",
        config: { mode: "auto", model: "opus", effort: "high" },
      }),
    ],
    history: [
      you("u1", "Refactor the composer into three bands."),
      running(),
      u({
        sessionUpdate: "_cycle/queue_update",
        entries: [
          { queueId: "q1", prompt: [{ type: "text", text: "Then run the browser tests" }] },
        ],
      }),
      measured,
    ],
    // An image: what this agent takes (`attach` declares images only).
    draft: {
      text: "Here is the screen.",
      attachments: [
        {
          id: "a1",
          name: "screen.png",
          kind: "image",
          type: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          bytes: 70,
        },
      ],
    },
  },
};

/** The snapshot a session of a scenario opens on: its own history, if it has one. */
export const sessionSnapshotOf = (s: Scenario, sessionId: string): SessionSnapshot =>
  snapshotOf({ ...s, history: s.histories?.[sessionId] ?? s.history });

export const snapshotOf = (s: Scenario): SessionSnapshot => ({
  conversation: (s.history ?? []).reduce((c, u) => applyUpdate(c, u), emptyConversation()),
  permissions: s.permissions ?? [],
  version: (s.history ?? []).length,
});
export { BUILD, LOCAL, UP };

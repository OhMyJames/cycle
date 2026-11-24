// What the renderer knows: the state the page draws, and the keys it is kept under.
import type {
  AccountStatus,
  AgentInfo,
  AnalyticsStatus,
  ConnectorInfo,
  EnvironmentConfig,
  EnvironmentStatus,
  PermissionRequest,
  PlanUsage,
  PluginInfo,
  PluginSourceInfo,
  PreferencesState,
  PromptBlock,
  SessionSummary,
  UpdateState,
} from "../api.ts";
import type { Params } from "../i18n.ts";
import type { MessageKey } from "../messages/en-US.ts";
import type { Conversation } from "../model/index.ts";
import type { TerminalTab } from "../terminals.ts";

export const viewKey = (environmentId: string, sessionId: string): string =>
  `${environmentId}:${sessionId}`;

/** Where an agent's plugins on an environment are kept in the state. */
export const pluginsKey = (environmentId: string, agentId: string): string =>
  `${environmentId}\n${agentId}`;

/**
 * The folder of the open session, when the Files tab can show it (its daemon reads a session's folder): what a place the
 * conversation names must be inside to be shown there (CYCL-92). Undefined otherwise. For `useAppState`, so that a link
 * appears once the daemon has said what it can do.
 */
export const filesRootOf = (state: AppState): string | undefined => {
  const { selectedEnvironment: environmentId, selectedSession: sessionId } = state;
  if (environmentId === undefined || sessionId === undefined) return undefined;
  if (state.status[environmentId]?.capabilities?.fs !== true) return undefined;
  return state.sessions[environmentId]?.find((s) => s.sessionId === sessionId)?.cwd;
};

/**
 * The key of what the blank conversation's box holds. One for every blank conversation, whatever environment it is on:
 * what was written stays when the environment or folder is changed, and when the person goes away and comes back.
 */
export const BLANK_KEY = "blank";

/**
 * A new session before its first message: only here, in the client. The daemon hears of it when that message is sent
 * (`session/new`, then `session/prompt`), and only then is it in the list (docs/protocol.md §6).
 */
export type BlankConversation = {
  environmentId: string;
  /** Where the agent will work, on the environment's machine. Empty until it is chosen. */
  cwd: string;
  /** The agent chosen; undefined: the first that is available on the environment. */
  agent: string | undefined;
  /** What the session starts with: the agent's defaults, then what was chosen here. Undefined until they are read. */
  config: Record<string, string> | undefined;
  /** The settings the person chose here: they stay over the agent's defaults when those are read again. */
  chosen?: Record<string, string>;
  /** The agent's defaults could not be read: it does not start from a form that may not be what the person set. */
  unreadable?: true;
  /** The first message, on its way: the session is being made. Nothing here can change meanwhile. */
  starting?: PromptBlock[];
  /**
   * The folder (its real path) nobody has decided whether to trust: asked when the first message is sent, before the
   * session is made (docs/protocol.md §8 "信任文件夹"). `failed`: why the answer could not be kept.
   */
  asking?: { path: string; failed?: string };
  /**
   * Whether its folder is trusted, read when the folder is chosen, so that the page can say before the first message
   * that it will be asked (`undecided`). Undefined while it is read, or when the daemon cannot say.
   */
  trust?: "trusted" | "untrusted" | "undecided";
  /** Starting a session with this agent failed with `-32000` (not signed in): prompt the user to sign in. */
  authRequired?: { agentId: string; agentName: string };
};

export type SessionView = {
  environmentId: string;
  sessionId: string;
  conversation: Conversation;
  permissions: PermissionRequest[];
  /** The version of main's state this view is at. The next event is this plus one. */
  version: number;
  loading: boolean;
};

export type AppState = {
  ready: boolean;
  /**
   * The person's account (.agents/notes/2026-11-23-sso-login-desktop-must-sign-in.md). Undefined until main has said. While it is not `open`, the
   * page is the sign-in page, and nothing of the environments is read.
   */
  account: AccountStatus | undefined;
  /** The person closed the note that someone else is signed in now. */
  switchNoticeSeen: boolean;
  /** The update version the person put off ("Later"): not offered again in the notices until a newer one. */
  updateDeferred?: string;
  environments: EnvironmentConfig[];
  status: Record<string, EnvironmentStatus>;
  sessions: Record<string, SessionSummary[]>;
  agents: Record<string, AgentInfo[]>;
  /** Counts changes to an agent's defaults, so a form that shows them knows to read them again. */
  defaultsRevision: Record<string, number>;
  /**
   * Each environment's connectors as last read, or why they could not be. Only for an environment the page has asked
   * about; a change there (here or elsewhere) reads them again.
   */
  connectors: Record<string, { list?: ConnectorInfo[]; error?: string }>;
  /**
   * Each agent's plugins on each environment as last read (by `pluginsKey`), or why they could not be. Only for what
   * the page has asked for.
   */
  plugins: Record<string, { sources?: PluginSourceInfo[]; list?: PluginInfo[]; error?: string }>;
  /** Each environment's plan usage, by agent: the latest its daemon heard (docs/protocol.md §8 "套餐用量"). */
  planUsage: Record<string, Record<string, PlanUsage>>;
  selectedEnvironment: string | undefined;
  selectedSession: string | undefined;
  /** The blank conversation that is open, in place of a session: `selectedSession` is undefined while it is. */
  blank: BlankConversation | undefined;
  views: Record<string, SessionView>;
  /** The last thing that went wrong, for the user to read and dismiss. */
  /** What failed: the system's words as they came, or a message of the catalog with its parameters. */
  error: string | { key: MessageKey; params?: Params } | undefined;
  /** The app's own updating. Undefined until main has said. */
  update: UpdateState | undefined;
  /** Whether the app reports how it is used (docs/analytics.md). Undefined until main has said. */
  analytics: AnalyticsStatus | undefined;
  /** How the app looks and reads, as the person chose (main keeps it). Undefined until main has said. */
  preferences: PreferencesState | undefined;
  /**
   * Each session's terminals (by `viewKey`), as its daemon last listed them, and those that ended while the connection
   * was away. Only for a session whose terminals were asked for: a panel that showed none asks nothing.
   */
  terminals: Record<string, TerminalTab[]>;
  /** Counts the times a notification was pressed: its session is shown, over whatever page is open. */
  focusRequests: number;
  /** Counts the times something asked for the input box to take the focus (a message put back to send again). */
  composerFocus: number;
};

export const initialState = (): AppState => ({
  ready: false,
  account: undefined,
  switchNoticeSeen: false,
  environments: [],
  status: {},
  sessions: {},
  agents: {},
  defaultsRevision: {},
  connectors: {},
  plugins: {},
  planUsage: {},
  selectedEnvironment: undefined,
  selectedSession: undefined,
  blank: undefined,
  views: {},
  terminals: {},
  error: undefined,
  update: undefined,
  analytics: undefined,
  preferences: undefined,
  focusRequests: 0,
  composerFocus: 0,
});

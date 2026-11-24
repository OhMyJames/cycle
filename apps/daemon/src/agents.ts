import type { AgentApp, Stream } from "@agentclientprotocol/sdk/experimental/v2";
import type { PromptCapabilities } from "@cycle/protocol";
import type { AgentSetupProvider } from "./agent-setup.ts";
import type { PluginProvider } from "./plugins.ts";

/**
 * What a launch is for: the one session the process will serve (each session has its own, decision 0014). Its
 * variables are what its environment sets for the commands the agent runs (docs/protocol.md §6 "环境"); never the
 * agent's own settings, which the definition keeps.
 */
export type LaunchContext = { sessionId: string; sessionEnv: Record<string, string> };

/** Where an agent is reached: a stream to a process, or an app in this process (tests). */
export type AgentTarget = { target: Stream | AgentApp; kill?: () => void };

/**
 * An agent the daemon can run. How it is started is the definition's business: the daemon only
 * speaks ACP v2 to what `launch` returns, whether that is a child process, a remote one or a
 * sandbox (decision 0001).
 */
export type AgentDefinition = {
  id: string;
  name: string;
  /** JSON Schema of what can be configured, for a client to draw a form from. */
  configSchema: Record<string, unknown>;
  /**
   * What a new session is set to before the person's saved defaults and the session's own choices: Cycle's defaults for
   * this agent, each a key of `configSchema` with its schema `default`. Only a new session: one resumed replays what it
   * was set to, so a later change here does not reach it. None when absent: the agent's own.
   */
  newSession?: Record<string, string>;
  /** What the agent takes in a prompt beyond text and links (ACP `PromptCapabilities`). None when absent. */
  promptCapabilities?: PromptCapabilities;
  /** It takes a prompt into the turn that is running (`_meta["cycle/steer"]`, docs/protocol.md §8). */
  steer?: boolean;
  available?: () => boolean | Promise<boolean>;
  /**
   * How many of its sessions may hold a process that has had no prompt yet; past it the oldest such is let go
   * (decision 0014). Counted among this agent's sessions only. No limit when absent; 0 disables warm pool retention.
   */
  maxAhead?: number | (() => number | undefined);
  /** Its plugins, when it has them (docs/protocol.md §15). */
  plugins?: PluginProvider;
  /** Read-only status, diagnostics, auth, and runtime settings provider (docs/protocol.md §16). */
  setup?: AgentSetupProvider;
  launch: (context?: LaunchContext) => Promise<AgentTarget>;
};

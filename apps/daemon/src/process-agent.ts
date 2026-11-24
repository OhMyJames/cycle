import { ndJsonStream } from "@agentclientprotocol/sdk/experimental/v2";
import type { PromptCapabilities } from "@cycle/protocol";
import type { AgentSetupProvider } from "./agent-setup.ts";
import type { AgentDefinition, LaunchContext } from "./agents.ts";
import type { Logger } from "./logger.ts";
import type { PluginProvider } from "./plugins.ts";

export type ProcessAgentOptions = {
  id: string;
  name: string;
  configSchema?: Record<string, unknown>;
  /** What the agent takes in a prompt beyond text and links; see `AgentDefinition`. */
  promptCapabilities?: PromptCapabilities;
  /** See `AgentDefinition`. */
  steer?: boolean;
  command: string[];
  /**
   * The child's whole environment, or a function evaluated on every `launch()` so hot-reloaded runtime settings
   * reach newly spawned adapter processes. Nothing is inherited from the daemon (AGENTS.md). The function is given what
   * the launch is for: the session's environment variables, which the harness hands its adapter apart from its own.
   */
  env: Record<string, string> | ((context: LaunchContext) => Record<string, string>);
  cwd?: string;
  /** Whether it can run at all, checked when clients ask which agents there are. */
  available?: () => boolean | Promise<boolean>;
  /** See `AgentDefinition`. */
  maxAhead?: number | (() => number | undefined);
  /** See `AgentDefinition`. */
  plugins?: PluginProvider;
  /** See `AgentDefinition`. */
  setup?: AgentSetupProvider;
  /**
   * Where what the process says on stderr goes, line by line, and how it exited (docs/daemon.md "日志"). Its stdout
   * is the protocol and is never logged. Without it stderr is the daemon's own.
   */
  log?: Logger;
};

/** The most stderr lines one agent process puts in the log: a process that loops on an error does not fill it. */
const STDERR_LINES = 200;

/** Reads a stream of text line by line, until it ends. */
const eachLine = async (stream: ReadableStream<Uint8Array>, line: (text: string) => void) => {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    let at = rest.indexOf("\n");
    while (at !== -1) {
      line(rest.slice(0, at));
      rest = rest.slice(at + 1);
      at = rest.indexOf("\n");
    }
  }
  if (rest !== "") line(rest);
};

/** An agent that is a child process speaking ACP v2 on its stdin and stdout. */
export const processAgent = (options: ProcessAgentOptions): AgentDefinition => ({
  id: options.id,
  name: options.name,
  configSchema: options.configSchema ?? { type: "object", properties: {} },
  ...(options.promptCapabilities !== undefined
    ? { promptCapabilities: options.promptCapabilities }
    : {}),
  ...(options.steer === true ? { steer: true } : {}),
  ...(options.available !== undefined ? { available: options.available } : {}),
  ...(options.maxAhead !== undefined ? { maxAhead: options.maxAhead } : {}),
  ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
  ...(options.setup !== undefined ? { setup: options.setup } : {}),
  launch: async (context = { sessionId: "", sessionEnv: {} }) => {
    const env = typeof options.env === "function" ? options.env(context) : options.env;
    const proc = Bun.spawn(options.command, {
      env,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      stdin: "pipe",
      stdout: "pipe",
      stderr: options.log !== undefined ? "pipe" : "inherit",
    });
    const { log } = options;
    if (log !== undefined) {
      const pid = proc.pid;
      log.info("agent_process_started", { agent: options.id, pid });
      let said = 0;
      void eachLine(proc.stderr as ReadableStream<Uint8Array>, (text) => {
        if (text.trim() === "") return;
        said += 1;
        if (said <= STDERR_LINES) log.warn("agent_stderr", { agent: options.id, pid, line: text });
        else if (said === STDERR_LINES + 1)
          log.warn("agent_stderr_dropped", { agent: options.id, pid, after: STDERR_LINES });
      }).catch(() => {});
      void proc.exited.then((code) => {
        const fields = { agent: options.id, pid, code, signal: proc.signalCode ?? undefined };
        // Stopped by the daemon (a signal it sent) or ended well: noted. Anything else is what to look at.
        if (code === 0 || proc.killed) log.info("agent_process_exited", fields);
        else log.warn("agent_process_exited", fields);
      });
    }
    const input = new WritableStream<Uint8Array>({
      write: (chunk) => {
        proc.stdin.write(chunk);
        proc.stdin.flush();
      },
      close: () => {
        proc.stdin.end();
      },
    });
    return { target: ndJsonStream(input, proc.stdout), kill: () => proc.kill() };
  },
});

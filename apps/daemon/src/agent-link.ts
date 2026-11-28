import {
  AgentApp,
  type ClientContext,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  client,
  type InitializeResponse,
  methods,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
  type Stream,
} from "@agentclientprotocol/sdk/experimental/v2";
import { z } from "zod";
import type { AgentDefinition, LaunchContext } from "./agents.ts";
import type { NativeWorktreeCall } from "./worktree-host.ts";

/** The request Claude's worktree hooks send (harness/claude/src/worktree-hooks.ts). */
export const WORKTREE_HOOK = "_cycle/worktree/hook";
const WorktreeHookParams = z.object({
  phase: z.enum(["before", "after"]),
  tool: z.string(),
  toolUseId: z.string(),
  input: z.unknown().optional(),
  response: z.unknown().optional(),
});

export type LinkHandlers = {
  /**
   * An update the agent sent, and the session it named: its own, or a sub-agent's it announced (ACP v2 child
   * sessions, docs/protocol.md §9).
   */
  update: (update: SessionUpdate, sessionId: string) => void;
  /**
   * The agent asks the user something. Answers when someone has decided. `signal` ends when the agent takes the
   * request back (`$/cancel_request`): it is then settled as cancelled, not left waiting on the user.
   */
  permission: (
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ) => Promise<RequestPermissionResponse>;
  /** The agent asks the user for structured input (a form). Answers when someone has, or at once if no one can. */
  elicitation: (
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ) => Promise<CreateElicitationResponse>;
  /**
   * Claude's own EnterWorktree or ExitWorktree is about to run or has run (docs/protocol.md §6 "中途进出"). Answers when
   * the environment's setup or cleanup has; the agent waits for it.
   */
  worktree: (call: NativeWorktreeCall) => Promise<{ note?: string }>;
  /** The connection to the agent ended, however it ended. */
  closed: () => void;
};

/** A live connection to one agent process, as ACP v2 sees it: the daemon is the client. */
export class AgentLink {
  readonly agent: ClientContext;
  /** The agent said it can reach MCP servers over http (`capabilities.session.mcp.http`): connectors go that way. */
  readonly mcpHttp: boolean;
  readonly #close: () => void;
  readonly #kill: (() => void) | undefined;
  readonly #rebind: (handlers: LinkHandlers) => void;

  private constructor(
    agent: ClientContext,
    mcpHttp: boolean,
    close: () => void,
    kill: (() => void) | undefined,
    rebind: (handlers: LinkHandlers) => void,
  ) {
    this.agent = agent;
    this.mcpHttp = mcpHttp;
    this.#close = close;
    this.#kill = kill;
    this.#rebind = rebind;
  }

  /**
   * Hands the link to whoever takes it over: what the agent sends from now goes to `handlers`. A link started ahead of
   * any session (decision 0014, standby) has handlers that say nothing until then.
   */
  adopt(handlers: LinkHandlers): void {
    this.#rebind(handlers);
  }

  static async connect(
    definition: AgentDefinition,
    handlers: LinkHandlers,
    context?: LaunchContext,
  ): Promise<AgentLink> {
    const launched = await definition.launch(context);
    let current = handlers;
    const app = client({ name: "cycle" })
      .onNotification(methods.client.session.update, ({ params }) => {
        current.update(params.update, params.sessionId);
      })
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) =>
        current.permission(params, signal),
      )
      .onRequest(methods.client.elicitation.create, ({ params, signal }) =>
        current.elicitation(params, signal),
      )
      .onRequest<z.output<typeof WorktreeHookParams>, { note?: string }>(
        WORKTREE_HOOK,
        WorktreeHookParams,
        ({ params }) => current.worktree(params as NativeWorktreeCall),
      );
    const connection =
      launched.target instanceof AgentApp
        ? app.connect(launched.target)
        : app.connect(launched.target as Stream);
    const closed = () => current.closed();
    void connection.closed.then(closed, closed);
    let initialized: InitializeResponse;
    try {
      initialized = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "cycle", version: "0.0.0" },
        // Forms only: whether there is anyone to ask is the daemon's to decide, per request.
        capabilities: { elicitation: { form: {} } },
      });
    } catch (error) {
      connection.close();
      launched.kill?.();
      throw error;
    }
    const mcpHttp = initialized.capabilities?.session?.mcp?.http != null;
    return new AgentLink(
      connection.agent,
      mcpHttp,
      () => connection.close(),
      launched.kill,
      (next) => {
        current = next;
      },
    );
  }

  kill(): void {
    this.#close();
    this.#kill?.();
  }
}

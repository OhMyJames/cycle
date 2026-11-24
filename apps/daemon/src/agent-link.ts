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
import type { AgentDefinition, LaunchContext } from "./agents.ts";

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

  private constructor(
    agent: ClientContext,
    mcpHttp: boolean,
    close: () => void,
    kill: (() => void) | undefined,
  ) {
    this.agent = agent;
    this.mcpHttp = mcpHttp;
    this.#close = close;
    this.#kill = kill;
  }

  static async connect(
    definition: AgentDefinition,
    handlers: LinkHandlers,
    context?: LaunchContext,
  ): Promise<AgentLink> {
    const launched = await definition.launch(context);
    const app = client({ name: "cycle" })
      .onNotification(methods.client.session.update, ({ params }) => {
        handlers.update(params.update, params.sessionId);
      })
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) =>
        handlers.permission(params, signal),
      )
      .onRequest(methods.client.elicitation.create, ({ params, signal }) =>
        handlers.elicitation(params, signal),
      );
    const connection =
      launched.target instanceof AgentApp
        ? app.connect(launched.target)
        : app.connect(launched.target as Stream);
    void connection.closed.then(handlers.closed, handlers.closed);
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
    return new AgentLink(connection.agent, mcpHttp, () => connection.close(), launched.kill);
  }

  kill(): void {
    this.#close();
    this.#kill?.();
  }
}

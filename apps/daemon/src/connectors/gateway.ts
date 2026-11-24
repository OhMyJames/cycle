import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The daemon's MCP gateway (docs/protocol.md §14): one loopback HTTP server through which an agent
 * reaches the connectors of its session. It only checks who is asking and routes; what a request
 * becomes (a call to the real server with its token, or a message to a process) is `forward`'s.
 *
 * An agent is given `<url>/mcp/<connectorId>` and a bearer key of its session's own. The key is made
 * when the agent starts, opens only the connectors it was given, and is gone when the agent goes:
 * it is not the connection's, and it is no token of any account.
 *
 * Red lines as for the daemon (AGENTS.md): loopback only, `Host` checked, nothing without the key.
 */

export type Forward = (
  sessionId: string,
  connectorId: string,
  request: Request,
) => Promise<Response>;

type Grant = { sessionId: string; connectors: ReadonlySet<string> };

const plain = (status: number, text: string): Response =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** A path segment as it was meant, or undefined when its escapes are not ones (`%E0`): no connector is named so. */
const decoded = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

export class McpGateway {
  readonly #server: ReturnType<typeof Bun.serve>;
  readonly #grants = new Map<string, Grant>();
  readonly #forward: Forward;

  private constructor(forward: Forward) {
    this.#forward = forward;
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // A server's event stream stays open between messages: no idle cut.
      idleTimeout: 0,
      fetch: (request) => this.#handle(request),
    });
  }

  static start(forward: Forward): McpGateway {
    return new McpGateway(forward);
  }

  get port(): number {
    return this.#server.port ?? 0;
  }

  /** Where an agent reaches one connector. */
  endpoint(connectorId: string): string {
    return `http://127.0.0.1:${this.port}/mcp/${encodeURIComponent(connectorId)}`;
  }

  /** A new key for a session, opening these connectors only. The session's key before it stops working. */
  grant(sessionId: string, connectorIds: readonly string[]): string {
    this.revoke(sessionId);
    const key = randomBytes(32).toString("base64url");
    this.#grants.set(key, { sessionId, connectors: new Set(connectorIds) });
    return key;
  }

  revoke(sessionId: string): void {
    for (const [key, grant] of this.#grants) {
      if (grant.sessionId === sessionId) this.#grants.delete(key);
    }
  }

  stop(): void {
    this.#grants.clear();
    void this.#server.stop(true);
  }

  #grantOf(header: string | null): Grant | undefined {
    const given = header?.match(/^Bearer (\S+)$/)?.[1];
    if (given === undefined) return undefined;
    const bytes = Buffer.from(given);
    for (const [key, grant] of this.#grants) {
      const expected = Buffer.from(key);
      if (expected.length === bytes.length && timingSafeEqual(expected, bytes)) return grant;
    }
    return undefined;
  }

  async #handle(request: Request): Promise<Response> {
    // A page in a browser on this machine could aim a name of its own at this port (DNS rebinding).
    const host = request.headers.get("host");
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      return plain(421, "Misdirected request");
    }
    const grant = this.#grantOf(request.headers.get("authorization"));
    if (grant === undefined) return plain(401, "Unauthorized");
    const match = new URL(request.url).pathname.match(/^\/mcp\/([^/]+)$/);
    const connectorId = match?.[1] === undefined ? undefined : decoded(match[1]);
    if (connectorId === undefined || !grant.connectors.has(connectorId)) {
      return plain(404, "Not found");
    }
    try {
      return await this.#forward(grant.sessionId, connectorId, request);
    } catch {
      return plain(502, "The connector could not be reached");
    }
  }
}

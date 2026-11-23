import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { allowedEndpoint } from "@cycle/oidc";

/** Opens a URL in the person's browser. Electron's `shell.openExternal` in the app; a fake in tests. */
export type OpenBrowser = (url: string) => Promise<void>;

/** What came back to the callback: a code and its state, or the authorization server's error word. */
export type Callback = { code?: string; state?: string; error?: string };

export type AuthOutcome<T> =
  | { kind: "done"; value: T }
  /** The person said no, closed the flow here, or it timed out: not a failure to report as one. */
  | { kind: "cancelled" }
  /** The authorization server answered with an error other than the person's "no". */
  | { kind: "refused" };

/** Only a web page is opened: https, or http to this machine. Anything else from a daemon is not handed to the system. */
export const openableAuthorizationUrl = (url: string): boolean => allowedEndpoint(url);

const PAGE = `<!doctype html><meta charset="utf-8"><title>Cycle</title><p>You can close this tab and go back to Cycle.</p>`;

/** The error the person's own "no" comes back as (RFC 6749 §4.1.2.1): a cancel, not a failure. */
const DENIED = "access_denied";

/**
 * Signs in to a connector in the browser, in the main process. A loopback callback on this machine catches the code;
 * the daemon holds the PKCE verifier, so the code is worth nothing on its own and never goes to the page.
 * `start` is given the callback's address; `finish` is given what came back. The server is closed in every path.
 */
export const authorizeInBrowser = async <T>(options: {
  start: (redirectUri: string) => Promise<{ flowId: string; authorizationUrl: string }>;
  finish: (params: { flowId: string } & Callback) => Promise<T>;
  open: OpenBrowser;
  signal: AbortSignal;
  /** How long the browser has. Default ten minutes, as long as the daemon keeps the flow. */
  timeoutMs?: number;
}): Promise<AuthOutcome<T>> => {
  let deliver: (callback: Callback) => void = () => {};
  const arrived = new Promise<Callback>((resolve) => {
    deliver = resolve;
  });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const field = (name: string) => url.searchParams.get(name) ?? undefined;
    const code = field("code");
    const state = field("state");
    const error = field("error");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    deliver({
      ...(code !== undefined ? { code } : {}),
      ...(state !== undefined ? { state } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (options.signal.aborted) return { kind: "cancelled" };
    // Listening before the daemon is asked: a stop while it discovers and registers is not missed.
    const stopped = new Promise<"stopped">((resolve) => {
      timer = setTimeout(() => resolve("stopped"), options.timeoutMs ?? 10 * 60_000);
      onAbort = () => resolve("stopped");
      options.signal.addEventListener("abort", onAbort, { once: true });
    });
    const { flowId, authorizationUrl } = await options.start(`http://127.0.0.1:${port}/callback`);
    if (options.signal.aborted) {
      // Stopped while the daemon was starting it: the browser is not opened, and the flow is ended there too.
      await options.finish({ flowId, error: DENIED }).catch(() => undefined);
      return { kind: "cancelled" };
    }
    if (!openableAuthorizationUrl(authorizationUrl))
      throw new Error("The daemon gave a sign-in address that is not a web page");
    await options.open(authorizationUrl);
    const callback = await Promise.race([arrived, stopped]);
    if (callback === "stopped") return { kind: "cancelled" };
    if (callback.error !== undefined) {
      // The daemon forgets the flow either way; told, it does not wait out its ten minutes.
      await options.finish({ flowId, error: callback.error }).catch(() => undefined);
      return callback.error === DENIED ? { kind: "cancelled" } : { kind: "refused" };
    }
    return { kind: "done", value: await options.finish({ flowId, ...callback }) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) options.signal.removeEventListener("abort", onAbort);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

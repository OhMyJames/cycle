export { App } from "./app.tsx";
export { CycleApp } from "./client/app.ts";
export type {
  HostBridge,
  RemoteBridge,
  RemoteInput,
  RemoteResult,
  RemoteServer,
  RemoteState,
  RemoteTestResult,
  UpdateBridge,
  UpdateState,
} from "./client/host.ts";

/**
 * Where the daemon is, for a page the daemon itself serves: the same host,
 * with the token the link carried after `#`. The token is kept for reloads
 * and taken out of the address, so it is not left in the history.
 */
export function daemonUrlFromPage(): string | null {
  const params = new URLSearchParams(location.hash.slice(1));
  let token = params.get("token");
  try {
    if (token) sessionStorage.setItem("cycle.token", token);
    else token = sessionStorage.getItem("cycle.token");
  } catch {
    // Without storage the token lasts until the page reloads.
  }
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  if (!token) return null;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`;
}

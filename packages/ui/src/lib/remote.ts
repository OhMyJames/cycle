import type { RemoteInput, RemoteServer, RemoteState, RemoteTestResult } from "../client/host.ts";

/** What the page knows of the desktop app's remote servers. */
export interface RemoteView {
  readonly servers: readonly RemoteServer[];
  readonly state: RemoteState;
  /** Why the bridge could not be read, when it could not. */
  readonly problem: string | null;
}

/** The answer of a call of the bridge, which may reject (main may have failed to start remotes). */
export type Guarded<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

export const UNREACHABLE =
  "The app's remote servers are not available. Restart the app to try again.";

/** Runs a call of the bridge, and turns a rejection into a short message rather than IPC's own text. */
export async function guard<T>(call: () => Promise<Guarded<T>> | Promise<T>): Promise<Guarded<T>> {
  try {
    const value = await call();
    if (typeof value === "object" && value !== null && "ok" in value) {
      return value as Guarded<T>;
    }
    return { ok: true, value: value as T };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}

export interface RemoteForm {
  id: string | null;
  name: string;
  target: string;
  home: string;
}

export function remoteFormFor(server: RemoteServer | null): RemoteForm {
  return {
    id: server?.id ?? null,
    name: server?.name ?? "",
    target: server?.target ?? "",
    home: server?.home ?? "",
  };
}

/** What to send for a form, or what is missing. The app checks the rest, and says why. */
export function remoteInput(form: RemoteForm): RemoteInput | string {
  const name = form.name.trim();
  const target = form.target.trim();
  const home = form.home.trim();
  if (!name) return "Give the server a name.";
  if (!target) return "Give an ssh target: user@host or a name from your ssh config.";
  return { name, target, ...(home ? { home } : {}) };
}

/** The server the window shows, or null for this computer. */
export function shownServer(view: RemoteView | null): RemoteServer | null {
  if (!view || view.state.status === "idle") return null;
  const id = view.state.id;
  return view.servers.find((server) => server.id === id) ?? null;
}

/** One line on how the app stands with a server. Empty when it has nothing to say of it. */
export function serverStatus(state: RemoteState, id: string): string {
  if (state.status === "idle" || state.id !== id) return "";
  switch (state.status) {
    case "connecting":
      return "Connecting…";
    case "connected":
      return state.warning ? `Connected. ${state.warning}` : "Connected";
    case "reconnecting":
      return `Connection lost. Trying again (${state.attempt})…`;
    case "failed":
      return state.reason;
  }
}

/** The dot's tone for a server: none when the window is not on it. */
export function serverTone(state: RemoteState, id: string): "ok" | "waiting" | "error" | null {
  if (state.status === "idle" || state.id !== id) return null;
  if (state.status === "connected") return "ok";
  return state.status === "failed" ? "error" : "waiting";
}

/** Whether the window shows a remote server's page, so paths and commands are that machine's. */
export function isRemote(view: RemoteView | null): boolean {
  return !!view && (view.state.status === "connected" || view.state.status === "reconnecting");
}

/** The app's note that it and the server's daemon differ in version, while the window shows it. */
export function remoteWarning(view: RemoteView | null): string | null {
  return view?.state.status === "connected" ? (view.state.warning ?? null) : null;
}

/**
 * The footer's words for where agents run commands, or null on this computer. A connection being
 * made, or one that failed, leaves the window on this computer, so it says nothing of them.
 */
export function whereLabel(view: RemoteView | null): string | null {
  if (!view || view.state.status === "idle") return null;
  const name = shownServer(view)?.name ?? "a remote server";
  switch (view.state.status) {
    case "connected":
      return `Remote: ${name}`;
    case "reconnecting":
      return `Remote: ${name} (reconnecting)`;
    default:
      return null;
  }
}

/** Runs a test of a server, turning a rejection into a failed result with a short reason. */
export async function runTest(call: () => Promise<RemoteTestResult>): Promise<RemoteTestResult> {
  try {
    return await call();
  } catch {
    return { ok: false, reason: UNREACHABLE };
  }
}

/** The line shown under a server after a test. */
export function testLine(result: RemoteTestResult): { tone: "ok" | "error"; text: string } {
  if (!result.ok) return { tone: "error", text: result.reason };
  if (result.connected) return { tone: "ok", text: "Connected now." };
  const text = result.version ? `Reachable, daemon ${result.version}.` : "Reachable.";
  return { tone: "ok", text: result.warning ? `${text} ${result.warning}` : text };
}

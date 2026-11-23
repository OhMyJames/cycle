// What a call from the page comes to: main's own answer for the methods it keeps (updates, analytics, the clipboard, the
// account), else the ConnectionManager's. One place, without Electron, so that the tests in a browser
// (test/web/web-app.ts) go through the same routing as the window does.
import { API_METHODS } from "@cycle/ui/api";
import type { ConnectionManager } from "./manager.ts";

export type Handlers = Record<string, (...args: unknown[]) => unknown>;

/**
 * `open` says whether the app may be used now (the person is signed in: .agents/notes/2026-11-23-sso-login-desktop-must-sign-in.md). While it is
 * not, nothing of the manager's is done: only main's own methods (the account, the look, the updates) answer.
 */
export const dispatch =
  (manager: ConnectionManager, own: Handlers, open: () => boolean = () => true) =>
  (method: string, args: unknown[]): unknown => {
    if (!(API_METHODS as readonly string[]).includes(method))
      throw new Error(`Refused: ${method} is not a method of the app`);
    // With what the page sent: `track` and `setAnalytics` take it (they were called without, and so did nothing).
    const handler = own[method];
    if (handler !== undefined) return handler(...args);
    if (!open()) throw new Error("Refused: sign in to Cycle first");
    return (manager as unknown as Handlers)[method]?.(...args);
  };

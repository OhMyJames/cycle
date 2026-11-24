// What a call from the page comes to: main's own answer for the methods it keeps (MAIN_METHODS), else the
// ConnectionManager's. One place, without Electron, so that the tests in a browser
// (test/web/web-app.ts) go through the same routing as the window does.
import { API_METHODS, type ApiMethod, type AppApi } from "@cycle/ui/api";

/** The methods main answers itself; every other one of AppApi is the ConnectionManager's. */
export const MAIN_METHODS = [
  "copyText",
  "copyImage",
  "saveImage",
  "updateState",
  "checkForUpdate",
  "installUpdate",
  "track",
  "analytics",
  "setAnalytics",
  "preferences",
  "setPreferences",
  "account",
  "signIn",
  "cancelSignIn",
  "signOut",
] as const satisfies readonly ApiMethod[];

export type MainMethod = (typeof MAIN_METHODS)[number];

type Handler = (...args: unknown[]) => unknown;

/** Main's answer to each of its methods: one missing is a type error, not a call that comes back undefined. */
export type Handlers = Record<MainMethod, Handler>;

/** What the manager must answer: the rest of AppApi. ConnectionManager is held to it (`implements`). */
export type ManagerApi = Omit<AppApi, MainMethod>;

const app: ReadonlySet<string> = new Set(API_METHODS);
const main: ReadonlySet<string> = new Set(MAIN_METHODS);

/**
 * `open` says whether the app may be used now (the person is signed in: .agents/notes/2026-11-23-sso-login-desktop-must-sign-in.md). While it is
 * not, nothing of the manager's is done: only main's own methods (the account, the look, the updates) answer.
 */
export const dispatch =
  (manager: ManagerApi, own: Handlers, open: () => boolean = () => true) =>
  (method: string, args: unknown[]): unknown => {
    if (!app.has(method)) throw new Error(`Refused: ${method} is not a method of the app`);
    const mine = main.has(method);
    if (!mine && !open()) throw new Error("Refused: sign in to Cycle first");
    // A method with no answer is a failure the page shows, never an answer of undefined.
    const handler = mine
      ? (own as Record<string, unknown>)[method]
      : (manager as unknown as Record<string, unknown>)[method];
    if (typeof handler !== "function") throw new Error(`${method} is not answered here`);
    // With what the page sent: `track` and `setAnalytics` take it (they were called without, and so did nothing).
    return (handler as Handler).apply(mine ? own : manager, args);
  };

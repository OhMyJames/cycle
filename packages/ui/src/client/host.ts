/**
 * What the page asks of whatever hosts it. The desktop app supplies a bridge
 * as `window.cycle`; a browser tab falls back to what the web platform has.
 */
/**
 * Where the desktop app is with its own updates. `current` is the running version. An update is
 * downloaded in the background, and installed only when the owner asks, since that restarts the app.
 */
export type UpdateState = { readonly current: string } & (
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "upToDate"; readonly checkedAt: number }
  /** `progress` runs from 0 to 1. */
  | { readonly status: "downloading"; readonly version: string; readonly progress: number }
  /** `message` says why the last try to install it was refused. */
  | { readonly status: "ready"; readonly version: string; readonly message?: string }
  | { readonly status: "error"; readonly message: string }
);

/** Present only in a packaged app that can replace itself. */
export interface UpdateBridge {
  state(): Promise<UpdateState>;
  check(): Promise<void>;
  /** Replaces the app with the downloaded version and starts it again. */
  install(): Promise<void>;
  /** Calls back on every change. Returns what stops it. */
  onState(listener: (state: UpdateState) => void): () => void;
}

/** A server the desktop app reaches through ssh: names and an ssh target only, never a secret. */
export type RemoteServer = {
  readonly id: string;
  readonly name: string;
  /** `user@host` or an alias of the owner's ssh config. */
  readonly target: string;
  /** The server's CYCLE_HOME, when it is not `~/.cycle-codex`. */
  readonly home?: string;
};

export type RemoteInput = Omit<RemoteServer, "id">;

export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** Where the desktop app is with the remote server it shows. `reason` and `warning` are short texts. */
export type RemoteState =
  | { readonly status: "idle" }
  | { readonly status: "connecting"; readonly id: string }
  | { readonly status: "connected"; readonly id: string; readonly warning?: string }
  | { readonly status: "reconnecting"; readonly id: string; readonly attempt: number }
  | { readonly status: "failed"; readonly id: string; readonly reason: string };

/** Present in the desktop app. The page never receives a token or ssh's own output. */
export interface RemoteBridge {
  list(): Promise<readonly RemoteServer[]>;
  add(input: RemoteInput): Promise<RemoteResult<RemoteServer>>;
  update(id: string, input: RemoteInput): Promise<RemoteResult<RemoteServer>>;
  remove(id: string): Promise<void>;
  /** Shows that server's page, or this machine's own when given null. */
  connect(id: string | null): Promise<void>;
  state(): Promise<RemoteState>;
  /** Calls back on every change. Returns what stops it. */
  onState(listener: (state: RemoteState) => void): () => void;
}

export interface HostBridge {
  /** A native folder chooser, or null where there is none. */
  pickDirectory?: () => Promise<string | null>;
  notify?: (title: string, body: string) => void;
  openExternal?: (url: string) => void;
  /** Whether the window draws its own title bar, so the page leaves room for its buttons. */
  insetTitleBar?: boolean;
  update?: UpdateBridge;
  remote?: RemoteBridge;
}

declare global {
  interface Window {
    cycle?: HostBridge;
  }
}

export const host = {
  pickDirectory(): Promise<string | null> | null {
    return window.cycle?.pickDirectory?.() ?? null;
  },
  notify(title: string, body: string): void {
    if (window.cycle?.notify) {
      window.cycle.notify(title, body);
      return;
    }
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const notification = new Notification(title, { body });
    notification.addEventListener("click", () => window.focus());
  },
  /** Asks once for leave to notify, where the browser needs asking. */
  prepareNotifications(): void {
    if (window.cycle?.notify || typeof Notification === "undefined") return;
    if (Notification.permission === "default") void Notification.requestPermission();
  },
  /** Opens a link outside the page. False when it was left to a browser, which may refuse. */
  openExternal(url: string): boolean {
    if (window.cycle?.openExternal) {
      window.cycle.openExternal(url);
      return true;
    }
    window.open(url, "_blank", "noopener,noreferrer");
    return false;
  },
  insetTitleBar: (): boolean => window.cycle?.insetTitleBar ?? false,
  /** Follows the app's updates. Nothing is ever said where the host has none, as in a browser. */
  watchUpdate(listener: (state: UpdateState) => void): void {
    const update = window.cycle?.update;
    if (!update) return;
    update.onState(listener);
    void update.state().then(listener, () => {});
  },
  checkForUpdate(): void {
    void window.cycle?.update?.check();
  },
  installUpdate(): void {
    void window.cycle?.update?.install();
  },
};

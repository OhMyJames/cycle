/**
 * What the page asks of whatever hosts it. The desktop app supplies a bridge
 * as `window.cycle`; a browser tab falls back to what the web platform has.
 */
export interface HostBridge {
  /** A native folder chooser, or null where there is none. */
  pickDirectory?: () => Promise<string | null>;
  notify?: (title: string, body: string) => void;
  openExternal?: (url: string) => void;
  /** Whether the window draws its own title bar, so the page leaves room for its buttons. */
  insetTitleBar?: boolean;
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
};

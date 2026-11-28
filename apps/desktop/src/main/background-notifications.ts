/** What of a window this needs. */
export type NotifyWindow = {
  isFocused(): boolean;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

/** What of Electron's Notification this needs. */
type NotificationLike = {
  show(): void;
  on(event: "click" | "close" | "failed", listener: () => void): unknown;
};

type NotificationContent = { title: string; subtitle?: string; body: string };

export type NotificationHost = {
  window: () => NotifyWindow | undefined;
  /** Whether the system can show notifications at all. */
  supported: () => boolean;
  create: (options: NotificationContent) => NotificationLike;
  /** Brings the whole app forward (on a Mac, a window shown is not enough while another app is in front). */
  activate: () => void;
};

/** Electron needs a strong reference until the notification is clicked, closed or fails. */
export class BackgroundNotifications {
  readonly #held = new Set<NotificationLike>();

  get size(): number {
    return this.#held.size;
  }

  /** False lets the caller retry when the window is no longer in front. Undefined means unsupported. */
  show(host: NotificationHost, content: () => NotificationContent, open: () => void) {
    const window = host.window();
    if (window === undefined || window.isDestroyed() || window.isFocused()) return false;
    if (!host.supported()) return undefined;
    const notification = host.create(content());
    this.#held.add(notification);
    const release = () => void this.#held.delete(notification);
    notification.on("close", release);
    notification.on("failed", release);
    notification.on("click", () => {
      release();
      const target = host.window();
      if (target === undefined || target.isDestroyed()) return;
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
      host.activate();
      open();
    });
    notification.show();
    return true;
  }
}

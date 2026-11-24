// Tells the person, with a notification, that a session wants them while the app is not in front of them. The parts that
// are Electron's (the window, Notification) come in as arguments, so this is tested without Electron, and the whole of what
// it decides is the few lines below.
import type { AppEvent, Translator } from "@cycle/ui";
import type { AttentionNotice } from "./watcher.ts";

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
export type NotificationLike = {
  show(): void;
  on(event: "click" | "close" | "failed", listener: () => void): unknown;
};

export type AttentionDeps = {
  window: () => NotifyWindow | undefined;
  /** Whether the system can show notifications at all. */
  supported: () => boolean;
  create: (options: { title: string; subtitle?: string; body: string }) => NotificationLike;
  /** Brings the whole app forward (on a Mac, a window shown is not enough while another app is in front). */
  activate: () => void;
  /** The language of what is said, asked for each notification: the person may have changed it since the start. */
  translator: () => Translator;
  emit: (event: AppEvent) => void;
};

/** The longest title of a notification: a session's title is the agent's or the daemon's word, and may be long. */
export const MAX_TITLE = 80;

const folderOf = (cwd: string): string => cwd.split("/").filter(Boolean).at(-1) ?? cwd;

/** One line, no longer than a notification can use; the folder when the title says nothing. */
export const titleOf = (notice: AttentionNotice): string => {
  const { session } = notice;
  const line = (session.title ?? "").replace(/\s+/g, " ").trim();
  const title = line === "" ? folderOf(session.cwd) : line;
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title;
};

// A notification that nothing refers to may be collected before it is pressed, and its click would never come (Electron says to
// keep a reference): they are held until they are pressed, closed, or fail.
const shown = new Set<NotificationLike>();

/**
 * The function the manager calls. While the window is in front the person can see the sidebar, and a notification would
 * only repeat it: it is for when they are elsewhere. Pressing it brings the window back and shows the session.
 */
export const notifyAttention = (deps: AttentionDeps) => (notice: AttentionNotice) => {
  const window = deps.window();
  if (window === undefined || window.isDestroyed() || window.isFocused()) return;
  if (!deps.supported()) return;
  const notification = deps.create({
    title: titleOf(notice),
    // Which machine, when it is not this one: the same title may be on two.
    ...(notice.environmentId === "local" ? {} : { subtitle: notice.environmentName }),
    body: deps.translator().t(`attention.${notice.kind}`),
  });
  shown.add(notification);
  const done = () => void shown.delete(notification);
  notification.on("close", done);
  notification.on("failed", done);
  notification.on("click", () => {
    done();
    const target = deps.window();
    if (target === undefined || target.isDestroyed()) return;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    deps.activate();
    deps.emit({
      type: "focus-session",
      environmentId: notice.environmentId,
      sessionId: notice.session.sessionId,
    });
  });
  notification.show();
};

/** How many notifications are being held, for the tests. */
export const heldNotifications = (): number => shown.size;

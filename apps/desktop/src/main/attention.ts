// Tells the person, with a notification, that a session wants them while the app is not in front of them. The parts that
// are Electron's (the window, Notification) come in as arguments, so this is tested without Electron, and the whole of what
// it decides is the few lines below.
import type { AppEvent, Translator } from "@cycle/ui";
import { BackgroundNotifications, type NotificationHost } from "./background-notifications.ts";
import type { AttentionNotice } from "./watcher.ts";

export type AttentionDeps = NotificationHost & {
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

const shown = new BackgroundNotifications();

/**
 * The function the manager calls. While the window is in front the person can see the sidebar, and a notification would
 * only repeat it: it is for when they are elsewhere. Pressing it brings the window back and shows the session.
 */
export const notifyAttention = (deps: AttentionDeps) => (notice: AttentionNotice) => {
  shown.show(
    deps,
    () => ({
      title: titleOf(notice),
      // Which machine, when it is not this one: the same title may be on two.
      ...(notice.locationId === "local" ? {} : { subtitle: notice.locationName }),
      body: deps.translator().t(`attention.${notice.kind}`),
    }),
    () => {
      deps.emit({
        type: "focus-session",
        locationId: notice.locationId,
        sessionId: notice.session.sessionId,
      });
    },
  );
};

/** How many notifications are being held, for the tests. */
export const heldNotifications = (): number => shown.size;

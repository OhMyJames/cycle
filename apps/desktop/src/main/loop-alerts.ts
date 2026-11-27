// Tells the person, with a system notification, that a ticket needs them: Blocked, or a review escalated to a person.
// A session waiting on a permission is NOT told here: the session's own attention notification (attention.ts) already
// does, and a second one would repeat it. Only a Notice that was not there at the last read is told, and the first
// read of a Project says nothing (it is what was already there), as `attentionOf` does for sessions.
import type { LoopNotice, LoopNoticesAnswer, LoopProjectInfo } from "@cycle/ui/api";
import type { NotificationLike, NotifyWindow } from "./attention.ts";

export type Alertable = LoopNotice & { kind: "blocked" | "review" };

const keyOf = (n: LoopNotice): string => `${n.kind}:${n.identifier}`;

/** The Notices to tell now: Blocked and review ones not in `before`. `before` undefined is the first read: nothing. */
export const newAlerts = (
  before: ReadonlySet<string> | undefined,
  notices: LoopNotice[],
): Alertable[] =>
  before === undefined
    ? []
    : notices.filter(
        (n): n is Alertable =>
          (n.kind === "blocked" || n.kind === "review") && !before.has(keyOf(n)),
      );

export type PollDeps = {
  projects: () => Promise<LoopProjectInfo[]>;
  read: (projectKey: string) => Promise<LoopNoticesAnswer>;
  /** `false`: it was not shown, and is offered again at the next look. */
  alert: (projectKey: string, notice: Alertable) => unknown;
};

const MAX_WITHHELD = 2;

/** One look at every Project. A Project that cannot be read keeps what was known of it: it is not "all clear". */
export const noticePoller = (deps: PollDeps) => {
  const seen = new Map<string, Set<string>>();
  /** How many looks a Notice was withheld at: the person at the window may have seen it on the page, so it is offered twice at most. */
  const withheld = new Map<string, number>();
  let running = false;
  const once = async (): Promise<void> => {
    let projects: LoopProjectInfo[];
    try {
      projects = await deps.projects();
    } catch {
      return;
    }
    // A Project that is gone is forgotten: when it is added again, its first read is a first read.
    const listed = new Set(projects.map((p) => p.projectKey));
    for (const key of [...seen.keys()]) if (!listed.has(key)) seen.delete(key);
    for (const { projectKey } of projects) {
      const answer = await deps.read(projectKey).catch(() => undefined);
      if (answer?.kind !== "ok") continue;
      const alerts = newAlerts(seen.get(projectKey), answer.notices);
      const known = new Set(answer.notices.map(keyOf));
      seen.set(projectKey, known);
      for (const notice of alerts) {
        try {
          // Not shown (the window is in front): not seen either, so it is told when the person has gone elsewhere.
          if (deps.alert(projectKey, notice) === false) {
            const id = `${projectKey}/${keyOf(notice)}`;
            const times = (withheld.get(id) ?? 0) + 1;
            withheld.set(id, times);
            if (times < MAX_WITHHELD) known.delete(keyOf(notice));
          }
        } catch {
          // A notification that cannot be shown is one missed, not a poll that failed.
        }
      }
    }
  };
  return {
    /** A tick that finds the one before still reading does nothing: two would tell the same new Notice twice. */
    async tick(): Promise<void> {
      if (running) return;
      running = true;
      try {
        await once();
      } finally {
        running = false;
      }
    },
  };
};

export type AlertDeps = {
  window: () => NotifyWindow | undefined;
  supported: () => boolean;
  create: (options: { title: string; body: string }) => NotificationLike;
  activate: () => void;
  say: (kind: Alertable["kind"]) => string;
  open: (projectKey: string, identifier: string) => void;
  track: (kind: Alertable["kind"]) => void;
};

const held = new Set<NotificationLike>();

/** The system notification for one Notice, only while the window is not in front: on the page the Notice is seen. */
export const showAlert = (deps: AlertDeps) => (projectKey: string, notice: Alertable) => {
  const window = deps.window();
  if (window === undefined || window.isDestroyed() || window.isFocused()) return false;
  if (!deps.supported()) return undefined;
  // Only the ticket's number: a Notice's text is the Loop server's words about it, not for a notification.
  const title = Array.from(notice.identifier).slice(0, 80).join("");
  const notification = deps.create({ title, body: deps.say(notice.kind) });
  held.add(notification);
  const done = () => void held.delete(notification);
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
    deps.open(projectKey, notice.identifier);
  });
  notification.show();
  deps.track(notice.kind);
  return true;
};

// Tells the person, with a system notification, that a ticket needs them: Blocked, escalated review, stuck run or stuck
// tracker write. A session waiting on a permission is NOT told here: the session's own attention notification
// (attention.ts) already does, and a second one would repeat it. Only a Notice that was not there at the last read is
// told, and the first read of a Project says nothing (it is what was already there), as `attentionOf` does for sessions.
import type { LoopNotice, LoopNoticesAnswer, LoopProjectInfo } from "@cycle/ui/api";
import { BackgroundNotifications, type NotificationHost } from "./background-notifications.ts";

export type Alertable = LoopNotice & {
  kind: "blocked" | "review" | "stuck" | "intent_stuck";
  identifier: string;
};

const keyOf = (n: LoopNotice): string => `${n.kind}:${n.identifier}`;

/**
 * The Notices to tell now: Blocked, review, stuck and intent_stuck ones not in `before`, deduplicated by kind+ticket
 * within the same poll batch (multiple stuck intents on one ticket fire one notification). `before` undefined is the
 * first read: nothing.
 */
export const newAlerts = (
  before: ReadonlySet<string> | undefined,
  notices: LoopNotice[],
): Alertable[] => {
  if (before === undefined) return [];
  const seen = new Set<string>();
  const out: Alertable[] = [];
  for (const n of notices) {
    if (
      n.kind !== "blocked" &&
      n.kind !== "review" &&
      n.kind !== "stuck" &&
      n.kind !== "intent_stuck"
    )
      continue;
    // These four always name a ticket; one that does not has nothing to tell.
    if (n.identifier === null) continue;
    const key = keyOf(n);
    if (before.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(n as Alertable);
  }
  return out;
};

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

export type AlertDeps = NotificationHost & {
  say: (kind: Alertable["kind"]) => string;
  open: (projectKey: string, identifier: string) => void;
  track: (kind: Alertable["kind"]) => void;
};

const held = new BackgroundNotifications();

/** The system notification for one Notice, only while the window is not in front: on the page the Notice is seen. */
export const showAlert = (deps: AlertDeps) => (projectKey: string, notice: Alertable) => {
  const shown = held.show(
    deps,
    () => ({
      // The ticket number identifies the Notice without exposing its text.
      title: Array.from(notice.identifier).slice(0, 80).join(""),
      body: deps.say(notice.kind),
    }),
    () => deps.open(projectKey, notice.identifier),
  );
  if (shown) deps.track(notice.kind);
  return shown;
};

import { useEffect, useMemo, useRef, useState } from "react";
import type { LocationConfig, LocationStatus, SessionSummary } from "../api.ts";
import {
  currentWorkspace,
  elsewhere as elsewhereOf,
  sessionKey,
  sessionList,
  type Workspace,
  workspacesOf,
} from "../sessions.ts";
import { BLANK_KEY, type BlankConversation } from "../store/index.ts";
import { useI18n } from "./i18n.tsx";
import { useDay, useInFront } from "./in-front.ts";
import type { Away } from "./session-list.tsx";
import { LOCATION_STATE } from "./status.tsx";
import { useAppStore } from "./store-context.tsx";

/**
 * Where the person is among the sessions: the workspaces, the one the sidebar shows and its list, and what is open in
 * it. The list on screen and the keys that walk it (Cmd+[ and Cmd+]) are one thing.
 */
export function useSessionNavigation({
  locations,
  status,
  sessions,
  session,
  blank,
  pinned,
}: {
  locations: LocationConfig[];
  status: Record<string, LocationStatus>;
  /** The sessions of every location, in one list. */
  sessions: SessionSummary[];
  /** The session that is open. */
  session: SessionSummary | undefined;
  blank: BlankConversation | undefined;
  pinned: ReadonlySet<string>;
}) {
  const { t } = useI18n();
  const [showArchived, setShowArchived] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // The workspace chosen in the switcher holds until something else is opened: it is only good for the open session it was chosen on.
  const [chosen, setChosen] = useState<{ workspace: string; on: string | undefined } | undefined>(
    undefined,
  );
  // A location that is not connected: its sessions are the last it gave, and are shown greyed.
  const away = useMemo(() => {
    const map = new Map<string, Away>();
    for (const h of locations) {
      const state = status[h.id]?.state ?? "closed";
      if (state !== "connected")
        map.set(h.id, { name: h.name, word: t(LOCATION_STATE[state].word) });
    }
    return map;
  }, [locations, status, t]);
  const locationLabels = useMemo(
    () => locations.map((h) => ({ id: h.id, name: h.name, local: h.kind === "local" })),
    [locations],
  );
  const awayLocations = useMemo(() => new Set(away.keys()), [away]);
  const workspaces = useMemo(
    () =>
      workspacesOf(sessions, {
        locations: locationLabels,
        away: awayLocations,
        showArchived,
      }),
    [sessions, locationLabels, awayLocations, showArchived],
  );
  // A blank conversation is open in place of a session: the sidebar shows its folder, if it has sessions there.
  const openKey =
    session !== undefined ? sessionKey(session) : blank !== undefined ? BLANK_KEY : undefined;
  // The folders a blank conversation offers: those its location has sessions in that are not archived, newest first,
  // named among themselves only (one location: no location's name after them), whatever the sidebar shows.
  const blankLocation = blank?.locationId;
  const blankRecent = useMemo(
    () =>
      blankLocation === undefined
        ? []
        : workspacesOf(sessions.filter((s) => s.locationId === blankLocation))
            .filter((w) => w.cwd !== "")
            .slice(0, 8)
            .map((w) => ({ cwd: w.cwd, name: w.name })),
    [sessions, blankLocation],
  );
  const current = currentWorkspace(workspaces, {
    chosen: chosen !== undefined && chosen.on === openKey ? chosen.workspace : undefined,
    open: session ?? blank,
  });
  // Another workspace shown: its list starts short again. Set while drawing, the previous value kept in state, so the
  // list that is drawn is already the short one (CYCL-248).
  const [shownWorkspace, setShownWorkspace] = useState(current?.key);
  if (shownWorkspace !== current?.key) {
    setShownWorkspace(current?.key);
    if (showAll) setShowAll(false);
  }
  // A new session starts in the workspace that is shown, if its location can have one started.
  const startOn =
    current !== undefined && status[current.locationId]?.state === "connected"
      ? current
      : undefined;
  const elsewhere = useMemo(() => elsewhereOf(workspaces, current), [workspaces, current]);
  const day = useDay();
  const list = useMemo(
    () =>
      sessionList(current?.sessions ?? [], {
        showAll,
        selected: openKey,
        away: awayLocations,
        pinned,
        now: new Date(day),
      }),
    [current, showAll, openKey, awayLocations, pinned, day],
  );

  return {
    away,
    workspaces,
    current,
    elsewhere,
    list,
    openKey,
    blankRecent,
    startOn,
    showArchived,
    setShowArchived,
    showAllSessions: () => setShowAll(true),
    /** A workspace picked in the switcher: shown while what is open stays open. */
    chooseWorkspace: (workspace: string) => setChosen({ workspace, on: openKey }),
    /** What is open next is shown with its own workspace, also when it is the session already open. */
    followOpen: () => setChosen(undefined),
  };
}

/**
 * Whether the shown workspace's folder is trusted, when its daemon can say. Read again as a dialog closes (it may have
 * been decided there), and after `changeTrust`.
 */
export function useWorkspaceTrust(
  current: Workspace | undefined,
  status: Record<string, LocationStatus>,
  dialogOpen: boolean,
) {
  const store = useAppStore();
  const trustLocation =
    current !== undefined &&
    status[current.locationId]?.state === "connected" &&
    status[current.locationId]?.capabilities?.trust === true
      ? current.locationId
      : undefined;
  const trustCwd = trustLocation !== undefined ? current?.cwd : undefined;
  const [trust, setTrust] = useState<{ key: string; trusted: boolean | null } | undefined>();
  const [trustRevision, setTrustRevision] = useState(0);
  const trustKey =
    trustLocation !== undefined && trustCwd !== undefined
      ? `${trustLocation}\u0000${trustCwd}\u0000${trustRevision}\u0000${!dialogOpen}`
      : undefined;
  useEffect(() => {
    if (trustKey === undefined || trustLocation === undefined || trustCwd === undefined) return;
    let live = true;
    store.readTrust(trustLocation, trustCwd).then(
      (read) => {
        if (live) setTrust({ key: trustKey, trusted: read.trusted });
      },
      // Not offered when it cannot be read (the folder is gone): there is nothing to decide on.
      () => {
        if (live) setTrust(undefined);
      },
    );
    return () => {
      live = false;
    };
  }, [store, trustKey, trustLocation, trustCwd]);
  const shownTrust = trust !== undefined && trust.key === trustKey ? trust.trusted : undefined;
  const folder =
    trustLocation !== undefined && trustCwd !== undefined
      ? { locationId: trustLocation, cwd: trustCwd }
      : undefined;
  /** Changes the folder's trust, and reads it again. */
  const changeTrust = async (trusted: boolean) => {
    if (folder === undefined) return;
    await store.changeTrust(folder.locationId, folder.cwd, trusted);
    setTrustRevision((n) => n + 1);
  };
  return { folder, trusted: shownTrust, changeTrust };
}

/**
 * What is on screen has been seen: the daemon is told, so the mark goes and stays gone (also on another client). Only
 * while the app is in front, and only for a daemon that says there is news.
 */
export function useMarkRead(
  session: SessionSummary | undefined,
  status: Record<string, LocationStatus>,
) {
  const store = useAppStore();
  const inFront = useInFront();
  // Once for what the list says (the session, how far it goes, and whether the app is in front): a daemon that refuses it
  // would otherwise be asked again for each new list, and each ask lists again.
  const told = useRef("");
  useEffect(() => {
    if (session?.unread !== true || !inFront) return;
    if (status[session.locationId]?.state !== "connected") return;
    const what = `${session.locationId}/${session.sessionId}/${session.lastSeq}`;
    if (told.current === what) return;
    told.current = what;
    void store.markRead(session.locationId, session.sessionId);
  }, [session, inFront, status, store]);
  // Leaving the app and coming back asks again.
  useEffect(() => {
    if (!inFront) told.current = "";
  }, [inFront]);
}

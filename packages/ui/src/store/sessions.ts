// The sessions: each one's view as main's events build it, and what the person does in the one that is open.
import type {
  AppEvent,
  FileContent,
  FileListing,
  FileSearch,
  FormAnswer,
  PromptBlock,
  SendVia,
  SessionSnapshot,
  SessionSummary,
  UnsavedWork,
  WorkspacePatch,
  WorkspaceStatus,
} from "../api.ts";
import { againBlocks, promptBlocks, returnedId } from "../draft.ts";
import { applyUpdate, emptyConversation, type Resend, type Returned } from "../model/index.ts";
import { messageOf, type StoreKit } from "./core.ts";
import { type SessionView, viewKey } from "./state.ts";

/** An event of one session's view: each comes with the version of main's state it brings that view to. */
type SessionEvent = AppEvent & { type: "update" | "permission" | "permission-closed" };

const applyToView = (view: SessionView, event: SessionEvent): SessionView => {
  if (event.type === "update") {
    return {
      ...view,
      conversation: applyUpdate(view.conversation, event.update, { at: event.at }),
      version: event.version,
    };
  }
  if (event.type === "permission") {
    // A request asked again (after a reconnect) keeps its place: they are answered one at a time, in the order they came,
    // and the one on screen must not change under the person's click.
    const at = view.permissions.findIndex((p) => p.key === event.request.key);
    const permissions =
      at === -1
        ? [...view.permissions, event.request]
        : view.permissions.map((p, i) => (i === at ? event.request : p));
    return { ...view, permissions, version: event.version };
  }
  return {
    ...view,
    permissions: view.permissions.filter((p) => p.key !== event.key),
    version: event.version,
  };
};

export class SessionsSlice {
  readonly #kit: StoreKit;
  /** Events about a session that is still being opened, held until its snapshot is in. */
  readonly #held = new Map<string, SessionEvent[]>();
  readonly #acks = new WeakSet<Returned>();
  /** View keys, least recently used first: a view is used when it is set or its session is selected. */
  #recent: string[] = [];
  /** The latest read started for each session: an older one that comes back later is dropped. */
  readonly #latestLoad = new Map<string, number>();
  #loads = 0;
  /**
   * Sessions whose box holds a message put back to send again, with what the box then held: whether it went as it was
   * is counted when it is sent. Forgotten when the box is emptied without sending it.
   */
  readonly #resending = new Map<string, { turn: number; sent: string }>();

  constructor(kit: StoreKit) {
    this.#kit = kit;
    const { drafts } = kit;
    // A message put back to send again and then cleared away was not sent again: what is sent next is something else.
    drafts.subscribe(() => {
      for (const key of this.#resending.keys()) {
        if (promptBlocks(drafts.get(key)) === undefined) this.#resending.delete(key);
      }
    });
  }

  /** The session in view, if one is. */
  #open(): { locationId: string; sessionId: string } | undefined {
    const { selectedLocation: locationId, selectedSession: sessionId } = this.#kit.state();
    if (locationId === undefined || sessionId === undefined) return undefined;
    return { locationId, sessionId };
  }

  /** An event of a session's view, as main told it. True when it was applied to a view that is up to date. */
  onEvent(event: SessionEvent): boolean {
    const key =
      event.type === "permission"
        ? viewKey(event.request.locationId, event.request.sessionId)
        : viewKey(event.locationId, event.sessionId);
    const view = this.#kit.state().views[key];
    if (view === undefined) return false;
    if (view.loading) {
      this.#held.set(key, [...(this.#held.get(key) ?? []), event]);
      return false;
    }
    if (event.version <= view.version) return false;
    if (event.version > view.version + 1) {
      // One was missed. Ask main for the session again rather than show something wrong.
      void this.#kit.attempt(() => this.#load(view.locationId, view.sessionId));
      return false;
    }
    this.#setView(key, applyToView(view, event));
    return true;
  }

  #setView(key: string, view: SessionView): void {
    this.#takeBack(key, view);
    this.#kit.set((s) => ({ views: { ...s.views, [key]: view } }));
    this.#touch(key);
  }

  /** Marks a view as just used, then drops the least recently used ones beyond the cap. */
  #touch(key: string): void {
    this.#recent = [...this.#recent.filter((k) => k !== key), key];
    this.#evict();
  }

  /**
   * Keeps at most `maxViews` views. Never dropped: the selected session's, and one still being read (its read would
   * only put it back). Among the rest the least recently used goes first, but a view with a permission request waiting
   * is kept for as long as any other can go instead: the request would be lost with it. If only such views are left
   * over the cap, the oldest of them goes: the cap is a promise about memory. A dropped session is read again when
   * selected; an event for it is ignored meanwhile (`onEvent` finds no view).
   */
  #evict(): void {
    const { views, selectedLocation, selectedSession } = this.#kit.state();
    this.#recent = this.#recent.filter((k) => views[k] !== undefined);
    let over = Object.keys(views).length - this.#kit.maxViews;
    if (over <= 0) return;
    const selected =
      selectedLocation !== undefined && selectedSession !== undefined
        ? viewKey(selectedLocation, selectedSession)
        : undefined;
    const known = new Set(this.#recent);
    // A view somehow without a place in the order is the oldest.
    const order = [...Object.keys(views).filter((k) => !known.has(k)), ...this.#recent];
    const candidates = order.filter((k) => k !== selected && views[k]?.loading !== true);
    const dropped = new Set<string>();
    for (const waiting of [false, true]) {
      for (const key of candidates) {
        if (over <= 0) break;
        if ((views[key]?.permissions.length ?? 0) > 0 !== waiting) continue;
        dropped.add(key);
        over--;
      }
    }
    if (dropped.size === 0) return;
    for (const key of dropped) {
      this.#held.delete(key);
      this.#latestLoad.delete(key);
    }
    this.#recent = this.#recent.filter((k) => !dropped.has(k));
    this.#kit.set((s) => ({
      views: Object.fromEntries(Object.entries(s.views).filter(([k]) => !dropped.has(k))),
    }));
  }

  /**
   * What the daemon handed back (a stop, an error) goes into that session's box, whether or not it is the one in
   * view, once: a reload of the page finds the same hand-back and does not put it there again.
   */
  #takeBack(key: string, view: SessionView): void {
    const returned = view.conversation.returned;
    if (returned === undefined || view.loading) return;
    const { drafts, bridge } = this.#kit;
    const id = returnedId(returned.prompts);
    if (!drafts.handled(key, id)) {
      drafts.restore(
        key,
        returned.prompts.map((p) => p.prompt),
        id,
      );
    }
    if (returned.returnId && !this.#acks.has(returned)) {
      this.#acks.add(returned);
      void bridge.ackReturn(view.locationId, view.sessionId, returned.returnId).catch(() => {
        this.#acks.delete(returned);
      });
    }
  }

  /**
   * Reads a session from main whole, then applies the events that came while it was being read. A read that was
   * started by a newer one for the same session is dropped; so is, with `onlyIfSelected`, one whose session is no longer
   * the selected one when it comes back (quick switching: only the last one chosen is taken). A dropped read leaves
   * nothing: its placeholder goes, or the view that was there before comes back, and its held events are cleared.
   */
  async #load(locationId: string, sessionId: string, onlyIfSelected = false): Promise<void> {
    const key = viewKey(locationId, sessionId);
    const existing = this.#kit.state().views[key];
    const id = ++this.#loads;
    this.#latestLoad.set(key, id);
    const dropped = (): boolean => {
      if (this.#latestLoad.get(key) !== id) return true; // Another read of it took over, and cleans up.
      const { selectedLocation, selectedSession } = this.#kit.state();
      if (!onlyIfSelected || (selectedLocation === locationId && selectedSession === sessionId))
        return false;
      this.#latestLoad.delete(key);
      this.#held.delete(key);
      if (existing !== undefined && !existing.loading) this.#setView(key, existing);
      else
        this.#kit.set((s) => {
          const { [key]: _gone, ...views } = s.views;
          return { views };
        });
      return true;
    };
    this.#held.set(key, []);
    this.#setView(key, {
      locationId,
      sessionId,
      conversation: existing?.conversation ?? emptyConversation(),
      permissions: existing?.permissions ?? [],
      version: existing?.version ?? -1,
      loading: true,
    });
    let snapshot: SessionSnapshot;
    try {
      snapshot = await this.#kit.bridge.openSession(locationId, sessionId);
    } catch (error) {
      if (dropped()) return;
      this.#latestLoad.delete(key);
      this.#held.delete(key);
      // What was read before is still what there is: a re-read that failed does not take the conversation away.
      // (Not the placeholder of a read still going: that has nothing in it.) Version -1: the next event asks again.
      if (existing !== undefined && !existing.loading)
        this.#setView(key, { ...existing, loading: false, version: -1 });
      else
        this.#kit.set((s) => {
          const { [key]: _gone, ...views } = s.views;
          return { views };
        });
      throw error;
    }
    if (dropped()) return;
    this.#latestLoad.delete(key);
    let view: SessionView = {
      locationId,
      sessionId,
      conversation: snapshot.conversation,
      permissions: snapshot.permissions,
      version: snapshot.version,
      loading: false,
    };
    for (const event of this.#held.get(key) ?? []) {
      if (event.version === view.version + 1) view = applyToView(view, event);
    }
    this.#held.delete(key);
    this.#setView(key, view);
  }

  /** Shows a session of any location: a notification about it was pressed. */
  focus = async (locationId: string, sessionId: string): Promise<void> => {
    if (!this.#kit.state().sessions[locationId]?.some((s) => s.sessionId === sessionId)) return;
    await this.select(locationId, sessionId);
  };

  /**
   * Opens a session, on the location it is on. A location that is away still lists its sessions, as they were: one that was
   * open before can be read again, as it was; one that was not has nothing to show, and the person is told why.
   */
  select = async (locationId: string, sessionId: string): Promise<void> => {
    const { state: now, set, attempt } = this.#kit;
    const state = now().status[locationId]?.state;
    if (state !== "connected" && now().views[viewKey(locationId, sessionId)] === undefined) {
      const name = now().locations.find((h) => h.id === locationId)?.name ?? locationId;
      set({ error: { key: "session.awayCannotOpen", params: { location: name } } });
      return;
    }
    set({ selectedLocation: locationId, selectedSession: sessionId, blank: undefined });
    this.#touch(viewKey(locationId, sessionId));
    if (state === "connected") await attempt(() => this.#load(locationId, sessionId, true));
  };

  /**
   * Sends what the open session's box holds: its text, and the images attached to it. The box is empty from the moment
   * it goes; if it cannot go, what was in it comes back, in front of anything written since. `steer`: while the agent
   * works, into the turn that is running instead of the queue.
   */
  async send(options: { steer?: boolean; via?: SendVia } = {}): Promise<void> {
    const open = this.#open();
    if (open === undefined) return;
    const { locationId, sessionId } = open;
    const { drafts, bridge, attempt, track } = this.#kit;
    const key = viewKey(locationId, sessionId);
    const content: PromptBlock[] | undefined = promptBlocks(drafts.get(key));
    if (content === undefined) return;
    const resending = this.#resending.get(key);
    this.#resending.delete(key);
    drafts.clear(key);
    const sent = await attempt(async () => {
      const how = {
        ...(options.steer === true ? { steer: true } : {}),
        ...(options.via !== undefined ? { via: options.via } : {}),
      };
      if (Object.keys(how).length > 0) await bridge.prompt(locationId, sessionId, content, how);
      else await bridge.prompt(locationId, sessionId, content);
      return true;
    });
    if (sent !== true) {
      drafts.restore(key, [content]);
      if (resending !== undefined) this.#resending.set(key, resending);
    } else if (resending !== undefined) {
      track("turn_resent", { edited: JSON.stringify(content) !== resending.sent });
    }
  }

  /**
   * "Edit message" on a turn that failed (DESIGN.md 4.4): what was said in it goes back in front of the box, and the box takes
   * the focus. Nothing is sent: the person reads it, may change it, and sends it as any message, asked for permissions
   * afresh. Only for the session in view.
   */
  resend = (resend: Resend): void => {
    const open = this.#open();
    if (open === undefined) return;
    const { drafts, set, track } = this.#kit;
    const key = viewKey(open.locationId, open.sessionId);
    // Already in the box, and neither sent nor cleared away since: a second press only shows it, it does not add it again.
    if (this.#resending.get(key)?.turn !== resend.turn) {
      drafts.restore(key, resend.prompts);
      this.#resending.set(key, {
        turn: resend.turn,
        sent: JSON.stringify(promptBlocks(drafts.get(key)) ?? null),
      });
      track("turn_resend_opened", {
        failure: resend.failure,
        changed: resend.changed.length > 0,
      });
    }
    set((s) => ({ composerFocus: s.composerFocus + 1 }));
  };

  /**
   * "Try again" on a turn that failed: what was said in it is sent again as it was, in one go (the person was asked
   * first if the turn had already run a command or changed a file; `changed` says so). Only for the session in view,
   * while its location is connected and the agent is not at work. If it cannot go, it comes back in the box, so
   * nothing is lost. Resolves when the daemon has answered.
   */
  retry = async (resend: Resend): Promise<boolean> => {
    const open = this.#open();
    if (open === undefined || resend.busy) return false;
    const { locationId, sessionId } = open;
    const { state, bridge, attempt, drafts, track } = this.#kit;
    if (state().status[locationId]?.state !== "connected") return false;
    const content = againBlocks(resend.prompts);
    if (content === undefined) return false;
    const sent = await attempt(async () => {
      await bridge.prompt(locationId, sessionId, content, { via: "button" });
      return true;
    });
    if (sent !== true) {
      drafts.restore(viewKey(locationId, sessionId), [content]);
      return false;
    }
    // Counted once it went, like `turn_resent`: a retry that could not be sent is not one.
    track("turn_retried", { failure: resend.failure, changed: resend.changed.length > 0 });
    return true;
  };

  /** What fits an @ in the selected session's box. Quiet when it cannot say: a menu that is not there is enough. */
  searchFiles = async (query: string): Promise<FileSearch | undefined> => {
    const state = this.#kit.state();
    const { selectedLocation: locationId, selectedSession: sessionId, blank } = state;
    // A blank conversation has no session yet: it looks in the folder it has chosen, if the daemon can.
    const where =
      blank !== undefined
        ? blank.cwd.trim() !== "" &&
          state.status[blank.locationId]?.capabilities?.filesInFolder === true
          ? { cwd: blank.cwd.trim() }
          : undefined
        : sessionId !== undefined
          ? { sessionId }
          : undefined;
    const on = blank?.locationId ?? locationId;
    if (on === undefined || where === undefined) return undefined;
    try {
      return await this.#kit.bridge.searchFiles(on, where, query);
    } catch {
      return undefined;
    }
  };

  /** One folder of a session's folder, for the Files tab. The caller says why it failed. */
  listFiles = (locationId: string, sessionId: string, path: string): Promise<FileListing> =>
    this.#kit.bridge.listFiles(locationId, sessionId, path);

  /** A file of a session's folder, text from `offset`. The caller says why it failed. */
  readFile = (
    locationId: string,
    sessionId: string,
    path: string,
    offset?: number,
  ): Promise<FileContent> => this.#kit.bridge.readFile(locationId, sessionId, path, offset);

  /** A session's folder against HEAD, for the Diff tab. The caller says why it failed. */
  workspaceStatus = (locationId: string, sessionId: string): Promise<WorkspaceStatus> =>
    this.#kit.bridge.workspaceStatus(locationId, sessionId);

  /** One file's patch against HEAD. The caller says why it failed. */
  workspaceFile = (locationId: string, sessionId: string, path: string): Promise<WorkspacePatch> =>
    this.#kit.bridge.workspaceFile(locationId, sessionId, path);

  /** Takes a queued prompt back to edit it. Undefined if it had gone to the agent, or came back, meanwhile. */
  dequeue = async (queueId: string): Promise<PromptBlock[] | undefined> => {
    const open = this.#open();
    if (open === undefined) return undefined;
    const { locationId, sessionId } = open;
    const blocks = await this.#kit.attempt(() =>
      this.#kit.bridge.dequeue(locationId, sessionId, queueId),
    );
    if (blocks !== undefined) this.#kit.drafts.restore(viewKey(locationId, sessionId), [blocks]);
    return blocks;
  };

  cancel = async (): Promise<void> => {
    const open = this.#open();
    if (open === undefined) return;
    await this.#kit.attempt(() => this.#kit.bridge.cancel(open.locationId, open.sessionId));
  };

  setConfig = async (configId: string, value: string): Promise<void> => {
    const open = this.#open();
    if (open === undefined) return;
    await this.#kit.attempt(() =>
      this.#kit.bridge.setSessionConfig(open.locationId, open.sessionId, configId, value),
    );
  };

  /** Answers with why it failed, or nothing. A row of the sidebar names its own location; the header is the open one's. */
  rename = async (
    sessionId: string,
    title: string,
    where: "header" | "sidebar" = "header",
    locationId = this.#kit.state().selectedLocation,
  ): Promise<string | undefined> => {
    if (locationId === undefined) return undefined;
    try {
      await this.#kit.bridge.renameSession(locationId, sessionId, title, where);
      return undefined;
    } catch (error) {
      return messageOf(error);
    }
  };

  dismissBackground = async (session: SessionSummary, only?: string[]): Promise<void> => {
    const ids = only ?? session.unknownBackground;
    if (ids?.length)
      await this.#kit.attempt(() =>
        this.#kit.bridge.dismissBackground(session.locationId, session.sessionId, ids),
      );
  };

  /**
   * Stops one sub-agent of the open session (CYCL-143). Its end shows on its card as the agent tells it. True: it is
   * being stopped; false: there was nothing to stop (it ended, or the agent that ran it is gone); undefined: the ask
   * failed, and the error is shown.
   */
  stopSubagent = async (childId: string, background: boolean): Promise<boolean | undefined> => {
    const open = this.#open();
    if (open === undefined) return undefined;
    return await this.#kit.attempt(() =>
      this.#kit.bridge.stopSubagent(open.locationId, open.sessionId, childId, background),
    );
  };

  /** A session of the open one's location, or of `locationId`, as a row of the sidebar names its own. */
  archive = async (
    sessionId: string,
    archived: boolean,
    locationId = this.#kit.state().selectedLocation,
  ): Promise<void> => {
    if (locationId === undefined) return;
    await this.#kit.attempt(() => this.#kit.bridge.archiveSession(locationId, sessionId, archived));
  };

  /**
   * The person is looking at the session: tell the daemon it has been seen. Nothing to show if it cannot be told (the
   * mark stays, and is asked again when something new comes in or the app comes back to the front): a mark is not worth an error banner.
   */
  markRead = async (locationId: string, sessionId: string): Promise<void> => {
    try {
      await this.#kit.bridge.markRead(locationId, sessionId);
    } catch {
      // Not worth a banner.
    }
  };

  delete = async (
    sessionId: string,
    locationId = this.#kit.state().selectedLocation,
    discardWorktree = false,
  ): Promise<string | UnsavedWork | undefined> => {
    if (locationId === undefined) return undefined;
    try {
      const refused = discardWorktree
        ? await this.#kit.bridge.deleteSession(locationId, sessionId, true)
        : await this.#kit.bridge.deleteSession(locationId, sessionId);
      // Its worktree holds work nothing else has: what would be lost goes back, to ask the person.
      if (refused !== undefined) return refused.unsaved;
      this.forget(locationId, sessionId);
      return undefined;
    } catch (error) {
      return messageOf(error);
    }
  };

  /** A session that no longer exists: its view, its draft and its place as the selected one go. */
  forget(locationId: string, sessionId: string): void {
    const key = viewKey(locationId, sessionId);
    this.#kit.drafts.forget(key);
    this.#kit.sidePanels.forget(key);
    this.#kit.filesViews.forget(key);
    this.#held.delete(key);
    this.#latestLoad.delete(key);
    this.#kit.set((s) => {
      const { [key]: _gone, ...views } = s.views;
      const { [key]: _closed, ...terminals } = s.terminals;
      return {
        views,
        terminals,
        selectedSession:
          s.selectedLocation === locationId && s.selectedSession === sessionId
            ? undefined
            : s.selectedSession,
      };
    });
  }

  answerPermission = async (key: string, optionId: string | "cancelled"): Promise<void> => {
    await this.#kit.attempt(() => this.#kit.bridge.answerPermission(key, optionId));
  };

  answerForm = async (key: string, answer: FormAnswer): Promise<void> => {
    await this.#kit.attempt(() => this.#kit.bridge.answerForm(key, answer));
  };
}

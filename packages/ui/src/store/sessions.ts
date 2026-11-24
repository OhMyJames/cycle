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
  #open(): { environmentId: string; sessionId: string } | undefined {
    const { selectedEnvironment: environmentId, selectedSession: sessionId } = this.#kit.state();
    if (environmentId === undefined || sessionId === undefined) return undefined;
    return { environmentId, sessionId };
  }

  /** An event of a session's view, as main told it. True when it was applied to a view that is up to date. */
  onEvent(event: SessionEvent): boolean {
    const key =
      event.type === "permission"
        ? viewKey(event.request.environmentId, event.request.sessionId)
        : viewKey(event.environmentId, event.sessionId);
    const view = this.#kit.state().views[key];
    if (view === undefined) return false;
    if (view.loading) {
      this.#held.set(key, [...(this.#held.get(key) ?? []), event]);
      return false;
    }
    if (event.version <= view.version) return false;
    if (event.version > view.version + 1) {
      // One was missed. Ask main for the session again rather than show something wrong.
      void this.#kit.attempt(() => this.#load(view.environmentId, view.sessionId));
      return false;
    }
    this.#setView(key, applyToView(view, event));
    return true;
  }

  #setView(key: string, view: SessionView): void {
    this.#takeBack(key, view);
    this.#kit.set((s) => ({ views: { ...s.views, [key]: view } }));
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
      void bridge.ackReturn(view.environmentId, view.sessionId, returned.returnId).catch(() => {
        this.#acks.delete(returned);
      });
    }
  }

  /** Reads a session from main whole, then applies the events that came while it was being read. */
  async #load(environmentId: string, sessionId: string): Promise<void> {
    const key = viewKey(environmentId, sessionId);
    const existing = this.#kit.state().views[key];
    this.#held.set(key, []);
    this.#setView(key, {
      environmentId,
      sessionId,
      conversation: existing?.conversation ?? emptyConversation(),
      permissions: existing?.permissions ?? [],
      version: existing?.version ?? -1,
      loading: true,
    });
    let snapshot: SessionSnapshot;
    try {
      snapshot = await this.#kit.bridge.openSession(environmentId, sessionId);
    } catch (error) {
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
    let view: SessionView = {
      environmentId,
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

  /** Shows a session of any environment: a notification about it was pressed. */
  focus = async (environmentId: string, sessionId: string): Promise<void> => {
    if (!this.#kit.state().sessions[environmentId]?.some((s) => s.sessionId === sessionId)) return;
    await this.select(environmentId, sessionId);
  };

  /**
   * Opens a session, on the environment it is on. An environment that is away still lists its sessions, as they were: one that was
   * open before can be read again, as it was; one that was not has nothing to show, and the person is told why.
   */
  select = async (environmentId: string, sessionId: string): Promise<void> => {
    const { state: now, set, attempt } = this.#kit;
    const state = now().status[environmentId]?.state;
    if (state !== "connected" && now().views[viewKey(environmentId, sessionId)] === undefined) {
      const name = now().environments.find((h) => h.id === environmentId)?.name ?? environmentId;
      set({ error: { key: "session.awayCannotOpen", params: { environment: name } } });
      return;
    }
    set({ selectedEnvironment: environmentId, selectedSession: sessionId, blank: undefined });
    if (state === "connected") await attempt(() => this.#load(environmentId, sessionId));
  };

  /**
   * Sends what the open session's box holds: its text, and the images attached to it. The box is empty from the moment
   * it goes; if it cannot go, what was in it comes back, in front of anything written since. `steer`: while the agent
   * works, into the turn that is running instead of the queue.
   */
  async send(options: { steer?: boolean; via?: SendVia } = {}): Promise<void> {
    const open = this.#open();
    if (open === undefined) return;
    const { environmentId, sessionId } = open;
    const { drafts, bridge, attempt, track } = this.#kit;
    const key = viewKey(environmentId, sessionId);
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
      if (Object.keys(how).length > 0) await bridge.prompt(environmentId, sessionId, content, how);
      else await bridge.prompt(environmentId, sessionId, content);
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
    const key = viewKey(open.environmentId, open.sessionId);
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
   * while its environment is connected and the agent is not at work. If it cannot go, it comes back in the box, so
   * nothing is lost. Resolves when the daemon has answered.
   */
  retry = async (resend: Resend): Promise<boolean> => {
    const open = this.#open();
    if (open === undefined || resend.busy) return false;
    const { environmentId, sessionId } = open;
    const { state, bridge, attempt, drafts, track } = this.#kit;
    if (state().status[environmentId]?.state !== "connected") return false;
    const content = againBlocks(resend.prompts);
    if (content === undefined) return false;
    const sent = await attempt(async () => {
      await bridge.prompt(environmentId, sessionId, content, { via: "button" });
      return true;
    });
    if (sent !== true) {
      drafts.restore(viewKey(environmentId, sessionId), [content]);
      return false;
    }
    // Counted once it went, like `turn_resent`: a retry that could not be sent is not one.
    track("turn_retried", { failure: resend.failure, changed: resend.changed.length > 0 });
    return true;
  };

  /** What fits an @ in the selected session's box. Quiet when it cannot say: a menu that is not there is enough. */
  searchFiles = async (query: string): Promise<FileSearch | undefined> => {
    const state = this.#kit.state();
    const { selectedEnvironment: environmentId, selectedSession: sessionId, blank } = state;
    // A blank conversation has no session yet: it looks in the folder it has chosen, if the daemon can.
    const where =
      blank !== undefined
        ? blank.cwd.trim() !== "" &&
          state.status[blank.environmentId]?.capabilities?.filesInFolder === true
          ? { cwd: blank.cwd.trim() }
          : undefined
        : sessionId !== undefined
          ? { sessionId }
          : undefined;
    const on = blank?.environmentId ?? environmentId;
    if (on === undefined || where === undefined) return undefined;
    try {
      return await this.#kit.bridge.searchFiles(on, where, query);
    } catch {
      return undefined;
    }
  };

  /** One folder of a session's folder, for the Files tab. The caller says why it failed. */
  listFiles = (environmentId: string, sessionId: string, path: string): Promise<FileListing> =>
    this.#kit.bridge.listFiles(environmentId, sessionId, path);

  /** A file of a session's folder, text from `offset`. The caller says why it failed. */
  readFile = (
    environmentId: string,
    sessionId: string,
    path: string,
    offset?: number,
  ): Promise<FileContent> => this.#kit.bridge.readFile(environmentId, sessionId, path, offset);

  /** A session's folder against HEAD, for the Diff tab. The caller says why it failed. */
  workspaceStatus = (environmentId: string, sessionId: string): Promise<WorkspaceStatus> =>
    this.#kit.bridge.workspaceStatus(environmentId, sessionId);

  /** One file's patch against HEAD. The caller says why it failed. */
  workspaceFile = (
    environmentId: string,
    sessionId: string,
    path: string,
  ): Promise<WorkspacePatch> => this.#kit.bridge.workspaceFile(environmentId, sessionId, path);

  /** Takes a queued prompt back to edit it. Undefined if it had gone to the agent, or came back, meanwhile. */
  dequeue = async (queueId: string): Promise<PromptBlock[] | undefined> => {
    const open = this.#open();
    if (open === undefined) return undefined;
    const { environmentId, sessionId } = open;
    const blocks = await this.#kit.attempt(() =>
      this.#kit.bridge.dequeue(environmentId, sessionId, queueId),
    );
    if (blocks !== undefined) this.#kit.drafts.restore(viewKey(environmentId, sessionId), [blocks]);
    return blocks;
  };

  cancel = async (): Promise<void> => {
    const open = this.#open();
    if (open === undefined) return;
    await this.#kit.attempt(() => this.#kit.bridge.cancel(open.environmentId, open.sessionId));
  };

  setConfig = async (configId: string, value: string): Promise<void> => {
    const open = this.#open();
    if (open === undefined) return;
    await this.#kit.attempt(() =>
      this.#kit.bridge.setSessionConfig(open.environmentId, open.sessionId, configId, value),
    );
  };

  /** Answers with why it failed, or nothing. A row of the sidebar names its own environment; the header is the open one's. */
  rename = async (
    sessionId: string,
    title: string,
    where: "header" | "sidebar" = "header",
    environmentId = this.#kit.state().selectedEnvironment,
  ): Promise<string | undefined> => {
    if (environmentId === undefined) return undefined;
    try {
      await this.#kit.bridge.renameSession(environmentId, sessionId, title, where);
      return undefined;
    } catch (error) {
      return messageOf(error);
    }
  };

  dismissBackground = async (session: SessionSummary): Promise<void> => {
    const ids = session.unknownBackground;
    if (ids?.length)
      await this.#kit.attempt(() =>
        this.#kit.bridge.dismissBackground(session.environmentId, session.sessionId, ids),
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
      this.#kit.bridge.stopSubagent(open.environmentId, open.sessionId, childId, background),
    );
  };

  /** A session of the open one's environment, or of `environmentId`, as a row of the sidebar names its own. */
  archive = async (
    sessionId: string,
    archived: boolean,
    environmentId = this.#kit.state().selectedEnvironment,
  ): Promise<void> => {
    if (environmentId === undefined) return;
    await this.#kit.attempt(() =>
      this.#kit.bridge.archiveSession(environmentId, sessionId, archived),
    );
  };

  /**
   * The person is looking at the session: tell the daemon it has been seen. Nothing to show if it cannot be told (the
   * mark stays, and is asked again when something new comes in or the app comes back to the front): a mark is not worth an error banner.
   */
  markRead = async (environmentId: string, sessionId: string): Promise<void> => {
    try {
      await this.#kit.bridge.markRead(environmentId, sessionId);
    } catch {
      // Not worth a banner.
    }
  };

  delete = async (
    sessionId: string,
    environmentId = this.#kit.state().selectedEnvironment,
  ): Promise<string | undefined> => {
    if (environmentId === undefined) return undefined;
    try {
      await this.#kit.bridge.deleteSession(environmentId, sessionId);
      this.forget(environmentId, sessionId);
      return undefined;
    } catch (error) {
      return messageOf(error);
    }
  };

  /** A session that no longer exists: its view, its draft and its place as the selected one go. */
  forget(environmentId: string, sessionId: string): void {
    const key = viewKey(environmentId, sessionId);
    this.#kit.drafts.forget(key);
    this.#kit.sidePanels.forget(key);
    this.#kit.filesViews.forget(key);
    this.#held.delete(key);
    this.#kit.set((s) => {
      const { [key]: _gone, ...views } = s.views;
      const { [key]: _closed, ...terminals } = s.terminals;
      return {
        views,
        terminals,
        selectedSession:
          s.selectedEnvironment === environmentId && s.selectedSession === sessionId
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

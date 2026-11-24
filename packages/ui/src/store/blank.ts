// The blank conversation: a new session before its first message, which is what makes it.
import type { EventProps } from "@cycle/analytics/events";
import type { AgentInfo } from "../api.ts";
import { promptBlocks } from "../draft.ts";
import { messageOf, type StoreKit } from "./core.ts";
import { BLANK_KEY, type BlankConversation, viewKey } from "./state.ts";

/** How long a blank conversation was open before its first message, in four words: only that is reported. */
const waitedOf = (ms: number): EventProps<"blank_sent">["waited"] =>
  ms < 10_000 ? "under_10s" : ms < 60_000 ? "under_1m" : ms < 300_000 ? "under_5m" : "longer";

export class BlankSlice {
  readonly #kit: StoreKit;
  /** Opens the session its first message made. */
  readonly #select: (environmentId: string, sessionId: string) => Promise<void>;
  /** The blank conversation's folder is being looked up for trust: a second send waits for the first. */
  #checkingTrust = false;
  /** When the blank conversation now open was opened: how long it took to send its first message is reported. */
  #openedAt = 0;
  /** The latest read of the blank folder's trust, or answer to it: an older read that comes back after is not used. */
  #trustRead = 0;

  constructor(kit: StoreKit, select: (environmentId: string, sessionId: string) => Promise<void>) {
    this.#kit = kit;
    this.#select = select;
  }

  /** The blank conversation open on `environmentId`, if there is one. */
  #on(environmentId: string): boolean {
    return this.#kit.state().blank?.environmentId === environmentId;
  }

  /** Its environment has just connected: whether its folder is trusted could not be asked before the daemon said it keeps trust. */
  connected(environmentId: string): void {
    if (this.#on(environmentId)) void this.#readTrust();
  }

  /** Its environment's agents were read: it was waiting to know which agent it starts. */
  agentsRead(environmentId: string): void {
    if (this.#on(environmentId)) void this.#readDefaults();
  }

  /** An agent's defaults changed on its environment: it starts from them as they are now, under what was chosen on it. */
  defaultsChanged(environmentId: string): void {
    if (this.#on(environmentId)) void this.#readDefaults(true);
  }

  /** The agent a blank conversation starts: the one explicitly chosen (even if unavailable, so install guidance shows), else the first available. */
  agentOf = (blank: BlankConversation): AgentInfo | undefined => {
    const all = this.#kit.state().agents[blank.environmentId] ?? [];
    if (blank.agent !== undefined) {
      const picked = all.find((a) => a.id === blank.agent);
      if (picked !== undefined) return picked;
    }
    return all.find((a) => a.available);
  };

  /**
   * Opens a blank conversation: a new session that does not exist until its first message. One already open stays as it
   * is (what was chosen on it is kept), unless another environment or folder is asked for.
   */
  open = (where: { environmentId: string; cwd?: string | undefined }): void => {
    const open = this.#kit.state().blank;
    const same =
      open !== undefined &&
      open.environmentId === where.environmentId &&
      (where.cwd === undefined || where.cwd === open.cwd);
    const blank: BlankConversation =
      same || open?.starting !== undefined
        ? open
        : {
            environmentId: where.environmentId,
            cwd: where.cwd ?? "",
            agent: undefined,
            config: undefined,
          };
    if (blank !== open) this.#openedAt = Date.now();
    this.#kit.set({ blank, selectedEnvironment: blank.environmentId, selectedSession: undefined });
    if (blank.config === undefined && blank.unreadable === undefined) void this.#readDefaults();
    if (blank !== open) void this.#readTrust();
  };

  /** Changes what the blank conversation will start as. Not while it is starting. */
  change = (change: {
    environmentId?: string;
    cwd?: string;
    agent?: string;
    setting?: { key: string; value: string };
    /** Every setting at once, as the settings form hands them back. */
    config?: Record<string, string>;
  }): void => {
    const blank = this.#kit.state().blank;
    if (blank === undefined || blank.starting !== undefined) return;
    let next: BlankConversation = { ...blank };
    if (change.environmentId !== undefined && change.environmentId !== blank.environmentId) {
      // A folder and an agent of one environment mean nothing on another.
      next = { environmentId: change.environmentId, cwd: "", agent: undefined, config: undefined };
    }
    if (change.cwd !== undefined && change.cwd !== next.cwd) {
      next.cwd = change.cwd;
      delete next.trust;
    }
    if (change.agent !== undefined && change.agent !== next.agent) {
      // Another agent has other settings: what was chosen for this one is not for it.
      next = { ...next, agent: change.agent, config: undefined };
      delete next.unreadable;
      delete next.chosen;
      delete next.authRequired;
    }
    if (change.setting !== undefined && next.config !== undefined) {
      const { key, value } = change.setting;
      next.config = { ...next.config, [key]: value };
      next.chosen = { ...next.chosen, [key]: value };
    }
    if (change.config !== undefined && next.config !== undefined) {
      const before = next.config;
      const changed = Object.entries(change.config).filter(([key, value]) => before[key] !== value);
      next.config = change.config;
      next.chosen = { ...next.chosen, ...Object.fromEntries(changed) };
    }
    this.#kit.set({ blank: next, selectedEnvironment: next.environmentId });
    if (next.config === undefined && next.unreadable === undefined) void this.#readDefaults();
    if (next.cwd !== blank.cwd || next.environmentId !== blank.environmentId)
      void this.#readTrust();
  };

  /**
   * Reads whether the blank conversation's folder is trusted, for the page to say so before the first message. Only a
   * hint: the first message reads it again, and asks. Nothing is said when the daemon cannot tell, or the read fails.
   */
  async #readTrust(): Promise<void> {
    const { bridge, set, state } = this.#kit;
    const blank = state().blank;
    if (blank === undefined) return;
    const cwd = blank.cwd.trim();
    if (cwd === "" || state().status[blank.environmentId]?.capabilities?.trust !== true) return;
    const asked = ++this.#trustRead;
    const read = await bridge.readTrust(blank.environmentId, cwd).catch(() => undefined);
    const now = state().blank;
    if (read === undefined || now === undefined || asked !== this.#trustRead) return;
    if (now.environmentId !== blank.environmentId || now.cwd.trim() !== cwd) return;
    const trust = read.trusted === null ? "undecided" : read.trusted ? "trusted" : "untrusted";
    if (now.trust !== trust) set({ blank: { ...now, trust } });
  }

  /**
   * Answers whether to trust the blank conversation's folder, and then sends its first message. Undefined: neither, the
   * question is left and the message stays in the box. If the answer cannot be kept, nothing is started and it says why.
   */
  answerTrust = async (trusted: boolean | undefined): Promise<void> => {
    const { bridge, set, state } = this.#kit;
    const blank = state().blank;
    const asking = blank?.asking;
    if (blank === undefined || asking === undefined) return;
    const { asking: _asked, ...rest } = blank;
    if (trusted === undefined) {
      set({ blank: rest });
      return;
    }
    try {
      await bridge.setTrust(blank.environmentId, asking.path, trusted);
    } catch (error) {
      if (state().blank === blank)
        set({ blank: { ...blank, asking: { path: asking.path, failed: messageOf(error) } } });
      return;
    }
    if (state().blank !== blank) return;
    // What was just decided is what the folder is now: a read still on its way is older.
    this.#trustRead++;
    const decided: BlankConversation = { ...rest, trust: trusted ? "trusted" : "untrusted" };
    set({ blank: decided });
    await this.send(decided, true);
  };

  /** Reads the agent's defaults again, after a read that failed. */
  retry = (): void => {
    const blank = this.#kit.state().blank;
    if (blank?.unreadable === undefined) return;
    const { unreadable: _failed, ...rest } = blank;
    this.#kit.set({ blank: rest });
    void this.#readDefaults();
  };

  /**
   * Reads the defaults of the agent the blank conversation starts, on its environment: what its session starts with,
   * under what was chosen on it. `again`: they have changed, and are read even though there are some already.
   */
  async #readDefaults(again = false): Promise<void> {
    const { bridge, set, state } = this.#kit;
    const blank = state().blank;
    if (blank === undefined || blank.starting !== undefined) return;
    if (blank.config !== undefined && !again) return;
    const agent = this.agentOf(blank);
    if (agent === undefined) return;
    let config: Record<string, string> | undefined;
    try {
      config = (await bridge.agentDefaults(blank.environmentId, agent.id)) ?? {};
    } catch {
      config = undefined;
    }
    // Only for the conversation and agent it was read for: another may be open by now, or it may be starting.
    const now = state().blank;
    if (
      now === undefined ||
      now.environmentId !== blank.environmentId ||
      now.starting !== undefined
    )
      return;
    if (now.config !== undefined && !again) return;
    if (this.agentOf(now)?.id !== agent.id) return;
    if (config === undefined) {
      // A read again that fails leaves what was read before.
      if (now.config === undefined) set({ blank: { ...now, unreadable: true } });
      return;
    }
    set({ blank: { ...now, config: { ...config, ...now.chosen } } });
  }

  /**
   * Sends the blank conversation's first message, which is what makes its session: `session/new`, then `session/prompt`.
   * The message is shown in the blank conversation while that goes on. If the session cannot be made, the message comes
   * back to the box; if it is made and the message cannot go, the session is opened with the message back in its box.
   */
  async send(blank: BlankConversation, trustAnswered = false): Promise<void> {
    const { bridge, set, state, attempt, track, drafts } = this.#kit;
    const agent = this.agentOf(blank);
    const cwd = blank.cwd.trim();
    if (
      blank.starting !== undefined ||
      blank.asking !== undefined ||
      this.#checkingTrust ||
      agent === undefined ||
      !agent.available ||
      blank.config === undefined ||
      cwd === ""
    )
      return;
    if (promptBlocks(drafts.get(BLANK_KEY)) === undefined) return;
    const { environmentId } = blank;
    // A folder nobody has decided on is asked about before anything of its own can run. One that cannot be looked at
    // is not: making the session there fails with the daemon's reason.
    if (!trustAnswered && state().status[environmentId]?.capabilities?.trust === true) {
      this.#checkingTrust = true;
      const trust = await bridge.readTrust(environmentId, cwd).catch(() => undefined);
      this.#checkingTrust = false;
      const now = state().blank;
      // Changed meanwhile (another folder, another environment): the person sends again.
      if (now === undefined || now.environmentId !== environmentId || now.cwd.trim() !== cwd)
        return;
      if (trust?.trusted === null) {
        set({ blank: { ...now, asking: { path: trust.path } } });
        return;
      }
      blank = now;
    }
    const content = promptBlocks(drafts.get(BLANK_KEY));
    if (content === undefined) return;
    drafts.clear(BLANK_KEY);
    const { authRequired: _clearedAuth, ...baseBlank } = blank;
    const starting: BlankConversation = { ...baseBlank, cwd, starting: content };
    set({ blank: starting });
    let sessionId: string | undefined;
    let needsAuth = false;
    try {
      sessionId = await bridge.createSession(environmentId, {
        cwd,
        agent: agent.id,
        config: blank.config ?? {},
      });
    } catch (error) {
      const msg = messageOf(error);
      if (
        (error as { code?: unknown })?.code === -32000 ||
        /(^|[^0-9])-32000(?![0-9])|authentication required/i.test(msg)
      ) {
        needsAuth = true;
      } else {
        set({ error: msg });
      }
    }
    if (sessionId !== undefined)
      // Once, when the session is made: a start that fails and is sent again is not counted twice.
      track("blank_sent", { waited: waitedOf(Date.now() - this.#openedAt) });
    if (sessionId === undefined) {
      drafts.restore(BLANK_KEY, [content]);
      if (state().blank === starting) {
        set({
          blank: {
            ...baseBlank,
            cwd,
            ...(needsAuth ? { authRequired: { agentId: agent.id, agentName: agent.name } } : {}),
          },
        });
      }
      return;
    }
    const sent = await attempt(async () => {
      await bridge.prompt(environmentId, sessionId, content);
      return true;
    });
    const stayed = state().blank === starting;
    // What could not go comes back where the person can find it: the session's box if they are still here (it opens),
    // else the blank conversation's, since a session nothing was said in is not in the list.
    if (sent !== true)
      drafts.restore(stayed ? viewKey(environmentId, sessionId) : BLANK_KEY, [content]);
    // The person may have gone elsewhere meanwhile: nothing is taken from them.
    if (!stayed) return;
    set({ blank: undefined });
    await this.#select(environmentId, sessionId);
  }
}

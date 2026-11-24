// The blank conversation: a new session before its first message, which is what makes it.
import type { EventProps } from "@cycle/analytics/events";
import type { AgentInfo } from "../api.ts";
import { promptBlocks } from "../draft.ts";
import { environmentProblem } from "../environments.ts";
import { messageOf, type StoreKit } from "./core.ts";
import { blankEnvironmentOf, environmentDefaultOf } from "./environments.ts";
import { BLANK_KEY, type BlankConversation, viewKey } from "./state.ts";

/** How long a blank conversation was open before its first message, in four words: only that is reported. */
const waitedOf = (ms: number): EventProps<"blank_sent">["waited"] =>
  ms < 10_000 ? "under_10s" : ms < 60_000 ? "under_1m" : ms < 300_000 ? "under_5m" : "longer";

export class BlankSlice {
  readonly #kit: StoreKit;
  /** Opens the session its first message made. */
  readonly #select: (locationId: string, sessionId: string) => Promise<void>;
  /** The blank conversation's folder is being looked up for trust: a second send waits for the first. */
  #checkingTrust = false;
  /** When the blank conversation now open was opened: how long it took to send its first message is reported. */
  #openedAt = 0;
  /** The latest read of the blank folder's trust, or answer to it: an older read that comes back after is not used. */
  #trustRead = 0;

  /** Keeps the environment a workspace starts with from now on. */
  readonly #setDefault: (
    locationId: string,
    cwd: string,
    environmentId: string | null,
  ) => Promise<void>;

  constructor(
    kit: StoreKit,
    select: (locationId: string, sessionId: string) => Promise<void>,
    setDefault: (locationId: string, cwd: string, environmentId: string | null) => Promise<void>,
  ) {
    this.#kit = kit;
    this.#select = select;
    this.#setDefault = setDefault;
  }

  /**
   * The environment the person chose on the blank conversation (null: none). With a folder it is that workspace's default
   * from now on; without one it waits, and is the default of the workspace the session is made in if that has none.
   */
  chooseEnvironment = (environmentId: string | null): void => {
    const blank = this.#kit.state().blank;
    if (blank === undefined || blank.starting !== undefined) return;
    this.#kit.set({ blank: { ...blank, environment: environmentId } });
    const cwd = blank.cwd.trim();
    if (cwd !== "") void this.#setDefault(blank.locationId, cwd, environmentId);
  };

  /** The blank conversation open on `locationId`, if there is one. */
  #on(locationId: string): boolean {
    return this.#kit.state().blank?.locationId === locationId;
  }

  /** Its location has just connected: whether its folder is trusted could not be asked before the daemon said it keeps trust. */
  connected(locationId: string): void {
    if (this.#on(locationId)) void this.#readTrust();
  }

  /** Its location's agents were read: it was waiting to know which agent it starts. */
  agentsRead(locationId: string): void {
    if (this.#on(locationId)) void this.#readDefaults();
  }

  /** An agent's defaults changed on its location: it starts from them as they are now, under what was chosen on it. */
  defaultsChanged(locationId: string): void {
    if (this.#on(locationId)) void this.#readDefaults(true);
  }

  /** The agent a blank conversation starts: the one explicitly chosen (even if unavailable, so install guidance shows), else the first available. */
  agentOf = (blank: BlankConversation): AgentInfo | undefined => {
    const all = this.#kit.state().agents[blank.locationId] ?? [];
    if (blank.agent !== undefined) {
      const picked = all.find((a) => a.id === blank.agent);
      if (picked !== undefined) return picked;
    }
    return all.find((a) => a.available);
  };

  /**
   * Opens a blank conversation: a new session that does not exist until its first message. One already open stays as it
   * is (what was chosen on it is kept), unless another location or folder is asked for.
   */
  open = (where: { locationId: string; cwd?: string | undefined }): void => {
    const open = this.#kit.state().blank;
    const same =
      open !== undefined &&
      open.locationId === where.locationId &&
      (where.cwd === undefined || where.cwd === open.cwd);
    const blank: BlankConversation =
      same || open?.starting !== undefined
        ? open
        : {
            locationId: where.locationId,
            cwd: where.cwd ?? "",
            agent: undefined,
            config: undefined,
          };
    if (blank !== open) this.#openedAt = Date.now();
    this.#kit.set({ blank, selectedLocation: blank.locationId, selectedSession: undefined });
    if (blank.config === undefined && blank.unreadable === undefined) void this.#readDefaults();
    if (blank !== open) void this.#readTrust();
  };

  /** Changes what the blank conversation will start as. Not while it is starting. */
  change = (change: {
    locationId?: string;
    cwd?: string;
    agent?: string;
    setting?: { key: string; value: string };
    /** Every setting at once, as the settings form hands them back. */
    config?: Record<string, string>;
  }): void => {
    const blank = this.#kit.state().blank;
    if (blank === undefined || blank.starting !== undefined) return;
    let next: BlankConversation = { ...blank };
    if (change.locationId !== undefined && change.locationId !== blank.locationId) {
      // A folder and an agent of one location mean nothing on another; the environment chosen is not of either.
      next = {
        locationId: change.locationId,
        cwd: "",
        agent: undefined,
        config: undefined,
        ...(blank.environment !== undefined ? { environment: blank.environment } : {}),
      };
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
    this.#kit.set({ blank: next, selectedLocation: next.locationId });
    if (next.config === undefined && next.unreadable === undefined) void this.#readDefaults();
    if (next.cwd !== blank.cwd || next.locationId !== blank.locationId) void this.#readTrust();
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
    if (cwd === "" || state().status[blank.locationId]?.capabilities?.trust !== true) return;
    const asked = ++this.#trustRead;
    const read = await bridge.readTrust(blank.locationId, cwd).catch(() => undefined);
    const now = state().blank;
    if (read === undefined || now === undefined || asked !== this.#trustRead) return;
    if (now.locationId !== blank.locationId || now.cwd.trim() !== cwd) return;
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
      await bridge.setTrust(blank.locationId, asking.path, trusted);
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
   * Reads the defaults of the agent the blank conversation starts, on its location: what its session starts with,
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
      config = (await bridge.agentDefaults(blank.locationId, agent.id)) ?? {};
    } catch {
      config = undefined;
    }
    // Only for the conversation and agent it was read for: another may be open by now, or it may be starting.
    const now = state().blank;
    if (now === undefined || now.locationId !== blank.locationId || now.starting !== undefined)
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
    const { locationId } = blank;
    // A folder nobody has decided on is asked about before anything of its own can run. One that cannot be looked at
    // is not: making the session there fails with the daemon's reason.
    if (!trustAnswered && state().status[locationId]?.capabilities?.trust === true) {
      this.#checkingTrust = true;
      const trust = await bridge.readTrust(locationId, cwd).catch(() => undefined);
      this.#checkingTrust = false;
      const now = state().blank;
      // Changed meanwhile (another folder, another location): the person sends again.
      if (now === undefined || now.locationId !== locationId || now.cwd.trim() !== cwd) return;
      if (trust?.trusted === null) {
        set({ blank: { ...now, asking: { path: trust.path } } });
        return;
      }
      blank = now;
    }
    const content = promptBlocks(drafts.get(BLANK_KEY));
    if (content === undefined) return;
    // The workspace's environment, when its daemon takes one: sent whole, by main, as it is now. One that does not pass
    // the daemon's rules (a file written by hand or by another version) is not sent to be refused: it is to fix first.
    const environment =
      state().status[locationId]?.capabilities?.environments === true
        ? blankEnvironmentOf(state(), { ...blank, cwd })
        : undefined;
    if (environment !== undefined && environmentProblem(environment) !== undefined) {
      set({ error: { key: "blank.environment.needsFix", params: { name: environment.name } } });
      return;
    }
    drafts.clear(BLANK_KEY);
    const { authRequired: _clearedAuth, ...baseBlank } = blank;
    const starting: BlankConversation = { ...baseBlank, cwd, starting: content };
    set({ blank: starting });
    let sessionId: string | undefined;
    let needsAuth = false;
    // Chosen before the folder, for a workspace with no default of its own: it becomes that, once the session is made.
    const keepAsDefault =
      environment !== undefined && environmentDefaultOf(state(), locationId, cwd) === undefined;
    try {
      const made = await bridge.createSession(locationId, {
        cwd,
        agent: agent.id,
        config: blank.config ?? {},
        ...(environment !== undefined ? { environmentId: environment.id } : {}),
      });
      if (typeof made === "string") sessionId = made;
      // A sentence of the page's, naming the variable and never its value.
      else
        set({
          error: {
            key: `blank.environment.refused.${made.problem.reason}`,
            params: { name: made.problem.name ?? "" },
          },
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
    if (sessionId !== undefined && keepAsDefault && environment !== undefined)
      void this.#setDefault(locationId, cwd, environment.id);
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
      await bridge.prompt(locationId, sessionId, content);
      return true;
    });
    const stayed = state().blank === starting;
    // What could not go comes back where the person can find it: the session's box if they are still here (it opens),
    // else the blank conversation's, since a session nothing was said in is not in the list.
    if (sent !== true)
      drafts.restore(stayed ? viewKey(locationId, sessionId) : BLANK_KEY, [content]);
    // The person may have gone elsewhere meanwhile: nothing is taken from them.
    if (!stayed) return;
    set({ blank: undefined });
    await this.#select(locationId, sessionId);
  }
}

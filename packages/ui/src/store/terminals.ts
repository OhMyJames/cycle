// Each session's terminals (CYCL-98): their tabs, and who draws each one.
import type { AppEvent, CycleBridge, TerminalAttached } from "../api.ts";
import { mergeTerminals, neighbourOf, terminalCount, terminalTab } from "../terminals.ts";
import { messageOf, type StoreKit } from "./core.ts";
import { viewKey } from "./state.ts";

/** Who draws a terminal: its output, and the screen to draw again from when the app fell behind. */
export type TerminalScreen = {
  output: (seq: number, data: string) => void;
  screen: (seq: number, screen: string, cols: number, rows: number) => void;
};

export class TerminalsSlice {
  readonly #kit: StoreKit;
  /** Who draws each terminal (`environmentId:terminalId`): its output and resets go there, and nowhere else. */
  readonly #screens = new Map<string, TerminalScreen>();
  /**
   * Environments whose terminals are being listed again after a reconnect: until that answer, a terminal missing from
   * what the daemon tells ended while the connection was away, and keeps its tab saying so.
   */
  readonly #relisting = new Map<string, number>();

  constructor(kit: StoreKit) {
    this.#kit = kit;
  }

  /** What main tells of terminals: a session's list, or what one of them shows. */
  onEvent(event: AppEvent & { type: "terminals" | "terminal-output" | "terminal-reset" }): void {
    switch (event.type) {
      case "terminals": {
        const key = viewKey(event.environmentId, event.sessionId);
        const gone = this.#relisting.has(event.environmentId) ? "kept" : "dropped";
        this.#kit.set((s) => ({
          terminals: {
            ...s.terminals,
            [key]: mergeTerminals(s.terminals[key], event.terminals, gone),
          },
        }));
        return;
      }
      case "terminal-output":
        this.#screens
          .get(`${event.environmentId}:${event.terminalId}`)
          ?.output(event.seq, event.data);
        return;
      case "terminal-reset":
        this.#screens
          .get(`${event.environmentId}:${event.terminalId}`)
          ?.screen(event.seq, event.screen, event.cols, event.rows);
        return;
    }
  }

  /**
   * Asks a session's daemon for its terminals, the first time the page needs them. After that the daemon tells every
   * change, and a connection that comes back asks again (`relist`).
   */
  load = async (environmentId: string, sessionId: string): Promise<void> => {
    if (this.#kit.state().terminals[viewKey(environmentId, sessionId)] !== undefined) return;
    await this.#list(environmentId, sessionId, "dropped");
  };

  /** Terminals may have ended while the connection was away (the daemon stopped): their tabs say so. */
  async relist(environmentId: string): Promise<void> {
    const prefix = `${environmentId}:`;
    const sessions = Object.keys(this.#kit.state().terminals)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
    if (sessions.length === 0) return;
    const round = (this.#relisting.get(environmentId) ?? 0) + 1;
    this.#relisting.set(environmentId, round);
    try {
      await Promise.all(sessions.map((s) => this.#list(environmentId, s, "kept")));
    } finally {
      if (this.#relisting.get(environmentId) === round) this.#relisting.delete(environmentId);
    }
  }

  async #list(environmentId: string, sessionId: string, gone: "kept" | "dropped"): Promise<void> {
    if (this.#kit.state().status[environmentId]?.capabilities?.terminal !== true) return;
    const key = viewKey(environmentId, sessionId);
    try {
      const told = await this.#kit.bridge.listTerminals(environmentId, sessionId);
      this.#kit.set((s) => ({
        terminals: { ...s.terminals, [key]: mergeTerminals(s.terminals[key], told, gone) },
      }));
    } catch {
      // Not connected, or gone meanwhile: the list stays as it was, and a connection that comes back asks again.
    }
  }

  /**
   * Opens a shell in a session's folder and shows its tab. Why it could not (a limit reached, an archived session) is
   * shown as any other failure, in the page's words.
   */
  create = async (
    environmentId: string,
    sessionId: string,
    size: { cols: number; rows: number },
    via: "header" | "tab_strip",
  ): Promise<TerminalAttached | undefined> => {
    const { bridge, set, track, sidePanels } = this.#kit;
    let made: Awaited<ReturnType<CycleBridge["createTerminal"]>>;
    try {
      made = await bridge.createTerminal(environmentId, sessionId, size.cols, size.rows);
    } catch (error) {
      made = { problem: "failed", message: messageOf(error) };
    }
    if ("problem" in made) {
      const { problem, message } = made;
      set({
        error:
          problem === "failed" && message !== undefined
            ? message
            : { key: `terminal.problem.${problem === "failed" ? "other" : problem}` },
      });
      track("terminal_open_failed", {
        reason:
          problem === "limit" || problem === "archived" || problem === "cwd_missing"
            ? problem
            : "other",
      });
      return undefined;
    }
    const key = viewKey(environmentId, sessionId);
    // Opening attached this connection to it; its tab attaches when it is drawn, and a tab never drawn (the person went
    // elsewhere first) must not keep its output coming. Sent before the tab's own attach, so the daemon sees them in order.
    this.detach(environmentId, made.terminal.terminalId);
    set((s) => {
      const known = s.terminals[key] ?? [];
      const has = known.some((t) => t.terminalId === made.terminal.terminalId);
      return { terminals: { ...s.terminals, [key]: has ? known : [...known, made.terminal] } };
    });
    sidePanels.show(key, terminalTab(made.terminal.terminalId));
    track("terminal_opened", { via, count: this.#running(key) });
    return made;
  };

  /** How many of a session's terminals still run, in the words analytics uses. */
  #running(key: string) {
    return terminalCount(
      this.#kit.state().terminals[key]?.filter((t) => t.ended !== true).length ?? 0,
    );
  }

  /**
   * Closes a terminal: its shell and what runs in it end. One that already ended only loses its tab. Its tab goes at
   * once, and the panel shows the tab before it if it was the one shown. If the daemon could not be told, that is shown,
   * and the list is read again: a shell still running gets its tab back.
   */
  close = async (environmentId: string, sessionId: string, terminalId: string): Promise<void> => {
    const { bridge, set, track, sidePanels } = this.#kit;
    const key = viewKey(environmentId, sessionId);
    const known = this.#kit.state().terminals[key] ?? [];
    const was = known.find((t) => t.terminalId === terminalId);
    const panel = sidePanels.get(key);
    const tab = terminalTab(terminalId);
    if (panel.active === tab) {
      const next = neighbourOf(
        [...panel.tabs, ...known.map((t) => terminalTab(t.terminalId))],
        tab,
      );
      if (next !== undefined) sidePanels.show(key, next);
    }
    set((s) => ({
      terminals: {
        ...s.terminals,
        [key]: (s.terminals[key] ?? []).filter((t) => t.terminalId !== terminalId),
      },
    }));
    if (was === undefined) return;
    track("terminal_closed", {
      state: was.ended === true ? "ended" : was.status,
      count: this.#running(key),
    });
    if (was.ended === true) return;
    try {
      await bridge.closeTerminal(environmentId, terminalId);
    } catch (error) {
      set({ error: messageOf(error) });
      await this.#list(environmentId, sessionId, "dropped");
    }
  };

  /**
   * Draws a terminal: from now on its output and resets go to `screen`, until the function returned is called. Call it
   * before attaching, so that output that comes before the attach's answer is not lost.
   */
  show = (environmentId: string, terminalId: string, screen: TerminalScreen): (() => void) => {
    const id = `${environmentId}:${terminalId}`;
    this.#screens.set(id, screen);
    return () => {
      if (this.#screens.get(id) === screen) this.#screens.delete(id);
    };
  };

  /** The terminal's screen now. Fails as the daemon says (it has gone, the connection is down): the caller shows it. */
  attach = (environmentId: string, terminalId: string): Promise<TerminalAttached> =>
    this.#kit.bridge.attachTerminal(environmentId, terminalId);

  /** Lets go of a terminal no longer drawn. Never fails: one that has gone, or a connection that has, is let go already. */
  detach = (environmentId: string, terminalId: string): void => {
    void this.#kit.bridge.detachTerminal(environmentId, terminalId).catch(() => undefined);
  };

  input = (environmentId: string, terminalId: string, data: string): Promise<void> =>
    this.#kit.bridge.terminalInput(environmentId, terminalId, data);

  resize = (environmentId: string, terminalId: string, cols: number, rows: number): Promise<void> =>
    this.#kit.bridge.resizeTerminal(environmentId, terminalId, cols, rows);
}

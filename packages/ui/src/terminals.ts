// The Terminal tabs of the right panel (CYCL-98): which of them a panel shows, and the order a terminal's output is
// drawn in. A terminal is the daemon's (docs/protocol.md §8 "终端"): its shell runs there and outlives this page; the
// page only draws it. Plain TypeScript, no React and no DOM, so the rules are tested without a page.
import type { TerminalInfo } from "./api.ts";
import { isTab, type PanelTabId, type PanelTabKind } from "./side-panel.ts";

/** The id of a Terminal tab: the terminal's own, after `terminal:`. */
export const terminalTab = (terminalId: string): PanelTabId => `terminal:${terminalId}`;

/** The terminal a tab shows, or undefined for a tab that is not a terminal. */
export const terminalOfTab = (tab: string): string | undefined =>
  tab.startsWith("terminal:") ? tab.slice("terminal:".length) : undefined;

/**
 * A terminal as the panel has it: the daemon's, or one that was there before the connection went and is not there
 * now (`ended`), so that its tab says what became of it instead of disappearing.
 */
export type TerminalTab = TerminalInfo & { ended?: true };

/**
 * A session's terminals after the daemon told them again: its list, then those the page had, had not closed, and
 * no longer finds, marked ended. `gone` says whether a terminal missing now went while the page was away (a reconnect),
 * or was closed in front of it (another window, or the shell ended and someone closed it): only the first is kept.
 */
export const mergeTerminals = (
  known: readonly TerminalTab[] | undefined,
  told: readonly TerminalInfo[],
  gone: "kept" | "dropped",
): TerminalTab[] => {
  const ids = new Set(told.map((t) => t.terminalId));
  const ended =
    gone === "kept"
      ? (known ?? [])
          .filter((t) => !ids.has(t.terminalId))
          .map((t): TerminalTab => ({ ...t, ended: true }))
      : (known ?? []).filter((t) => t.ended === true && !ids.has(t.terminalId));
  return [...told, ...ended];
};

/**
 * The tab a panel shows when the one it was showing has gone: the one before it in the strip, or the first. `tabs` is
 * the strip as it was, with the gone tab still in it.
 */
export const neighbourOf = (
  tabs: readonly PanelTabId[],
  gone: PanelTabId,
): PanelTabId | undefined => {
  const at = tabs.indexOf(gone);
  const rest = tabs.filter((t) => t !== gone);
  if (rest.length === 0) return undefined;
  return at <= 0 ? rest[0] : rest[Math.min(at - 1, rest.length - 1)];
};

/**
 * What each terminal's tab says, in the strip's order: its title, and for a title another tab before it already has,
 * its place among those (`zsh`, `zsh 2`, `zsh 3`). New shells all start with the shell's name, so without it a second
 * terminal's tab reads as the first, and New terminal looks as if it did nothing.
 */
export const tabLabels = (terminals: readonly TerminalInfo[]): string[] => {
  const seen = new Map<string, number>();
  return terminals.map(({ title }) => {
    const n = (seen.get(title) ?? 0) + 1;
    seen.set(title, n);
    return n === 1 ? title : `${title} ${n}`;
  });
};

/** How many terminals a session has, as analytics say it: never more exactly than this. */
export const terminalCount = (n: number): "none" | "one" | "few" | "many" =>
  n <= 0 ? "none" : n === 1 ? "one" : n <= 3 ? "few" : "many";

/** The kind of a tab, as analytics name it. */
export const tabKind = (tab: PanelTabId): PanelTabKind | "terminal" =>
  isTab(tab) ? tab : "terminal";

/** UTF-16 units per `input`: at most three bytes each in UTF-8 (a pair is two units for four), so well under 64 KiB. */
const INPUT_PIECE = 16 * 1024;

/** `data` in pieces of at most `size` characters, never between the two halves of a surrogate pair. */
export const inputPieces = (data: string, size = INPUT_PIECE): string[] => {
  const pieces: string[] = [];
  let at = 0;
  while (at < data.length) {
    let end = Math.min(at + size, data.length);
    const last = data.charCodeAt(end - 1);
    // A piece of one character that is half a pair takes the whole pair.
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end += end - 1 > at ? -1 : 1;
    pieces.push(data.slice(at, end));
    at = end;
  }
  return pieces;
};

/** Bytes of output held for a terminal whose screen has not come yet. More than this, and the oldest goes. */
export const HELD_LIMIT = 8 * 1024 * 1024;

/**
 * Puts a terminal's output on its screen in order, once each (docs/protocol.md §8 "终端", 顺序). The screen an attach
 * answers with and the output that follows it come on separate paths, in no fixed order: output that comes before the
 * screen is held, and a piece the screen already holds (its `seq` not past the screen's) is dropped.
 */
export class TerminalFeed {
  /** The last piece on screen; undefined while waiting for a screen. */
  #seq: number | undefined;
  #held: { seq: number; data: string }[] = [];
  #heldBytes = 0;
  readonly #write: (data: string) => void;
  readonly #redraw: (screen: string, cols: number, rows: number) => void;

  constructor(
    write: (data: string) => void,
    redraw: (screen: string, cols: number, rows: number) => void,
  ) {
    this.#write = write;
    this.#redraw = redraw;
  }

  /** Waiting for a screen (attaching, again after a reconnect): output until it comes is held. */
  wait(): void {
    this.#seq = undefined;
  }

  get waiting(): boolean {
    return this.#seq === undefined;
  }

  output(seq: number, data: string): void {
    if (this.#seq === undefined) {
      this.#held.push({ seq, data });
      this.#heldBytes += data.length;
      while (this.#heldBytes > HELD_LIMIT && this.#held.length > 1) {
        this.#heldBytes -= this.#held.shift()?.data.length ?? 0;
      }
      return;
    }
    if (seq <= this.#seq) return;
    this.#seq = seq;
    this.#write(data);
  }

  /**
   * The screen as of `seq`: an attach's answer, or a reset. One older than what is on screen already (a reset that
   * came first, then the answer of the attach it raced) is not drawn.
   */
  screen(seq: number, screen: string, cols: number, rows: number): void {
    if (this.#seq !== undefined && seq < this.#seq) return;
    this.#seq = seq;
    this.#redraw(screen, cols, rows);
    const held = this.#held;
    this.#held = [];
    this.#heldBytes = 0;
    for (const piece of held) this.output(piece.seq, piece.data);
  }
}

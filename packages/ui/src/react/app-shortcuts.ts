import { useEffect, useRef } from "react";
import type { SessionSummary } from "../api.ts";
import { composerInput } from "./composer.tsx";
import { MOD } from "./sidebar.tsx";

/**
 * What is drawn over a page and takes its keys first: a dialog, a menu, the choices of a select. Not every listbox: the
 * sidebar's list of sessions is one too.
 */
const OVER_THE_PAGE =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="select-content"]';

/** What the window's shortcuts can do now. An action left undefined cannot be done now: its key is let through. */
export type Shortcuts = {
  /** A dialog of the window is open: it has the keys. */
  dialogOpen: boolean;
  /** Settings or Connectors is over the sessions. */
  pageOpen: boolean;
  toggleSettings: () => void;
  search: () => void;
  newSession: (() => void) | undefined;
  toggleSidebar: () => void;
  toggleSidePanel: (() => void) | undefined;
  /** A blank conversation is open: its folder menu has a key. */
  blankOpen: boolean;
  /** Stops what the agent is doing. */
  stop: (() => void) | undefined;
  /** Allows, once, what the agent asks first. */
  allow: (() => void) | undefined;
  /** The sessions in the order the sidebar lists them, the one open, and those that cannot be opened. */
  walk: {
    order: readonly SessionSummary[];
    open: SessionSummary | undefined;
    away: ReadonlyMap<string, unknown>;
    select: (session: SessionSummary) => void;
  };
};

/** The window's keyboard (DESIGN.md §5.4): one handler, bound once, so every shortcut stays in one place. */
export function useAppShortcuts(shortcuts: Shortcuts) {
  const latest = useRef(shortcuts);
  latest.current = shortcuts;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => onShortcut(event, latest.current);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function onShortcut(event: KeyboardEvent, s: Shortcuts) {
  // ⌘ on a Mac (Ctrl+B and Ctrl+N are cursor keys in a text field there); Ctrl elsewhere.
  const isMac = MOD === "⌘";
  if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey || s.dialogOpen) return;
  const key = event.key;
  const run = (action: () => void) => {
    event.preventDefault();
    action();
  };
  if (key === ",") {
    // What is open over the page (a confirmation, a list of choices) is answered first.
    if (document.querySelector(OVER_THE_PAGE) !== null) return;
    run(s.toggleSettings);
  }
  // A page is over the sessions: only what leaves it (a search, a new session) is taken.
  else if (s.pageOpen && key !== "k" && key !== "n") return;
  else if (key === "k") run(s.search);
  else if (key === "n" && s.newSession !== undefined) run(s.newSession);
  else if (key === "b") run(s.toggleSidebar);
  else if (key === "\\" && s.toggleSidePanel !== undefined) run(s.toggleSidePanel);
  else if (key === "l") run(() => composerInput()?.focus());
  else if (
    key === "o" &&
    s.blankOpen &&
    document.querySelector('[role="dialog"], [role="alertdialog"]') === null
  )
    // The blank page's folder menu: what its button does when pressed.
    run(() =>
      document
        .querySelector<HTMLButtonElement>('[data-kind="blank-folder"]:not(:disabled)')
        ?.click(),
    );
  else if (key === "." && s.stop !== undefined) run(s.stop);
  else if (key === "Enter" && s.allow !== undefined) run(s.allow);
  else if (key === "[" || key === "]") {
    const { order, open, away, select } = s.walk;
    const at = open === undefined ? -1 : order.indexOf(open);
    // A row on a location that is away and was never opened cannot be opened: the walk goes past it.
    const step = key === "]" ? 1 : -1;
    // The open session is not in the workspace that is shown: the walk starts at the end it is going from.
    let to = at === -1 ? (step === 1 ? 0 : order.length - 1) : at + step;
    while (order[to] !== undefined && away.has(order[to]?.locationId ?? "")) to += step;
    const next = order[to];
    if (next !== undefined) run(() => select(next));
  }
}

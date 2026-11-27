// The window's frame (CYC-530): one shell for every place (the sessions, the Loop, Settings, Connectors). The shell owns
// what is the same everywhere: the sidebar's top row and the button that folds it, the app's notices and the account
// menu at its foot, the main area's title bar (its height, the room for the traffic lights, the strip the window is
// dragged by, the button that unfolds the sidebar) and the order of what is said under it. A place says only what is
// its own: what its part of the sidebar holds, its title and the actions beside it, its notices and its body. It says
// them from inside itself (`ShellSidebar`, `ShellTitle`, `ShellTools`, `ShellNotices`), and they are drawn where the
// shell keeps them, so one component keeps its state (a section's tabs, a ticket's drawer) across both columns.
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type Slot = "sidebar" | "title" | "tools" | "notices";
type Targets = Readonly<Partial<Record<Slot, HTMLElement>>>;

const TargetsContext = createContext<Targets>({});
const PlaceContext = createContext<{ id: string; active: boolean }>({ id: "", active: true });

/** Where the shell draws what the places say: one element per slot, known once the frame is in the page. */
function useTargets() {
  const [targets, setTargets] = useState<Targets>({});
  const refs = useMemo(() => {
    const refOf = (slot: Slot) => (element: HTMLElement | null) =>
      setTargets((was) => {
        if ((was[slot] ?? null) === element) return was;
        const next = { ...was };
        if (element === null) delete next[slot];
        else next[slot] = element;
        return next;
      });
    return {
      sidebar: refOf("sidebar"),
      title: refOf("title"),
      tools: refOf("tools"),
      notices: refOf("notices"),
    };
  }, []);
  const ready =
    targets.sidebar !== undefined &&
    targets.title !== undefined &&
    targets.tools !== undefined &&
    targets.notices !== undefined;
  return { targets, refs, ready };
}

function ShellSlot({ slot, children }: { slot: Slot; children: ReactNode }) {
  const target = useContext(TargetsContext)[slot];
  const place = useContext(PlaceContext);
  if (target === undefined) return null;
  // A place that is kept under another (the sessions, under Settings) keeps what it said, out of sight.
  return createPortal(
    <div data-slot="place-part" data-place={place.id} hidden={!place.active}>
      {children}
    </div>,
    target,
  );
}

/** The place's part of the sidebar: under the top row, above the notices and the account menu. */
export function ShellSidebar({ children }: { children: ReactNode }) {
  return <ShellSlot slot="sidebar">{children}</ShellSlot>;
}

/** The place's title, at the start of the title bar (after the button that unfolds the sidebar, when it is folded). */
export function ShellTitle({ children }: { children: ReactNode }) {
  return <ShellSlot slot="title">{children}</ShellSlot>;
}

/** The place's actions, at the end of the title bar. */
export function ShellTools({ children }: { children: ReactNode }) {
  return <ShellSlot slot="tools">{children}</ShellSlot>;
}

/** What is the matter with the place, under the title bar and after what is the matter with the app. */
export function ShellNotices({ children }: { children: ReactNode }) {
  return <ShellSlot slot="notices">{children}</ShellSlot>;
}

/**
 * One place in the shell. Its children are its body, in the main area; what it puts in the sidebar and the title bar it
 * says with the `Shell*` parts. A place that is not active stays mounted, hidden and inert, with what it said.
 */
export function Place({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ id, active }), [id, active]);
  return (
    <PlaceContext.Provider value={value}>
      <div data-slot="place" data-place={id} hidden={!active} inert={!active}>
        {children}
      </div>
    </PlaceContext.Provider>
  );
}

/** Whether the place this is drawn in is the one shown. */
export function usePlaceActive(): boolean {
  return useContext(PlaceContext).active;
}

/**
 * The frame. `layout` draws the columns (`SplitLayout`) from the sidebar and the main area it is given. The places are
 * drawn once the frame is in the page, so what they say has somewhere to go from their first render.
 */
export function AppShell({
  layout,
  sidebarLabel,
  sidebarCollapsed,
  toggle,
  sidebarActions,
  sidebarNotices,
  topNotices,
  banner,
  footer,
  children,
}: {
  layout: (columns: { sidebar: ReactNode; main: ReactNode }) => ReactNode;
  /** What the sidebar is called for a screen reader: the shown place's name. */
  sidebarLabel: string;
  sidebarCollapsed: boolean;
  /** The button that folds and unfolds the sidebar: in its top row, or in the title bar while it is folded. */
  toggle: ReactNode;
  /**
   * The sidebar's actions, when the shown place shares them with others (the sessions and the Loop): one element across
   * both, so a button pressed in one keeps the focus in the other. A place with its own (a page's way back) leaves it out.
   */
  sidebarActions?: ReactNode;
  /** What concerns the whole app, over the account menu (app-notices.tsx). */
  sidebarNotices: ReactNode;
  /** The same, under the title bar, while the sidebar is folded. */
  topNotices: ReactNode;
  /** What went wrong, under the title bar, when the place does not say it itself. */
  banner?: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}) {
  const { targets, refs, ready } = useTargets();
  const sidebar = (
    <nav data-slot="sidebar" aria-label={sidebarLabel}>
      <div data-slot="titlebar">{sidebarCollapsed ? null : toggle}</div>
      {sidebarActions}
      <div data-slot="sidebar-place" ref={refs.sidebar} />
      {sidebarCollapsed ? null : sidebarNotices}
      <div data-slot="sidebar-footer">{footer}</div>
    </nav>
  );
  const main = (
    <main data-slot="main">
      <header data-slot="main-header">
        {sidebarCollapsed ? toggle : null}
        <div data-slot="main-title" ref={refs.title} />
        <div data-slot="main-tools" ref={refs.tools} />
      </header>
      {sidebarCollapsed ? topNotices : null}
      {banner}
      <div data-slot="place-notices" ref={refs.notices} />
      <TargetsContext.Provider value={targets}>{ready ? children : null}</TargetsContext.Provider>
    </main>
  );
  return layout({ sidebar, main });
}

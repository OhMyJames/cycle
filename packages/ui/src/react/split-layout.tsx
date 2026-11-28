// The window's columns: the sidebar, the conversation and the right panel (CYCL-66). One SDK `Resizable`
// group, so both handles drag, take the arrow keys, Home and End, and fold on Enter or a double-click alike. What gives
// way on a narrow window is decided in .agents/notes/2026-11-21-right-panel-layout.md: the panel down to its minimum,
// then the sidebar folds (and comes back when there is room), and only then the conversation narrows. The panel never
// covers the conversation.

import {
  type createResizableController,
  Resizable,
  ResizableHandle,
  ResizablePanel,
} from "@ui-sdk/react/resizable";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "./i18n.tsx";

export const SIDEBAR = { default: 256, min: 200, max: 360 } as const;
export const PANEL = { default: 400, min: 280 } as const;
/** The conversation's least width: the composer's controls still fit on one line. */
export const MAIN_MIN = 400;
/** What the conversation keeps beside an open panel before it gives any more: the panel and the sidebar give first. */
export const MAIN_KEEP = 480;

export type ResizableController = ReturnType<typeof createResizableController>;

/**
 * What the columns give up to fit `width`, in the order the note decides. `sidebar` and `panel` are the widths the user
 * left them at (`0` when folded or closed). Beside an open panel the conversation keeps `MAIN_KEEP`: the panel narrows
 * first, down to its minimum; then the sidebar folds; only then does the conversation narrow, down to `MAIN_MIN`. With
 * no panel the sidebar folds only when the conversation would go below `MAIN_MIN`. Pure, so the order is tested without a
 * window.
 */
export const fitColumns = (
  width: number,
  want: { sidebar: number; panel: number },
): { sidebar: number; panel: number; sidebarFolded: boolean } => {
  const keep = want.panel > 0 ? MAIN_KEEP : MAIN_MIN;
  const panelFor = (sidebar: number) =>
    want.panel > 0 ? Math.max(PANEL.min, Math.min(want.panel, width - sidebar - keep)) : 0;
  const panel = panelFor(want.sidebar);
  if (width - want.sidebar - panel >= keep || want.sidebar === 0)
    return { sidebar: want.sidebar, panel, sidebarFolded: false };
  return { sidebar: 0, panel: panelFor(0), sidebarFolded: true };
};

const FOLDED_KEY = "cycle-layout-folded";
// The width the user left the panel at. The SDK's saved layout has the panel folded whenever it was closed last, so the
// width it was open at is kept here.
const PANEL_KEY = "cycle-layout-panel";
const readPanel = (): number | undefined => {
  try {
    const width = Number(globalThis.localStorage?.getItem(PANEL_KEY));
    return width >= PANEL.min ? width : undefined;
  } catch {
    return undefined;
  }
};
const writePanel = (width: number) => {
  try {
    globalThis.localStorage?.setItem(PANEL_KEY, String(Math.round(width)));
  } catch {}
};
const readFolded = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(FOLDED_KEY) === "1";
  } catch {
    return false;
  }
};
const writeFolded = (value: boolean) => {
  try {
    if (value) globalThis.localStorage?.setItem(FOLDED_KEY, "1");
    else globalThis.localStorage?.removeItem(FOLDED_KEY);
  } catch {}
};

/**
 * After a change the user made (a drag, a key, the sidebar button, ⌘B): whether the sidebar's fold is still the window's.
 * Only a change to the sidebar itself makes it the user's; a drag of the panel's handle while the window has the sidebar
 * folded leaves that fold the window's, to give back when there is room.
 */
export const foldedByWindow = (byWindow: boolean, wasFolded: boolean, folded: boolean): boolean =>
  folded === wasFolded ? byWindow : false;

/** Records who folded the sidebar: `true` the window, `false` the user (or nobody). */
const foldBy = (folded: { current: boolean }, byWindow: boolean) => {
  folded.current = byWindow;
  writeFolded(byWindow);
};

/** Asks the controller for a change, counted as the component's own unless it changed nothing (then it commits nothing). */
const askFor = (ours: { current: number }, change: () => boolean): boolean => {
  ours.current++;
  const done = change();
  if (!done) ours.current--;
  return done;
};

// Slides running on each split: `data-animate` stays while any of them does.
const sliding = new WeakMap<HTMLElement, number>();

/**
 * Runs `change` with the columns sliding to where it puts them (`data-animate` on the split, motion.md): the sidebar's
 * button and ⌘B, and the panel opened or closed by the user. A drag, or a window being resized, moves them at once.
 * `done` runs when `column` has got there (at once if nothing moved; with reduced motion, nothing slides and it runs a
 * moment later). Returns what ends the slide early.
 */
export const slideColumns = (
  split: HTMLElement,
  column: "sidebar" | "panel",
  change: () => boolean,
  done?: () => void,
): (() => void) => {
  sliding.set(split, (sliding.get(split) ?? 0) + 1);
  split.setAttribute("data-animate", "");
  const moved = change();
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    const left = (sliding.get(split) ?? 1) - 1;
    sliding.set(split, left);
    if (left === 0) split.removeAttribute("data-animate");
    split.removeEventListener("transitionend", onEnd);
    window.clearTimeout(fallback);
    done?.();
  };
  const onEnd = (event: TransitionEvent) => {
    if ((event.target as HTMLElement).id === column && event.propertyName === "flex-basis") end();
  };
  // No transitionend when nothing moved, or with reduced motion: the slide ends anyway.
  const fallback = window.setTimeout(end, moved ? 400 : 0);
  split.addEventListener("transitionend", onEnd);
  return end;
};

const widthIn = (group: HTMLElement, id: string) =>
  group.querySelector<HTMLElement>(`[data-slot="resizable-panel"]#${id}`)?.getBoundingClientRect()
    .width ?? 0;

const COLUMNS = ["sidebar", "main", "panel"] as const;
/** A column's width as the layout has it (where a slide is going, not where it is): its share of the columns' room. */
const sizeIn = (
  group: HTMLElement,
  controller: ResizableController,
  id: (typeof COLUMNS)[number],
) => {
  const handles = [...group.querySelectorAll<HTMLElement>('[data-slot="resizable-handle"]')].reduce(
    (sum, handle) => sum + handle.getBoundingClientRect().width,
    0,
  );
  const share = controller.getLayout()[COLUMNS.indexOf(id)] ?? 0;
  return ((group.getBoundingClientRect().width - handles) * share) / 100;
};

export type SplitPanel = {
  /** What the panel holds: its tabs, or a session opened beside Timeline. */
  content: ReactNode;
  /** Accessible name for the right-side aside; defaults to `layout.panel`. */
  label?: string | undefined;
  /** The user folded the panel (its handle's Enter, a double-click, a drag past half its minimum): folding it is closing it. */
  onClose?: () => void;
};

export function SplitLayout({
  controller,
  sidebar,
  main,
  panel,
  auxPanel,
  panelHidden = false,
  panelOf,
  onSidebarWidth,
}: {
  controller: ResizableController;
  sidebar: ReactNode;
  main: ReactNode;
  /** The right panel, when open. Closed, its column is folded and holds nothing: nothing in it loads. */
  panel?: SplitPanel | undefined;
  /**
   * An alternate right panel shown while `panelHidden` is true (such as a session opened from Loop Timeline).
   * Unlike `panel`, it unmounts when closed and leaves any hidden `panel` mounted intact beside it.
   */
  auxPanel?: SplitPanel | undefined;
  /**
   * True while another mode (the Loop) takes the main column: the primary panel stays mounted (hidden and inert) so
   * local state such as terminals, open diffs and expanded folders survives return, while `auxPanel` may use the column.
   */
  panelHidden?: boolean | undefined;
  /**
   * Whose panel it is (the open session's key), open or not. A panel the user opens or closes slides like the sidebar;
   * one that comes or goes because another session was opened is there or gone at once, so the last session's panel
   * is not seen over the next one's conversation.
   */
  panelOf?: string | undefined;
  /**
   * Told the sidebar's width as the user left it (folded or not), when the columns attach and after each change of
   * theirs: a page in place of the sessions takes the same width, so its edge does not move (CYCL-219).
   */
  onSidebarWidth?: ((width: number) => void) | undefined;
}) {
  const { t } = useI18n();
  const groupRef = useRef<HTMLDivElement>(null);
  const sidebarWidth = useRef(onSidebarWidth);
  sidebarWidth.current = onSidebarWidth;
  // What the user left the sidebar and the panel at: read from the page when the columns attach (the SDK has restored
  // the saved layout by then), and from every change the user makes.
  const [wanted] = useState(() => ({
    sidebar: SIDEBAR.default as number,
    panel: readPanel() ?? PANEL.default,
  }));
  const want = useRef<{ sidebar: number; panel: number }>(wanted);
  // The width the last fitting gave the panel: a commit that leaves it there did not change it.
  const fitted = useRef(0);
  // Whether the window folded the sidebar (not the user). Kept beside the saved layout, which saves the fold too: after
  // a restart a fold the window made is still the window's, and comes back when there is room.
  const folded = useRef(readFolded());
  // The changes this component asked for: their commits are not the user's.
  const ours = useRef(0);
  const sidebarWasFolded = useRef(false);
  // Whether the active panel is open and visible: what its column is fitted to.
  const activePanel = panelHidden ? auxPanel : panel;
  const isOpen = activePanel !== undefined;
  const opened = useRef(isOpen);
  opened.current = isOpen;
  // Puts the columns where they go for the window and what is open, and says how wide the panel is to be. Set once the
  // columns have attached.
  const fit = useRef<(() => number) | undefined>(undefined);

  // The panel opens and closes as the sidebar folds (CYCL-222): its column's width slides, carrying the conversation
  // with it. Closing, what it shows stays in the column, out of reach, until the column has folded. A panel that comes
  // or goes with a session being opened or a mode switch is there or gone at once, as is any with reduced motion, or
  // one its handle folded (nothing is left to see).
  const lastPrimary = useRef(panel);
  if (panel !== undefined && !panelHidden) lastPrimary.current = panel;
  const lastAux = useRef(auxPanel);
  if (auxPanel !== undefined && panelHidden) lastAux.current = auxPanel;
  // What the panel last did: whose it is, whether it is open, whether it is hidden by a mode, whether it slid there,
  // and (closing) the slide it goes with. Set while rendering, and only then: `ended` is the one the slides' ends set,
  // so neither undoes the other.
  const [was, setWas] = useState<{
    open: boolean;
    of?: string | undefined;
    hidden: boolean;
    slide: boolean;
    going?: object | undefined;
  }>({ open: isOpen, of: panelOf, hidden: panelHidden, slide: false });
  const [ended, setEnded] = useState<object>();
  if (was.open !== isOpen || was.of !== panelOf || was.hidden !== panelHidden) {
    const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const theUsers = was.of === panelOf && was.hidden === panelHidden && !reduced;
    const shut = theUsers && !isOpen && !controller.isCollapsed("panel");
    setWas({
      open: isOpen,
      of: panelOf,
      hidden: panelHidden,
      slide: theUsers && (isOpen || shut),
      going: shut ? {} : undefined,
    });
  }
  const leaving = was.going !== undefined && was.going !== ended;
  const shownPrimary = panelHidden
    ? undefined
    : (panel ?? (leaving ? lastPrimary.current : undefined));
  const shownAux = panelHidden ? (auxPanel ?? (leaving ? lastAux.current : undefined)) : undefined;
  const shown = panelHidden ? shownAux : shownPrimary;
  const renderedPrimary = panelHidden ? panel : shownPrimary;
  const renderedAux = shownAux;
  useEffect(() => {
    // Gone: what it showed is not held on to.
    if (renderedPrimary === undefined) lastPrimary.current = undefined;
    if (renderedAux === undefined) lastAux.current = undefined;
  }, [renderedPrimary, renderedAux]);

  // The panel opened or closed: the columns are fitted to it, sliding when it was the user, at once otherwise. Before
  // the page is drawn, so the column is not seen a frame in the wrong place.
  const endSlide = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    const split = groupRef.current;
    const refit = fit.current;
    // On attaching (nothing fits yet), the first fitting puts the panel's column where it goes.
    if (split === null || refit === undefined) return;
    // Measured while a slide still runs: ending it first would put the column where that slide was going.
    const now = widthIn(split, "panel");
    endSlide.current?.();
    if (!was.slide) {
      refit();
      return;
    }
    // While it slides, what it shows keeps its open width and is cut off by the column, as the sidebar's rows are:
    // nothing in it is squeezed, and a terminal in it is not fitted again on every frame.
    const keep = (width: number) => split.style.setProperty("--cycle-panel-width", `${width}px`);
    if (!was.open) keep(Math.max(now, fitted.current));
    endSlide.current = slideColumns(
      split,
      "panel",
      () => {
        const before = controller.getLayout().join();
        const width = refit();
        if (was.open) keep(width);
        return controller.getLayout().join() !== before;
      },
      () => {
        split.style.removeProperty("--cycle-panel-width");
        endSlide.current = undefined;
        setEnded(was.going);
      },
    );
  }, [was, controller]);
  useEffect(() => () => endSlide.current?.(), []);

  useEffect(() => {
    const group = groupRef.current;
    if (group === null || typeof ResizeObserver === "undefined") return;
    const widthOf = (id: string) => widthIn(group, id);
    const ask = (change: () => boolean) => askFor(ours, change);
    // First attach: the SDK has restored the saved layout; that is what the user left.
    sidebarWasFolded.current = controller.isCollapsed("sidebar");
    if (!sidebarWasFolded.current && widthOf("sidebar") > 0)
      want.current.sidebar = widthOf("sidebar");
    sidebarWidth.current?.(want.current.sidebar);
    // The panel's width, from before it was kept apart from the SDK's layout: read once.
    if (readPanel() === undefined && !controller.isCollapsed("panel") && widthOf("panel") > 0) {
      want.current.panel = widthOf("panel");
      writePanel(want.current.panel);
    }
    const refit = () => {
      const width = group.getBoundingClientRect().width;
      if (width === 0) return 0;
      const collapsed = controller.isCollapsed("sidebar");
      const userFolded = collapsed && !folded.current;
      const panelOpen = opened.current;
      const next = fitColumns(width, {
        sidebar: userFolded ? 0 : want.current.sidebar,
        panel: panelOpen ? want.current.panel : 0,
      });
      if (next.sidebarFolded && !collapsed) {
        if (ask(() => controller.collapse("sidebar"))) foldBy(folded, true);
      } else if (!next.sidebarFolded && folded.current && collapsed) {
        if (ask(() => controller.expand("sidebar"))) foldBy(folded, false);
      }
      sidebarWasFolded.current = controller.isCollapsed("sidebar");
      // The sidebar is as wide as the user left it, whatever the window: the SDK keeps sizes as shares of the group,
      // and would widen or narrow it with the window, and with the panel coming or going.
      if (!sidebarWasFolded.current && Math.abs(widthOf("sidebar") - want.current.sidebar) > 1)
        ask(() => controller.resize("sidebar", `${want.current.sidebar}px`));
      // The panel's column is as wide as fits when it is open, and folded when it is not.
      if (!panelOpen) {
        if (!controller.isCollapsed("panel")) ask(() => controller.collapse("panel"));
      } else if (controller.isCollapsed("panel") || Math.abs(widthOf("panel") - next.panel) > 1)
        ask(() => controller.resize("panel", `${next.panel}px`));
      fitted.current = next.panel;
      return next.panel;
    };
    fit.current = refit;
    // Fitted again the frame after the window changes: the SDK rescales the columns on its own observer, and what it
    // made of them is what is put right.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      refit();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refit);
    });
    observer.observe(group);
    refit();
    return () => {
      fit.current = undefined;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [controller]);

  return (
    <div
      data-slot="split"
      ref={groupRef}
      style={{ "--cycle-sidebar-min": `${SIDEBAR.min}px` } as CSSProperties}
    >
      <Resizable
        controller={controller}
        autoSaveId="cycle-layout"
        onLayoutCommit={() => {
          if (ours.current > 0) {
            ours.current--;
            return;
          }
          // Everything else is the user's: a drag, a key, the sidebar button or ⌘B. (The window's own resizing is not
          // committed: it never reaches here.)
          const collapsed = controller.isCollapsed("sidebar");
          const byWindow = foldedByWindow(folded.current, sidebarWasFolded.current, collapsed);
          if (byWindow !== folded.current) foldBy(folded, byWindow);
          sidebarWasFolded.current = collapsed;
          const group = groupRef.current;
          if (group === null) return;
          if (!collapsed && widthIn(group, "sidebar") > 0) {
            want.current.sidebar = widthIn(group, "sidebar");
            sidebarWidth.current?.(want.current.sidebar);
          }
          if (!isOpen || activePanel === undefined) return;
          if (controller.isCollapsed("panel")) {
            activePanel.onClose?.();
            return;
          }
          // The panel's own width only when the user changed it, not the one the window narrowed it to while the user
          // changed something else. Taken from the layout, not the page: the column may still be sliding there.
          const width = sizeIn(group, controller, "panel");
          if (width === 0 || Math.abs(width - fitted.current) <= 1) return;
          want.current.panel = width;
          fitted.current = width;
          writePanel(width);
        }}
      >
        <ResizablePanel
          id="sidebar"
          defaultSize={`${SIDEBAR.default}px`}
          minSize={`${SIDEBAR.min}px`}
          maxSize={`${SIDEBAR.max}px`}
          collapsible
          collapsedSize="0px"
        >
          {sidebar}
        </ResizablePanel>
        <ResizableHandle aria-label={t("layout.resizeSidebar")} />
        <ResizablePanel id="main" minSize={`${MAIN_MIN}px`}>
          {main}
        </ResizablePanel>
        {/* Closed or going, the panel's handle is out of reach (a drag then would size a panel that is closed), and drawn
            only while there is a panel beside it. */}
        <ResizableHandle
          aria-label={t("layout.resizePanel")}
          disabled={!isOpen}
          data-closed={shown === undefined ? "" : undefined}
        />
        <ResizablePanel
          id="panel"
          // Folded until the fitting opens it, so a first start does not show it open for a moment.
          defaultSize="0px"
          minSize={`${PANEL.min}px`}
          collapsible
          collapsedSize="0px"
        >
          {renderedPrimary !== undefined ? (
            <aside
              data-slot="side-panel"
              aria-label={renderedPrimary.label ?? t("layout.panel")}
              hidden={panelHidden}
              inert={panelHidden}
            >
              {renderedPrimary.content}
            </aside>
          ) : null}
          {renderedAux !== undefined ? (
            <aside
              data-slot="loop-session-panel"
              aria-label={renderedAux.label ?? t("layout.panel")}
            >
              {renderedAux.content}
            </aside>
          ) : null}
        </ResizablePanel>
      </Resizable>
    </div>
  );
}

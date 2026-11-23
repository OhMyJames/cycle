// The window's columns: the sidebar, the conversation and, when open, the right panel (CYCL-66). One SDK `Resizable`
// group, so both handles drag, take the arrow keys, Home and End, and fold on Enter or a double-click alike. What gives
// way on a narrow window is decided in .agents/notes/2026-11-21-right-panel-layout.md: the panel down to its minimum,
// then the sidebar folds (and comes back when there is room), and only then the conversation narrows. The panel never
// covers the conversation.

import { animateIn, animateOut } from "@ui-sdk/core";
import {
  type createResizableController,
  Resizable,
  ResizableHandle,
  ResizablePanel,
} from "@ui-sdk/react/resizable";
import { useReducedMotion } from "motion/react";
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

const widthIn = (group: HTMLElement, id: string) =>
  group.querySelector<HTMLElement>(`[data-slot="resizable-panel"]#${id}`)?.getBoundingClientRect()
    .width ?? 0;

export type SplitPanel = {
  /** What the panel holds: its tabs. */
  content: ReactNode;
  /** The user folded the panel (its handle's Enter, a double-click, a drag past half its minimum): folding it is closing it. */
  onClose?: () => void;
};

export function SplitLayout({
  controller,
  sidebar,
  main,
  panel,
  panelOf,
}: {
  controller: ResizableController;
  sidebar: ReactNode;
  main: ReactNode;
  /** The right panel, when open. Closed, it is not in the page at all: nothing in it loads. */
  panel?: SplitPanel | undefined;
  /**
   * Whose panel it is (the open session's key), open or not. A panel that closes fades out first; one that goes because
   * another session was opened goes at once, so the last session's panel is not seen over the next one's conversation.
   */
  panelOf?: string | undefined;
}) {
  const { t } = useI18n();
  const groupRef = useRef<HTMLDivElement>(null);
  // What the user left the sidebar and the panel at: read from the page when the columns attach (the SDK has restored
  // the saved layout by then), and from every change the user makes.
  const want = useRef<{ sidebar: number; panel: number }>({
    sidebar: SIDEBAR.default,
    panel: PANEL.default,
  });
  // Whether the window folded the sidebar (not the user). Kept beside the saved layout, which saves the fold too: after
  // a restart a fold the window made is still the window's, and comes back when there is room.
  const folded = useRef(readFolded());
  // The changes this component asked for: their commits are not the user's.
  const ours = useRef(0);
  const sidebarWasFolded = useRef(false);

  // The panel opened or closed by the user comes and goes with the SDK's presence (CYCL-213): opening, it slides in;
  // closing, it stays a moment, out of reach, to fade out, and its column goes when the fade ends. A panel that comes or
  // goes with a session being opened (or the app starting) is there or gone at once, as is any with reduced motion, or
  // one its handle folded (nothing is left to see).
  const reduced = useReducedMotion() === true;
  const asideRef = useRef<HTMLElement>(null);
  const lastPanel = useRef(panel);
  if (panel !== undefined) lastPanel.current = panel;
  const [was, setWas] = useState({ open: panel !== undefined, of: panelOf });
  const [leaving, setLeaving] = useState(false);
  const [opened, setOpened] = useState(0);
  if (was.open !== (panel !== undefined) || was.of !== panelOf) {
    setWas({ open: panel !== undefined, of: panelOf });
    const theUsers = was.of === panelOf && !reduced;
    setLeaving(theUsers && panel === undefined && !controller.isCollapsed("panel"));
    if (theUsers && panel !== undefined) setOpened((n) => n + 1);
  }
  const shown = panel ?? (leaving ? lastPanel.current : undefined);
  // Whether the panel's column is in the page, fading out too.
  const open = shown !== undefined;
  useEffect(() => {
    // Gone: what it showed is not held on to.
    if (!open) lastPanel.current = undefined;
  }, [open]);
  useLayoutEffect(() => {
    const aside = asideRef.current;
    if (opened === 0 || aside === null) return;
    return animateIn(aside);
  }, [opened]);
  useLayoutEffect(() => {
    const aside = asideRef.current;
    if (!leaving || aside === null) return;
    return animateOut(aside, () => setLeaving(false));
  }, [leaving]);

  const started = useRef(false);

  useEffect(() => {
    const group = groupRef.current;
    if (group === null || typeof ResizeObserver === "undefined") return;
    const widthOf = (id: string) => widthIn(group, id);
    const ask = (change: () => boolean) => askFor(ours, change);
    if (!started.current) {
      // First attach: the SDK has restored the saved layout; that is what the user left.
      started.current = true;
      sidebarWasFolded.current = controller.isCollapsed("sidebar");
      if (!sidebarWasFolded.current && widthOf("sidebar") > 0)
        want.current.sidebar = widthOf("sidebar");
    } else {
      // The panel opened or closed: the SDK keeps a layout for each set of columns and has put back that set's
      // sidebar. The sidebar stays as the user has it now.
      const collapsed = controller.isCollapsed("sidebar");
      if (collapsed !== sidebarWasFolded.current)
        ask(() =>
          sidebarWasFolded.current ? controller.collapse("sidebar") : controller.expand("sidebar"),
        );
      else if (!collapsed && Math.abs(widthOf("sidebar") - want.current.sidebar) > 1)
        ask(() => controller.resize("sidebar", `${want.current.sidebar}px`));
    }
    if (open && !controller.isCollapsed("panel") && widthOf("panel") > 0)
      want.current.panel = widthOf("panel");
    const fit = () => {
      const width = group.getBoundingClientRect().width;
      if (width === 0) return;
      const collapsed = controller.isCollapsed("sidebar");
      const userFolded = collapsed && !folded.current;
      const panelOpen = open && !controller.isCollapsed("panel");
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
      if (panelOpen && Math.abs(widthOf("panel") - next.panel) > 1)
        ask(() => controller.resize("panel", `${next.panel}px`));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(group);
    fit();
    return () => observer.disconnect();
  }, [controller, open]);

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
          if (!collapsed && widthIn(group, "sidebar") > 0)
            want.current.sidebar = widthIn(group, "sidebar");
          if (panel !== undefined && controller.isCollapsed("panel")) panel.onClose?.();
          else if (open && widthIn(group, "panel") > 0)
            want.current.panel = widthIn(group, "panel");
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
        {open ? (
          <>
            {/* Going, its handle is out of reach too: a drag then would size a panel that is closed. */}
            <ResizableHandle aria-label={t("layout.resizePanel")} inert={leaving} />
            <ResizablePanel
              id="panel"
              defaultSize={`${PANEL.default}px`}
              minSize={`${PANEL.min}px`}
              collapsible
              collapsedSize="0px"
            >
              <aside data-slot="side-panel" aria-label={t("layout.panel")} ref={asideRef}>
                {shown.content}
              </aside>
            </ResizablePanel>
          </>
        ) : null}
      </Resizable>
    </div>
  );
}

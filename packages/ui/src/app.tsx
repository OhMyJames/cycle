import { activeTurn } from "@cycle/protocol";
import { useEffect, useMemo, useRef } from "react";
import { type CycleApp, type PanelId, projectOf, sessionTitle } from "./client/app.ts";
import { useStore } from "./client/store.ts";
import { AutomaticPage } from "./components/automatic.tsx";
import { Composer } from "./components/composer.tsx";
import { ConnectorPage } from "./components/connector.tsx";
import { FolderPicker } from "./components/folder-picker.tsx";
import { Icon } from "./components/icons.tsx";
import { Palette } from "./components/palette.tsx";
import { SettingsPage } from "./components/settings.tsx";
import { Sidebar, groupSessions } from "./components/sidebar.tsx";
import { Thread } from "./components/thread.tsx";
import { TitleBar } from "./components/titlebar.tsx";
import { Tooltips } from "./components/tooltip.tsx";
import { AppContext, useApp } from "./context.ts";
import { watchFades } from "./lib/fades.ts";
import { basename } from "./lib/format.ts";
import { ChangesPanel } from "./panels/changes.tsx";
import { FilesPanel } from "./panels/files.tsx";
import { OverviewPanel } from "./panels/overview.tsx";
import { TerminalPanel } from "./panels/terminal.tsx";

function Resizer({
  edge,
  onResize,
  onReset,
}: {
  /** Which side of its region the handle sits on. */
  edge: "end" | "start";
  onResize(delta: number): void;
  /** A double-click puts the width back to what it starts as. */
  onReset(): void;
}) {
  const last = useRef(0);
  return (
    <div
      className="resizer"
      data-edge={edge}
      role="separator"
      aria-orientation="vertical"
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        last.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const delta = event.clientX - last.current;
        last.current = event.clientX;
        onResize(edge === "end" ? delta : -delta);
      }}
    />
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ConnectionBanner() {
  const app = useApp();
  const status = useStore(app.connection, (value) => value);
  if (status === "open" || status === "connecting") return null;
  return (
    <div className="banner" role="alert">
      <Icon name="cloud-off" />
      {status === "unauthorized"
        ? "The Cycle daemon refused this page. Open it again from the app or the daemon's link."
        : "Cannot reach the Cycle daemon. Retrying…"}
    </div>
  );
}

function SessionView({ sessionId }: { sessionId: string }) {
  const app = useApp();
  const empty = useStore(app.conversation(sessionId), (conversation) => {
    const state = conversation.state;
    return state
      ? state.turns.length === 0 && !activeTurn(state) && state.info.activity !== "running"
      : false;
  });
  if (empty) return <Welcome sessionId={sessionId} />;
  return (
    <>
      <Thread key={sessionId} sessionId={sessionId} />
      <Composer sessionId={sessionId} />
    </>
  );
}

function Welcome({ sessionId }: { sessionId: string | null }) {
  return (
    <div className="welcome">
      <h2>How can I help you today?</h2>
      <Composer sessionId={sessionId} />
    </div>
  );
}

/** Nothing is open: a new session where there is a folder to start one in, or the way to one. */
function Empty() {
  const app = useApp();
  const status = useStore(app.connection, (value) => value);
  const folder = useStore(
    app.settings,
    (settings) => settings !== null && settings.projects.length > 0,
  );
  const project = useStore(app.view, (view) => view.project);
  const ready = status === "open" && (folder || project !== null);
  useEffect(() => {
    if (ready) app.newSession();
  }, [app, ready]);
  if (ready) return null;
  return (
    <div className="thread-empty">
      {status === "open" ? (
        <>
          <h2 className="empty-title">Open a folder to start</h2>
          <p className="muted">A session works in a folder on this machine.</p>
          <button
            type="button"
            className="button primary"
            autoFocus
            onClick={() => void app.pickFolder()}
          >
            Open folder…
          </button>
        </>
      ) : (
        <p className="muted">Connecting to the Cycle daemon…</p>
      )}
    </div>
  );
}

const PANEL_KEYS: Record<string, PanelId> = { KeyC: "changes", KeyF: "files", KeyO: "overview" };

function useShortcuts(app: CycleApp): void {
  useEffect(() => {
    const step = (direction: 1 | -1, onlyAttention: boolean) => {
      const { sessionId, project } = app.view.get();
      const all = Object.values(app.sessions.get().byId).filter(
        (info) => !project || projectOf(info) === project,
      );
      let order = groupSessions(all, Date.now()).flatMap((group) => group.sessions);
      if (onlyAttention) {
        order = order.filter((info) => info.activity === "requires_action" || info.unread);
      }
      if (!order.length) return;
      const index = order.findIndex((info) => info.id === sessionId);
      const next = order[(index + direction + order.length) % order.length];
      if (next) app.selectSession(next.id);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const mod = event.metaKey || event.ctrlKey;
      const view = app.view.get();
      if (
        event.key === "Escape" &&
        view.page === "settings" &&
        !view.palette &&
        !view.folderPicker &&
        // A dialog over Settings takes the Escape: it closes the topmost thing only.
        !document.querySelector(".scrim")
      ) {
        app.setView({ page: "thread" });
        return;
      }
      // A letter typed at nothing goes to the composer, so the owner never has to click it first.
      const at = document.activeElement;
      if (
        event.key.length === 1 &&
        event.key !== " " &&
        !mod &&
        !event.altKey &&
        view.page === "thread" &&
        (at === null || at === document.body) &&
        !document.querySelector(".scrim, .menu")
      ) {
        document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
        return;
      }
      if (event.ctrlKey && event.code === "Backquote") {
        event.preventDefault();
        app.togglePanel("terminal");
        return;
      }
      if (!mod) return;
      const panel = event.altKey ? PANEL_KEYS[event.code] : undefined;
      if (panel) {
        event.preventDefault();
        app.togglePanel(panel);
        return;
      }
      if (event.altKey) return;
      const handled = (() => {
        switch (event.code) {
          case "KeyN":
            if (event.shiftKey) void app.pickFolder();
            else app.newSession();
            return true;
          case "KeyB":
            app.setView({ sidebar: !view.sidebar });
            return true;
          case "KeyK":
            app.setView({ palette: !view.palette });
            return true;
          case "Comma":
            app.setView({ page: view.page === "settings" ? "thread" : "settings" });
            return true;
          case "KeyJ":
            step(1, true);
            return true;
          case "BracketRight":
            if (!event.shiftKey) return false;
            step(1, false);
            return true;
          case "BracketLeft":
            if (!event.shiftKey) return false;
            step(-1, false);
            return true;
          default:
            return false;
        }
      })();
      if (handled) event.preventDefault();
    };
    // Captured, so a focused field cannot swallow an app shortcut.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [app]);
}

function Toasts() {
  const app = useApp();
  const toasts = useStore(app.toasts, (value) => value);
  return (
    <div className="toasts" role="status">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.level}`}>
          <span className="grow">{toast.message}</span>
          <button
            type="button"
            className="icon-button small"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => app.dismissToast(toast.id)}
          >
            <Icon name="x" />
          </button>
        </div>
      ))}
    </div>
  );
}

function Shell() {
  const app = useApp();
  const view = useStore(app.view, (value) => value);
  const info = useStore(app.sessions, (sessions) =>
    view.sessionId ? (sessions.byId[view.sessionId] ?? null) : null,
  );
  // An archived session is not in the list, but its conversation knows it.
  const opened = useStore(
    app.conversation(view.sessionId ?? ""),
    (conversation) => conversation.state?.info ?? null,
  );
  const session = info ?? (view.sessionId ? opened : null);
  useShortcuts(app);
  useEffect(() => {
    document.title = session ? `${sessionTitle(session)} · Cycle` : "Cycle";
  }, [session]);

  const title = useMemo(() => {
    // A page says its own name in its heading.
    if (view.page !== "thread") return "";
    if (view.draft) return `New session in ${basename(view.draft.cwd)}`;
    return "Cycle";
  }, [view.page, view.draft]);
  const panel = view.page === "thread" && session ? view.panel : null;
  // One watcher says which lines overflow and what each scroller hides, for the fades.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => (root.current ? watchFades(root.current) : undefined), []);
  return (
    <div className="app" ref={root}>
      {view.sidebar ? (
        <div className="sidebar-region" style={{ width: view.sidebarWidth }}>
          <Sidebar />
          <Resizer
            edge="end"
            onReset={() => app.setView({ sidebarWidth: 248 })}
            onResize={(delta) =>
              app.setView({ sidebarWidth: clamp(app.view.get().sidebarWidth + delta, 200, 420) })
            }
          />
        </div>
      ) : null}
      <main
        className="main"
        style={{ ["--panel-room" as string]: panel ? `${view.panelWidth + 6}px` : "0px" }}
      >
        <TitleBar info={view.page === "thread" ? session : null} title={title} />
        <ConnectionBanner />
        <div className="workspace">
          <section className="conversation">
            {view.page === "settings" ? (
              <SettingsPage />
            ) : view.page === "connector" ? (
              <ConnectorPage />
            ) : view.page === "automatic" ? (
              <AutomaticPage />
            ) : view.sessionId ? (
              <SessionView sessionId={view.sessionId} />
            ) : view.draft ? (
              <Welcome sessionId={null} />
            ) : (
              <Empty />
            )}
          </section>
          {panel && session ? (
            <aside className="panel" style={{ width: view.panelWidth }}>
              <Resizer
                edge="start"
                onReset={() => app.setView({ panelWidth: 460 })}
                onResize={(delta) =>
                  app.setView({ panelWidth: clamp(app.view.get().panelWidth + delta, 320, 900) })
                }
              />
              {panel === "changes" ? (
                <ChangesPanel key={session.id} info={session} />
              ) : panel === "files" ? (
                <FilesPanel key={session.id} info={session} />
              ) : panel === "terminal" ? (
                <TerminalPanel key={session.id} info={session} />
              ) : (
                <OverviewPanel key={session.id} info={session} />
              )}
            </aside>
          ) : null}
        </div>
      </main>
      <Tooltips />
      {view.palette ? <Palette /> : null}
      {view.folderPicker ? <FolderPicker /> : null}
      <Toasts />
    </div>
  );
}

export function App({ app }: { app: CycleApp }) {
  return (
    <AppContext.Provider value={app}>
      <Shell />
    </AppContext.Provider>
  );
}

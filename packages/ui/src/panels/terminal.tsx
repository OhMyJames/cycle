import type { SessionInfo, TerminalInfo } from "@cycle/protocol";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/icons.tsx";
import { PanelHeader } from "../components/panel.tsx";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";

function themeColors(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: read("--surface-composer"),
    foreground: read("--text-primary"),
    cursor: read("--text-primary"),
    selectionBackground: read("--surface-selected"),
  };
}

function TerminalView({ id }: { id: string }) {
  const app = useApp();
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = holder.current;
    if (!node) return;
    let disposed = false;
    let cleanup = () => {};
    // The emulator is loaded only when a terminal is first shown.
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(
      async ([{ Terminal }, { FitAddon }]) => {
        if (disposed) return;
        const terminal = new Terminal({
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono"),
          fontSize: 12.5,
          lineHeight: 1.25,
          cursorBlink: true,
          scrollback: 5000,
          // A program's colors are made for a dark screen: on a light one they are kept readable.
          minimumContrastRatio: 4.5,
          theme: themeColors(),
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(node);
        fit.fit();
        const resize = () => {
          fit.fit();
          app
            .request("terminal.resize", { id, cols: terminal.cols, rows: terminal.rows })
            .catch(() => {});
        };
        // Output that arrives while the snapshot is on its way is held, then shown after it.
        const early: Uint8Array[] = [];
        let attached = false;
        const stopOutput = app.onTerminalOutput(id, (data) => {
          if (attached) terminal.write(data);
          else early.push(data);
        });
        const input = terminal.onData((data) => {
          app.request("terminal.write", { id, data }).catch(() => {});
        });
        const observer = new ResizeObserver(resize);
        observer.observe(node);
        // The page's colors change with its appearance, and the terminal's follow.
        const recolor = new MutationObserver(() => {
          terminal.options.theme = themeColors();
        });
        recolor.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
        cleanup = () => {
          recolor.disconnect();
          observer.disconnect();
          input.dispose();
          stopOutput();
          app.request("terminal.detach", { id }).catch(() => {});
          terminal.dispose();
        };
        try {
          const snapshot = await app.request("terminal.attach", { id });
          terminal.write(Uint8Array.from(atob(snapshot.data), (char) => char.charCodeAt(0)));
        } catch {
          terminal.write("\r\n[this terminal is gone]\r\n");
        }
        attached = true;
        for (const data of early) terminal.write(data);
        resize();
        terminal.focus();
        if (disposed) cleanup();
      },
    );
    return () => {
      disposed = true;
      cleanup();
    };
  }, [app, id]);
  return <div className="terminal-view" ref={holder} />;
}

/** The owner's shells in the session's folder. They keep running when the panel closes. */
export function TerminalPanel({ info }: { info: SessionInfo }) {
  const app = useApp();
  const terminals = useStore(app.terminals, (all) => all[info.id]);
  const [active, setActive] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const starting = useRef(false);
  const sessionId = info.id;
  const cwd = info.cwd;

  const create = () => {
    if (starting.current) return;
    starting.current = true;
    void app
      .attempt(app.request("terminal.create", { sessionId, cwd, cols: 80, rows: 24 }))
      .then((terminal) => {
        starting.current = false;
        if (terminal) setActive(terminal.id);
      });
  };

  useEffect(() => {
    let current = true;
    app.request("terminal.list", { sessionId }).then(
      (answer) => {
        if (!current) return;
        app.terminals.update((all) => ({ ...all, [sessionId]: answer.terminals }));
        setLoaded(true);
      },
      () => current && setLoaded(true),
    );
    return () => {
      current = false;
    };
  }, [app, sessionId]);

  const list: TerminalInfo[] = terminals ?? [];
  const shown = list.find((terminal) => terminal.id === active) ?? list.at(-1) ?? null;
  // The first time the panel opens for a session, a terminal starts by itself.
  const none = loaded && list.length === 0;
  const closedLast = useRef(false);
  useEffect(() => {
    if (!none) return;
    // Closing the last terminal closes the panel; opening the panel with none starts one.
    if (closedLast.current) app.setView({ panel: null });
    else create();
    // Runs when the list first comes back empty, not on every redraw.
  }, [none]);

  return (
    <>
      <PanelHeader title="Terminal">
        <button
          type="button"
          className="icon-button new-terminal"
          title="New terminal"
          aria-label="New terminal"
          onClick={create}
        >
          <Icon name="plus" />
        </button>
        <div className="tabs no-scrollbar" role="tablist">
          {list.map((terminal) => (
            <span
              key={terminal.id}
              className="tab"
              data-active={terminal.id === shown?.id}
              onAuxClick={(event) => {
                // The middle button closes a tab, as it does everywhere.
                if (event.button !== 1) return;
                closedLast.current = list.length === 1;
                void app.attempt(app.request("terminal.close", { id: terminal.id }));
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={terminal.id === shown?.id}
                onClick={() => setActive(terminal.id)}
              >
                {terminal.title}
                {terminal.exited ? <span className="muted"> (exited)</span> : null}
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${terminal.title}`}
                onClick={() => {
                  closedLast.current = list.length === 1;
                  void app.attempt(app.request("terminal.close", { id: terminal.id }));
                }}
              >
                <Icon name="x" size={14} />
              </button>
            </span>
          ))}
        </div>
      </PanelHeader>
      {shown ? (
        <TerminalView key={shown.id} id={shown.id} />
      ) : (
        <div className="note">Starting a terminal…</div>
      )}
    </>
  );
}

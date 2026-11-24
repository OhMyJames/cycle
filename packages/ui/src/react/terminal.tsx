// A Terminal tab of the right panel (CYCL-98): a shell running in the daemon, beside the session, drawn here by xterm.
// The daemon keeps the screen (docs/protocol.md §8 "终端"): this view attaches when it is shown and lets go when it is
// not, so a tab not looked at costs nothing here, and coming back draws the screen as it is now. Typing, pasting and
// copying are xterm's own; the size follows the panel. Nothing of what is typed or shown leaves for analytics.

import { Button } from "@ui-sdk/react/button";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { isDark, terminalTheme } from "../terminal-theme.ts";
import { inputPieces, TerminalFeed, type TerminalTab } from "../terminals.ts";
import { useI18n } from "./i18n.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/** A size change waits this long for the next before the daemon is told, so a drag of the divider is one resize. */
const RESIZE_WAIT_MS = 80;

/** A CSS colour as a canvas has it (`#rrggbb` or `rgba(…)`): what xterm reads, whatever the page wrote it as. */
const plainColor = (() => {
  let context: CanvasRenderingContext2D | null | undefined;
  return (color: string): string => {
    context ??= document.createElement("canvas").getContext("2d");
    if (context === null) return color;
    context.fillStyle = "#000000";
    context.fillStyle = color;
    return String(context.fillStyle);
  };
})();

/** A colour as the page computes it (`rgb(r, g, b)`), at another opacity. */
const withAlpha = (color: string, alpha: number): string => {
  const [r = 0, g = 0, b = 0] = color.match(/[\d.]+/g)?.map(Number) ?? [];
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * The terminal's colours, from the page's tokens as they are now (the theme can change under it). Read from the tab's
 * element (`[data-slot="terminal"]`), which has the ground; the accent comes through its `outline-color`, since a custom
 * property's own value is not computed (`light-dark()` stays as written) and an outline that is not drawn shows nothing.
 */
const groundOf = (host: HTMLElement) => {
  const style = getComputedStyle(host.closest('[data-slot="terminal"]') ?? host);
  return terminalTheme({
    background: plainColor(style.backgroundColor),
    foreground: plainColor(style.color),
    cursor: plainColor(style.caretColor),
    selection: withAlpha(style.outlineColor, 0.3),
    dark: isDark(style.backgroundColor),
  });
};

const DARK = "(prefers-color-scheme: dark)";

type TerminalProps = { locationId: string; sessionId: string; terminal: TerminalTab };

/** A terminal's tab. "Try again" after a failure starts its screen over, as when the tab is shown again. */
export function TerminalView(props: TerminalProps) {
  const [attempt, setAttempt] = useState(0);
  return <LiveTerminal key={attempt} {...props} retry={() => setAttempt((n) => n + 1)} />;
}

function LiveTerminal({
  locationId,
  sessionId,
  terminal,
  retry,
}: TerminalProps & { retry: () => void }) {
  const { t } = useI18n();
  const store = useAppStore();
  const connected = useAppState((s) => s.status[locationId]?.state === "connected");
  const host = useRef<HTMLDivElement>(null);
  const xterm = useRef<{ term: Terminal; fit: FitAddon; feed: TerminalFeed } | undefined>(
    undefined,
  );
  const [shown, setShown] = useState<"attaching" | "live" | { failed: string }>("attaching");
  const { terminalId } = terminal;
  const exited = terminal.status === "exited";
  const ended = terminal.ended === true;

  // The screen itself: made once for this terminal, and gone with the view.
  useEffect(() => {
    const element = host.current;
    if (element === null || ended) return;
    const style = getComputedStyle(element);
    const term = new Terminal({
      allowProposedApi: false,
      fontFamily: style.fontFamily,
      fontSize: Number.parseFloat(style.fontSize) || 12,
      lineHeight: 1.2,
      scrollback: 5000,
      cursorBlink: false,
      macOptionIsMeta: false,
      theme: groundOf(element),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    /** The size the daemon was last told, or last said it has. */
    let told = "";
    let waiting: ReturnType<typeof setTimeout> | undefined;
    /** The view has gone: what xterm calls back with after that is not acted on. */
    let gone = false;
    // A screen from the daemon is at the daemon's size (the last client's): it is written at that size, so its lines and
    // cursor land where they were, and then the screen takes the panel's size again, which the daemon is told.
    const feed = new TerminalFeed(
      (data) => term.write(data),
      (screen, cols, rows) => {
        term.reset();
        term.resize(cols, rows);
        told = `${cols}x${rows}`;
        term.write(screen, () => {
          if (!gone) refit();
        });
      },
    );
    xterm.current = { term, fit, feed };

    // What is typed or pasted goes as it is, in order; a paste too large for one message goes in pieces.
    const typed = term.onData((data) => {
      for (const piece of inputPieces(data))
        void store.terminalInput(locationId, terminalId, piece).catch(() => undefined);
    });

    // The size follows the panel; the daemon is told once the panel stops moving, and again when the screen gets the
    // keyboard (another window may have made it another size meanwhile).
    const tell = () => {
      const size = `${term.cols}x${term.rows}`;
      if (size === told) return;
      told = size;
      void store
        .resizeTerminal(locationId, terminalId, term.cols, term.rows)
        .catch(() => undefined);
    };
    const refit = () => {
      if (element.clientWidth === 0 || element.clientHeight === 0) return;
      fit.fit();
      clearTimeout(waiting);
      waiting = setTimeout(tell, RESIZE_WAIT_MS);
    };
    const observer = new ResizeObserver(refit);
    observer.observe(element);
    const onFocus = () => {
      told = "";
      tell();
    };
    term.textarea?.addEventListener("focus", onFocus);

    const scheme = matchMedia(DARK);
    const rethemed = () => {
      term.options.theme = groundOf(element);
    };
    scheme.addEventListener("change", rethemed);

    refit();
    // xterm measures a character once, with what font there is: the code font is the page's own and may still be
    // loading, so it measures again once that font is in.
    void document.fonts
      .load(`${term.options.fontSize}px ${style.fontFamily}`)
      .then(() => {
        if (gone) return;
        term.options.fontFamily = `${style.fontFamily}, monospace`;
        refit();
      })
      .catch(() => undefined);
    // Opened from a button, the shell takes the keyboard; reached by arrows along the tabs, the keyboard stays there.
    if (document.activeElement?.closest('[role="tablist"]') == null) term.focus();

    return () => {
      gone = true;
      typed.dispose();
      observer.disconnect();
      clearTimeout(waiting);
      term.textarea?.removeEventListener("focus", onFocus);
      scheme.removeEventListener("change", rethemed);
      xterm.current = undefined;
      term.dispose();
    };
  }, [locationId, terminalId, ended, store]);

  // Attached while shown and connected, and again after the connection comes back (the daemon let go of it). The output that comes before the answer is held by the feed.
  useEffect(() => {
    const view = xterm.current;
    if (view === undefined || !connected || ended) return;
    let live = true;
    view.feed.wait();
    setShown("attaching");
    const stop = store.showTerminal(locationId, terminalId, view.feed);
    store.attachTerminal(locationId, terminalId).then(
      (answer) => {
        if (!live) return;
        view.feed.screen(answer.seq, answer.screen, answer.terminal.cols, answer.terminal.rows);
        setShown("live");
      },
      (error: unknown) => {
        if (live) setShown({ failed: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      live = false;
      stop();
      store.detachTerminal(locationId, terminalId);
    };
  }, [locationId, terminalId, connected, ended, store]);

  // Nothing can be typed into a shell that has exited, or one out of reach.
  useEffect(() => {
    const view = xterm.current;
    if (view !== undefined) view.term.options.disableStdin = exited || !connected;
  }, [exited, connected]);

  if (ended)
    return (
      <div data-slot="terminal">
        <StateBlock
          tone="empty"
          size="inline"
          title={t("terminal.ended")}
          action={{
            label: t("terminal.closeTab"),
            onAction: () => void store.closeTerminal(locationId, sessionId, terminalId),
          }}
        />
      </div>
    );

  const failed = typeof shown === "object" ? shown.failed : undefined;
  return (
    <div data-slot="terminal">
      <div data-slot="terminal-screen" ref={host} hidden={failed !== undefined} />
      {failed !== undefined ? (
        <StateBlock
          tone="error"
          size="inline"
          title={t("terminal.attachFailed")}
          reason={failed}
          action={{ label: t("terminal.tryAgain"), onAction: retry }}
        />
      ) : shown === "attaching" && connected ? (
        <div data-slot="terminal-note" role="status">
          {t("terminal.attaching")}
        </div>
      ) : null}
      {!connected ? (
        <div data-slot="terminal-bar" data-tone="away" role="status">
          <span>{t("terminal.away")}</span>
        </div>
      ) : exited ? (
        <div data-slot="terminal-bar" role="status">
          <span>
            {terminal.exitCode === null || terminal.exitCode === undefined
              ? t("terminal.killed")
              : t("terminal.exited", { code: terminal.exitCode })}
          </span>
          <Button
            data-variant="outline"
            onClick={() => void store.closeTerminal(locationId, sessionId, terminalId)}
          >
            {t("terminal.close")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

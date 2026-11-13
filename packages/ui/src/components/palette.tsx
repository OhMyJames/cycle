import { useMemo, useState } from "react";
import { type PanelId, sessionTitle } from "../client/app.ts";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { basename, fuzzyScore } from "../lib/format.ts";
import { Icon, type IconName } from "./icons.tsx";
import { Dialog, MenuList } from "./menu.tsx";

interface Command {
  label: string;
  sub?: string;
  icon?: IconName;
  hint?: string;
  run(): void;
}

const PANELS: { id: PanelId; label: string; icon: IconName }[] = [
  { id: "changes", label: "Changes", icon: "file-diff" },
  { id: "files", label: "Files", icon: "folder" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "overview", label: "Overview", icon: "overview" },
];

/** One field that reaches every session and every command. */
export function Palette() {
  const app = useApp();
  const sessions = useStore(app.sessions, (value) => value.byId);
  const sessionId = useStore(app.view, (view) => view.sessionId);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const close = () => app.setView({ palette: false });

  const results = useMemo(() => {
    const commands: Command[] = [
      { label: "New session", icon: "compose", hint: "⌘N", run: () => app.newSession() },
      {
        label: "New session in a folder…",
        icon: "folder",
        hint: "⇧⌘N",
        run: () => void app.pickFolder(),
      },
      ...PANELS.map((panel): Command => ({
        label: `Toggle ${panel.label}`,
        icon: panel.icon,
        run: () => app.togglePanel(panel.id),
      })),
      { label: "Connector", icon: "plug", run: () => app.setView({ page: "connector" }) },
      { label: "Automatic", icon: "automation", run: () => app.setView({ page: "automatic" }) },
      {
        label: "Settings",
        icon: "settings",
        hint: "⌘,",
        run: () => app.setView({ page: "settings" }),
      },
      {
        label: "Toggle sidebar",
        icon: "panel-left",
        hint: "⌘B",
        run: () => app.setView({ sidebar: !app.view.get().sidebar }),
      },
      { label: "Use the light theme", icon: "sun", run: () => app.setView({ theme: "light" }) },
      { label: "Use the dark theme", icon: "moon", run: () => app.setView({ theme: "dark" }) },
      {
        label: "Follow the system theme",
        icon: "sun",
        run: () => app.setView({ theme: "system" }),
      },
    ];
    if (sessionId) {
      commands.unshift(
        { label: "Fork this session", icon: "git-fork", run: () => void app.fork(sessionId) },
        {
          label: "Archive this session",
          icon: "archive",
          run: () => app.updateSession({ sessionId, archived: true }),
        },
        {
          label: "Review uncommitted changes",
          icon: "eye",
          run: () => void app.review(sessionId, { kind: "uncommitted" }),
        },
        {
          label: "Compact this session's context",
          icon: "collapse",
          run: () => void app.attempt(app.request("session.compact", { sessionId })),
        },
      );
    }
    const rows: (Command & { score: number })[] = [];
    for (const info of Object.values(sessions)) {
      const title = sessionTitle(info);
      const score = query ? fuzzyScore(`${title} ${info.cwd}`, query) : info.updatedAt / 1e13;
      if (score > 0) {
        rows.push({
          label: title,
          sub: basename(info.cwd),
          icon: "message",
          run: () => app.selectSession(info.id),
          score,
        });
      }
    }
    rows.sort((a, b) => b.score - a.score);
    const matching = commands.filter((command) => fuzzyScore(command.label, query) > 0);
    return { commands: matching, sessions: rows.slice(0, query ? 30 : 8) };
  }, [app, sessions, sessionId, query]);

  const flat: Command[] = [...results.sessions, ...results.commands];
  const run = (command: Command | undefined) => {
    if (!command) return;
    close();
    command.run();
  };
  return (
    <Dialog label="Command palette" onClose={close} wide top>
      <label className="palette-search">
        <Icon name="search" className="muted" />
        <input
          className="palette-input bare"
          placeholder="Search sessions and commands"
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((active + step + flat.length) % Math.max(flat.length, 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              run(flat[active]);
            }
          }}
        />
      </label>
      <div className="palette-list fade-y no-scrollbar">
        {flat.length === 0 ? <div className="note">Nothing matches.</div> : null}
        <MenuList
          active={active}
          onPick={(entry) => entry.onSelect()}
          entries={[
            ...(results.sessions.length ? [{ heading: "Sessions" } as const] : []),
            ...results.sessions.map((command) => ({
              label: command.label,
              ...(command.sub ? { sub: command.sub } : {}),
              ...(command.icon ? { icon: command.icon } : {}),
              onSelect: () => run(command),
            })),
            ...(results.commands.length ? [{ heading: "Commands" } as const] : []),
            ...results.commands.map((command) => ({
              label: command.label,
              ...(command.icon ? { icon: command.icon } : {}),
              ...(command.hint ? { hint: command.hint } : {}),
              onSelect: () => run(command),
            })),
          ]}
        />
      </div>
    </Dialog>
  );
}

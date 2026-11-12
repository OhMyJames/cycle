import type { SessionInfo } from "@cycle/protocol";
import { useState } from "react";
import { type PanelId, sessionTitle } from "../client/app.ts";
import { host } from "../client/host.ts";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { basename } from "../lib/format.ts";
import { Icon, type IconName } from "./icons.tsx";
import { Menu } from "./menu.tsx";

const PANELS: { id: PanelId; label: string; icon: IconName; hint: string }[] = [
  { id: "overview", label: "Overview", icon: "overview", hint: "⌥⌘O" },
  { id: "changes", label: "Changes", icon: "file-diff", hint: "⌥⌘C" },
  { id: "files", label: "Files", icon: "file", hint: "⌥⌘F" },
  { id: "terminal", label: "Terminal", icon: "terminal", hint: "⌃`" },
];

export function TitleBar({ info, title }: { info: SessionInfo | null; title: string }) {
  const app = useApp();
  const { sidebar, panel } = useStore(app.view, (view) => ({
    sidebar: view.sidebar,
    panel: view.panel,
  }));
  const [renaming, setRenaming] = useState(false);
  const name = info ? sessionTitle(info) : title;
  return (
    <header className="titlebar" data-inset={host.insetTitleBar() && !sidebar}>
      {sidebar ? null : (
        <button
          type="button"
          className="icon-button"
          title="Show sidebar (⌘B)"
          aria-label="Show sidebar"
          onClick={() => app.setView({ sidebar: true })}
        >
          <Icon name="panel-left" />
        </button>
      )}
      {info && renaming ? (
        <input
          className="rename title-rename"
          defaultValue={name}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => {
            setRenaming(false);
            const next = event.currentTarget.value.trim();
            if (next && next !== name) app.updateSession({ sessionId: info.id, title: next });
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = name;
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <h1
          className="truncate"
          title={info ? "Double-click to rename" : undefined}
          onDoubleClick={() => info && setRenaming(true)}
        >
          {name}
        </h1>
      )}
      {info ? (
        <span className="chip muted" title={info.cwd}>
          <Icon name={info.worktree ? "git-branch" : "folder"} size={14} />
          <span className="truncate">{info.branch ?? basename(info.cwd)}</span>
        </span>
      ) : null}
      <span className="grow drag" />
      {info ? (
        <>
          {PANELS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="icon-button"
              aria-pressed={panel === item.id}
              title={`${item.label} (${item.hint})`}
              aria-label={item.label}
              onClick={() => app.togglePanel(item.id)}
            >
              <Icon name={item.icon} />
            </button>
          ))}
          <Menu
            className="icon-button"
            title="Session actions"
            align="end"
            entries={() => [
              { label: "Rename", icon: "edit", onSelect: () => setRenaming(true) },
              { label: "Fork", icon: "git-fork", onSelect: () => void app.fork(info.id) },
              {
                label: "Compact context",
                icon: "compress",
                onSelect: () =>
                  void app.attempt(app.request("session.compact", { sessionId: info.id })),
              },
              {
                label: info.pinned ? "Unpin" : "Pin",
                icon: "pin",
                onSelect: () => app.updateSession({ sessionId: info.id, pinned: !info.pinned }),
              },
              {
                label: "Copy folder path",
                icon: "copy",
                onSelect: () => void navigator.clipboard.writeText(info.cwd),
              },
              { separator: true },
              {
                label: info.archived ? "Unarchive" : "Archive",
                icon: "archive",
                onSelect: () => app.updateSession({ sessionId: info.id, archived: !info.archived }),
              },
            ]}
          >
            <Icon name="more" />
          </Menu>
        </>
      ) : null}
    </header>
  );
}

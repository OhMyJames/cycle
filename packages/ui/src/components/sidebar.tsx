import type { SessionInfo } from "@cycle/protocol";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { type CycleApp, projectOf, sessionTitle } from "../client/app.ts";
import { host } from "../client/host.ts";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import {
  basename,
  compactNumber,
  dayBucket,
  fuzzyScore,
  shortTime,
  tildePath,
} from "../lib/format.ts";
import { Icon, Spinner } from "./icons.tsx";
import { Dialog, Menu, type MenuEntry } from "./menu.tsx";

const PAGE = 60;

interface Group {
  label: string;
  sessions: SessionInfo[];
}

/** The list in the order the owner needs it: what waits on them first. */
export function groupSessions(sessions: SessionInfo[], now: number): Group[] {
  const sorted = sessions.toSorted((a, b) => b.updatedAt - a.updatedAt);
  const groups = new Map<string, SessionInfo[]>();
  const add = (label: string, info: SessionInfo) => {
    const list = groups.get(label);
    if (list) list.push(info);
    else groups.set(label, [info]);
  };
  for (const info of sorted) {
    if (info.status === "waiting") add("Needs you", info);
    else if (info.status === "running") add("Running", info);
    else if (info.pinned) add("Pinned", info);
    else add(dayBucket(info.updatedAt, now), info);
  }
  const order = ["Needs you", "Running", "Pinned", "Today", "Yesterday", "This week", "Earlier"];
  return order.flatMap((label) => {
    const list = groups.get(label);
    return list ? [{ label, sessions: list }] : [];
  });
}

function StatusMark({ info }: { info: SessionInfo }) {
  if (info.status === "running") {
    return (
      <span className="mark running" title="Working">
        <Spinner size={12} />
      </span>
    );
  }
  if (info.status === "waiting") return <span className="mark dot waiting" title="Needs you" />;
  if (info.status === "error")
    return <span className="mark dot error" title="Stopped with an error" />;
  if (info.unread) return <span className="mark dot unread" title="Unread" />;
  if (info.worktree) {
    return (
      <span className="mark" title={`Worktree on ${info.worktree.branch}`}>
        <Icon name="git-branch" size={14} />
      </span>
    );
  }
  return <span className="mark" />;
}

const SessionRow = memo(function SessionRow({
  info,
  active,
  onDelete,
}: {
  info: SessionInfo;
  active: boolean;
  onDelete(info: SessionInfo): void;
}) {
  const app = useApp();
  const [renaming, setRenaming] = useState(false);
  const title = sessionTitle(info);
  const entries = (): MenuEntry[] => [
    { label: "Rename", icon: "edit", onSelect: () => setRenaming(true) },
    {
      label: info.pinned ? "Unpin" : "Pin",
      icon: "pin",
      onSelect: () => app.updateSession({ sessionId: info.id, pinned: !info.pinned }),
    },
    { label: "Fork", icon: "git-fork", onSelect: () => void app.fork(info.id) },
    {
      label: info.unread ? "Mark as read" : "Mark as unread",
      icon: "message",
      onSelect: () => app.updateSession({ sessionId: info.id, unread: !info.unread }),
    },
    {
      label: "Copy session ID",
      icon: "copy",
      onSelect: () => void navigator.clipboard.writeText(info.id),
    },
    { separator: true },
    {
      label: info.archived ? "Unarchive" : "Archive",
      icon: "archive",
      onSelect: () => app.updateSession({ sessionId: info.id, archived: !info.archived }),
    },
    { label: "Delete…", icon: "trash", danger: true, onSelect: () => onDelete(info) },
  ];
  return (
    <div
      className="session-row"
      data-active={active}
      role="button"
      tabIndex={0}
      onClick={() => app.selectSession(info.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") app.selectSession(info.id);
        const sibling =
          event.key === "ArrowDown"
            ? event.currentTarget.nextElementSibling
            : event.key === "ArrowUp"
              ? event.currentTarget.previousElementSibling
              : null;
        if (sibling instanceof HTMLElement && sibling.classList.contains("session-row")) {
          event.preventDefault();
          sibling.focus();
        }
      }}
    >
      <StatusMark info={info} />
      {renaming ? (
        <input
          className="rename"
          defaultValue={title}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.stopPropagation()}
          onBlur={(event) => {
            setRenaming(false);
            const next = event.currentTarget.value.trim();
            if (next && next !== title) app.updateSession({ sessionId: info.id, title: next });
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = title;
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <span className="truncate grow" title={title}>
          {title}
        </span>
      )}
      <span className="time caption tabular">{shortTime(info.updatedAt, Date.now())}</span>
      <span className="row-menu" onClick={(event) => event.stopPropagation()}>
        <Menu entries={entries} className="icon-button small" title="Session actions" align="end">
          <Icon name="more" />
        </Menu>
      </span>
    </div>
  );
});

function projectEntries(app: CycleApp, projects: string[], current: string | null): MenuEntry[] {
  const home = app.daemon.get()?.userHome;
  return [
    {
      label: "All projects",
      icon: "list",
      checked: current === null,
      onSelect: () => app.setView({ project: null }),
    },
    ...(projects.length ? [{ separator: true } as const] : []),
    ...projects.map((path): MenuEntry => ({
      label: basename(path),
      sub: tildePath(path, home),
      icon: "folder",
      checked: path === current,
      onSelect: () => app.setView({ project: path }),
    })),
    { separator: true },
    { label: "Open folder…", icon: "plus", hint: "⇧⌘N", onSelect: () => void app.pickFolder() },
  ];
}

function DeleteDialog({ info, onClose }: { info: SessionInfo; onClose(): void }) {
  const app = useApp();
  const [removeWorktree, setRemoveWorktree] = useState(false);
  return (
    <Dialog label="Delete session" onClose={onClose}>
      <div className="dialog-body">
        <strong>Delete “{sessionTitle(info)}”?</strong>
        <p className="meta muted">Its conversation is removed for good. This cannot be undone.</p>
        {info.worktree ? (
          <label className="row meta">
            <input
              type="checkbox"
              checked={removeWorktree}
              onChange={(event) => setRemoveWorktree(event.currentTarget.checked)}
            />
            Also remove its worktree folder (the branch {info.worktree.branch} is kept)
          </label>
        ) : null}
      </div>
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button danger"
          autoFocus
          onClick={() => {
            onClose();
            void app.deleteSession(info.id, removeWorktree);
          }}
        >
          Delete
        </button>
      </div>
    </Dialog>
  );
}

function Footer() {
  const app = useApp();
  const account = useStore(app.account, (value) => value);
  const usage = useStore(app.usage, (value) => value);
  const theme = useStore(app.view, (view) => view.theme);
  const settingsOpen = useStore(app.view, (view) => view.page === "settings");
  const who =
    account === null
      ? "…"
      : account.kind === null
        ? "Not signed in"
        : (account.email ?? (account.kind === "apiKey" ? "API key" : "Signed in"));
  return (
    <div className="sidebar-footer">
      <button
        type="button"
        className="ghost grow"
        aria-pressed={settingsOpen}
        title="Settings (⌘,)"
        onClick={() => app.setView({ page: settingsOpen ? "thread" : "settings" })}
      >
        <Icon name="settings" />
        <span className="truncate">{who}</span>
      </button>
      {usage && usage.tokens.total > 0 ? (
        <span
          className="caption muted tabular"
          title={`Today: ${usage.tokens.input.toLocaleString()} in, ${usage.tokens.output.toLocaleString()} out, ${usage.turns} turns`}
        >
          {compactNumber(usage.tokens.total)} today
        </span>
      ) : null}
      <button
        type="button"
        className="icon-button"
        title="Switch between light and dark"
        aria-label="Switch between light and dark"
        onClick={() => {
          const dark = document.documentElement.dataset["theme"] === "dark";
          app.setView({ theme: theme === "system" ? (dark ? "light" : "dark") : "system" });
        }}
      >
        <Icon name={document.documentElement.dataset["theme"] === "dark" ? "sun" : "moon"} />
      </button>
    </div>
  );
}

function Archived({ onDelete }: { onDelete(info: SessionInfo): void }) {
  const app = useApp();
  const archived = useStore(app.archived, (value) => value);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open && archived === null) void app.loadArchived();
  }, [open, archived, app]);
  return (
    <div className="archived">
      <button type="button" className="nav-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="archive" />
        <span className="grow">Archived</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {open ? (
        <div className="archived-list">
          {archived === null ? (
            <div className="note">Reading the archive…</div>
          ) : archived.length === 0 ? (
            <div className="note">Nothing archived.</div>
          ) : (
            archived.map((info) => (
              <SessionRow key={info.id} info={info} active={false} onDelete={onDelete} />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export function Sidebar() {
  const app = useApp();
  const sessions = useStore(app.sessions, (value) => value);
  const projectsSetting = useStore(app.settings, (settings) => settings?.projects);
  const { sessionId, project } = useStore(app.view, (view) => ({
    sessionId: view.sessionId,
    project: view.project,
  }));
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [deleting, setDeleting] = useState<SessionInfo | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => Object.values(sessions.byId), [sessions.byId]);
  const projects = useMemo(() => {
    const seen = new Set<string>(projectsSetting ?? []);
    for (const info of all) seen.add(projectOf(info));
    return [...seen];
  }, [all, projectsSetting]);
  const groups = useMemo(() => {
    let list = project && !query ? all.filter((info) => projectOf(info) === project) : all;
    if (query) {
      list = list.filter(
        (info) => fuzzyScore(`${sessionTitle(info)} ${info.preview} ${info.cwd}`, query) > 0,
      );
    }
    return groupSessions(list, Date.now());
  }, [all, project, query]);

  useEffect(() => {
    const focusSearch = () => searchRef.current?.focus();
    window.addEventListener("cycle:search", focusSearch);
    return () => window.removeEventListener("cycle:search", focusSearch);
  }, []);

  let shown = 0;
  const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);
  return (
    <aside className="sidebar" data-inset={host.insetTitleBar()}>
      <div className="sidebar-top">
        <Menu
          entries={() => projectEntries(app, projects, project)}
          className="ghost project-switch"
          title="Choose a project"
        >
          <Icon name="folder" />
          <span className="truncate">{project ? basename(project) : "All projects"}</span>
          <Icon name="chevron-down" size={12} />
        </Menu>
        <span className="grow" />
        <button
          type="button"
          className="icon-button"
          title="New session (⌘N)"
          aria-label="New session"
          onClick={() => app.newSession()}
        >
          <Icon name="compose" />
        </button>
      </div>
      <div className="sidebar-search">
        <Icon name="search" />
        <input
          ref={searchRef}
          placeholder="Search sessions"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setLimit(PAGE);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
              event.currentTarget.blur();
            }
            const first = groups[0]?.sessions[0];
            if (event.key === "Enter" && first && !event.nativeEvent.isComposing) {
              app.selectSession(first.id);
            }
          }}
        />
        {query ? null : <kbd>⌘K</kbd>}
      </div>
      <div className="session-list" role="list">
        {!sessions.loaded ? (
          <div className="skeleton" role="status" aria-label="Reading sessions">
            {[72, 54, 88, 61, 79].map((width) => (
              <span key={width} style={{ width: `${width}%` }} />
            ))}
          </div>
        ) : total === 0 ? (
          <div className="note">
            {query
              ? "No sessions match your search."
              : project
                ? "No sessions in this project yet."
                : "No sessions yet."}
          </div>
        ) : (
          groups.map((group) => {
            if (shown >= limit) return null;
            const rows = group.sessions.slice(0, limit - shown);
            shown += rows.length;
            return (
              <section key={group.label}>
                <h3 data-attention={group.label === "Needs you"}>{group.label}</h3>
                {rows.map((info) => (
                  <SessionRow
                    key={info.id}
                    info={info}
                    active={info.id === sessionId}
                    onDelete={setDeleting}
                  />
                ))}
              </section>
            );
          })
        )}
        {total > limit ? (
          <button type="button" className="nav-row muted" onClick={() => setLimit(limit + PAGE)}>
            Show {Math.min(PAGE, total - limit)} more
          </button>
        ) : null}
      </div>
      <Archived onDelete={setDeleting} />
      <Footer />
      {deleting ? <DeleteDialog info={deleting} onClose={() => setDeleting(null)} /> : null}
    </aside>
  );
}

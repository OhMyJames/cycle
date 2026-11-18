import type { Session } from "@cycle/protocol";
import { isComposing } from "@ui-sdk/core";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@ui-sdk/react/popover";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CycleApp,
  type PageId,
  type SettingsSection,
  projectOf,
  sessionTitle,
} from "../client/app.ts";
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
import { remoteWarning, whereLabel } from "../lib/remote.ts";
import { ApprovalCard } from "./approval.tsx";
import { Icon, type IconName, Spinner } from "./icons.tsx";
import { Dialog, Menu, type MenuEntry, useDismiss } from "./menu.tsx";

const PAGE = 60;

interface Group {
  label: string;
  sessions: Session[];
}

/** The list in the order the owner needs it: what waits on them first. */
export function groupSessions(sessions: Session[], now: number): Group[] {
  const sorted = sessions.toSorted((a, b) => b.updatedAt - a.updatedAt);
  const groups = new Map<string, Session[]>();
  const add = (label: string, info: Session) => {
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

/** What a row leads with: what its session is doing, or else where it works. */
function StatusMark({ info }: { info: Session }) {
  if (info.status === "running") {
    return (
      <span className="mark" role="img" aria-label="Running" title="Running">
        <Spinner size={14} className="tone-running" />
      </span>
    );
  }
  if (info.status === "waiting") {
    return (
      <span
        className="mark"
        role="img"
        aria-label="Needs your approval"
        title="Needs your approval"
      >
        <span className="dot waiting" />
      </span>
    );
  }
  if (info.status === "error") {
    return (
      <span
        className="mark"
        role="img"
        aria-label="Stopped with an error"
        title="Stopped with an error"
      >
        <span className="dot error" />
      </span>
    );
  }
  if (info.unread) {
    return (
      <span className="mark" role="img" aria-label="New activity" title="New activity">
        <span className="dot unread" />
      </span>
    );
  }
  if (info.worktree) {
    return (
      <span className="mark place" title={`Worktree on ${info.worktree.branch}`}>
        <Icon name="git-branch" size={14} />
      </span>
    );
  }
  return null;
}

/**
 * What a session waits on, answered from its row: the same card as in its conversation, beside the
 * row, so the owner sees the command before allowing it and need not leave what they are reading.
 * The focus starts on Deny: opening it is not yet an answer.
 */
function AnswerHere({ info }: { info: Session }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const approvals = useStore(app.conversation(info.id), (value) => value.state?.approvals);
  const approval = approvals?.[0];
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) app.peek(info.id);
      }}
    >
      <PopoverTrigger className="row-answer">Answer</PopoverTrigger>
      <PopoverContent
        className="answer-popover"
        side="right"
        align="start"
        sideOffset={12}
        initialFocus="[data-refuses]"
      >
        <PopoverTitle className="answer-title fade-x">{sessionTitle(info)}</PopoverTitle>
        {approval ? (
          <ApprovalCard
            key={approval.id}
            sessionId={info.id}
            approval={approval}
            waiting={(approvals?.length ?? 1) - 1}
          />
        ) : (
          <p className="muted" role="status">
            {approvals ? "Nothing waits here any more." : "Reading the session…"}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * A list of sessions is one Tab stop: the row the focus was last on, else the open session's, else
 * the first. The arrow keys do the rest, so Tab crosses the sidebar in a few presses however many
 * sessions there are. A list takes it as its `ref`.
 */
function oneTabStop(node: HTMLElement | null): (() => void) | undefined {
  if (!node) return undefined;
  const set = () => {
    const triggers = [...node.querySelectorAll<HTMLElement>(".session-row-trigger")];
    const at = document.activeElement;
    const stop =
      triggers.find((each) => each.closest(".session-row")?.contains(at)) ??
      triggers.find((each) => each.closest('.session-row[data-active="true"]')) ??
      triggers[0];
    for (const each of triggers) each.tabIndex = each === stop ? 0 : -1;
    // The buttons at a row's end are reached with the right arrow. What the Answer popover holds
    // is drawn inside its row and keeps its own Tab order.
    const ends = node.querySelectorAll<HTMLElement>(
      ".session-row button:not(.session-row-trigger)",
    );
    for (const each of ends) if (!each.closest(".answer-popover")) each.tabIndex = -1;
  };
  set();
  node.addEventListener("focusin", set);
  const watch = new MutationObserver(set);
  watch.observe(node, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-active"],
  });
  return () => {
    node.removeEventListener("focusin", set);
    watch.disconnect();
  };
}

/**
 * Up and down move between a list's rows, Home and End to its ends, right from a row to the
 * buttons at its end and left back.
 */
function onRowsKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const { target } = event;
  if (!(target instanceof HTMLElement)) return;
  // The Answer popover is drawn inside its row: keys pressed in it are its own.
  if (target.closest(".answer-popover")) return;
  const row = target.closest(".session-row");
  const trigger = row?.querySelector<HTMLElement>(".session-row-trigger");
  if (!row || !trigger) return;
  if (target === trigger) {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const all = [...event.currentTarget.querySelectorAll<HTMLElement>(".session-row-trigger")];
      const next =
        event.key === "Home"
          ? all[0]
          : event.key === "End"
            ? all.at(-1)
            : all[all.indexOf(trigger) + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        next.focus();
        event.preventDefault();
      }
    } else if (event.key === "ArrowRight") {
      row.querySelector<HTMLElement>("button:not(.session-row-trigger)")?.focus();
    }
    return;
  }
  // Among the buttons at a row's end: right to the next, left to the one before or back to the row.
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const ends = [...row.querySelectorAll<HTMLElement>("button:not(.session-row-trigger)")];
  const at = ends.indexOf(target.closest("button") ?? target);
  if (at === -1) return;
  (event.key === "ArrowRight" ? ends[at + 1] : (ends[at - 1] ?? trigger))?.focus();
}

/**
 * One session in the sidebar: its status or where it runs in the gutter, its title, and its menu.
 * Every row reaches the sidebar's edge, rounded on the left only, so the open session's row joins
 * the workspace. The lead is a 24px column, the title starts at 28, and fades where it ends.
 */
const SessionRow = memo(function SessionRow({
  info,
  active,
  onDelete,
}: {
  info: Session;
  active: boolean;
  onDelete(info: Session): void;
}) {
  const app = useApp();
  const [renaming, setRenaming] = useState(false);
  const [tagging, setTagging] = useState(false);
  const title = sessionTitle(info);
  const tags = app.capabilities(info.harness).tags;
  const tagEntries: MenuEntry[] = !tags
    ? []
    : [
        {
          label: info.tag ? "Change tag…" : "Add tag…",
          icon: "star",
          onSelect: () => setTagging(true),
        },
        ...(info.tag
          ? [
              {
                label: "Remove tag",
                icon: "x" as const,
                onSelect: () => app.updateSession({ sessionId: info.id, tag: null }),
              },
            ]
          : []),
      ];
  const entries = (): MenuEntry[] => [
    { label: "Rename", icon: "edit", onSelect: () => setRenaming(true) },
    ...tagEntries,
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
      icon: info.archived ? "undo" : "archive",
      onSelect: () => app.updateSession({ sessionId: info.id, archived: !info.archived }),
    },
    { label: "Delete…", icon: "trash", danger: true, onSelect: () => onDelete(info) },
  ];
  return (
    <div
      className="session-row control-row"
      data-active={active}
      aria-current={active ? "true" : undefined}
    >
      {tagging ? (
        <input
          className="field rename"
          aria-label="Tag for this conversation"
          placeholder="Tag"
          maxLength={40}
          defaultValue={info.tag ?? ""}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => {
            setTagging(false);
            const next = event.currentTarget.value.trim();
            if (next !== (info.tag ?? "")) {
              app.updateSession({ sessionId: info.id, tag: next || null });
            }
          }}
          onKeyDown={(event) => {
            if (isComposing(event)) return;
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.stopPropagation();
              event.currentTarget.value = info.tag ?? "";
              event.currentTarget.blur();
            }
          }}
        />
      ) : renaming ? (
        <input
          className="field rename"
          aria-label="Rename conversation"
          defaultValue={title}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => {
            setRenaming(false);
            const next = event.currentTarget.value.trim();
            if (next && next !== title) app.updateSession({ sessionId: info.id, title: next });
          }}
          onKeyDown={(event) => {
            if (isComposing(event)) return;
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.stopPropagation();
              event.currentTarget.value = title;
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="session-row-trigger"
          title={`${title} · ${shortTime(info.updatedAt, Date.now())}`}
          onClick={() => app.selectSession(info.id)}
        >
          <span className="lead">
            <StatusMark info={info} />
          </span>
          <span className="session-row-title fade-x">{title}</span>
          {info.tag ? <span className="session-tag">{info.tag}</span> : null}
          {info.scheduleId ? (
            <span className="schedule-mark" role="img" aria-label="Started by a schedule">
              <Icon name="automation" size={12} />
            </span>
          ) : null}
        </button>
      )}
      {!renaming && !tagging && info.status === "waiting" && !active ? (
        <AnswerHere info={info} />
      ) : null}
      {renaming || tagging ? null : (
        <span className="row-menu">
          <Menu
            entries={entries}
            className="icon-button small"
            title={`More options for ${title}`}
            side="right"
            width={200}
          >
            <Icon name="more" size={14} />
          </Menu>
        </span>
      )}
    </div>
  );
});

function projectEntries(app: CycleApp, projects: string[], current: string | null): MenuEntry[] {
  const home = app.daemon.get()?.userHome;
  return [
    {
      label: "All projects",
      icon: "projects",
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

function DeleteDialog({ info, onClose }: { info: Session; onClose(): void }) {
  const app = useApp();
  const [removeWorktree, setRemoveWorktree] = useState(false);
  return (
    <Dialog label="Delete session" onClose={onClose}>
      <div className="dialog-body">
        <h2 className="dialog-title">Delete “{sessionTitle(info)}”?</h2>
        <p className="dialog-text">Its conversation is removed for good. This cannot be undone.</p>
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
        <button type="button" className="button" autoFocus onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button danger"
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

/** The pages a nav row opens in the main area, and stays pressed for. */
const PAGES: { page: PageId; label: string; icon: IconName }[] = [
  { page: "connector", label: "Connector", icon: "plug" },
  { page: "automatic", label: "Automatic", icon: "automation" },
];

const THEMES = [
  { value: "system", label: "System (default)" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

/** Says where the agents run, whenever the window shows a remote server. */
function WhereBadge() {
  const app = useApp();
  const label = useStore(app.remote, whereLabel);
  const warning = useStore(app.remote, remoteWarning);
  if (label === null) return null;
  const open = () => app.setView({ page: "settings", settingsSection: "remotes" });
  return (
    <>
      <button
        type="button"
        className="nav-row update-ready"
        title="Agents run their commands on that server, not on this computer"
        onClick={open}
      >
        <span className="nav-icon">
          <Icon name="globe" />
        </span>
        <span className="grow fade-x">{label}</span>
      </button>
      {warning ? (
        <button type="button" className="nav-row where-warning" role="status" onClick={open}>
          <span className="nav-icon">
            <Icon name="warning" />
          </span>
          <span className="grow">{warning}</span>
        </button>
      ) : null}
    </>
  );
}

/** Shown only while a downloaded update waits for the owner, who installs it from About. */
function UpdateReady() {
  const app = useApp();
  const version = useStore(app.update, (update) =>
    update?.status === "ready" ? update.version : null,
  );
  if (version === null) return null;
  return (
    <button
      type="button"
      className="nav-row update-ready"
      title={`Version ${version} is downloaded`}
      onClick={() => app.setView({ page: "settings", settingsSection: "about" })}
    >
      <span className="nav-icon">
        <Icon name="download" />
      </span>
      <span className="grow fade-x">Update ready</span>
    </button>
  );
}

/**
 * The footer: a rule, then the account, which opens its menu, and today's tokens. Both run 12 from
 * either edge, as the rule over the project does.
 */
function Footer() {
  const app = useApp();
  // The main agent's account is the one the footer names, unless another agent is signed in and it
  // is not: "Not signed in" would then be untrue of the owner.
  const account = useStore(app.accounts, (all) => {
    const main = all[app.mainHarness()] ?? null;
    if (main && main.kind !== null) return main;
    return Object.values(all).find((each) => each.kind !== null) ?? main;
  });
  const usage = useStore(app.usage, (value) => value);
  const theme = useStore(app.view, (view) => view.theme);
  const settingsOpen = useStore(app.view, (view) => view.page === "settings");
  const who =
    account === null
      ? "Account"
      : account.kind === null
        ? "Not signed in"
        : (account.email ?? (account.kind === "apiKey" ? "API key" : "Signed in"));
  const initial = account?.email?.charAt(0).toUpperCase() ?? "";
  return (
    <footer className="sidebar-footer">
      <div className="rule" />
      <WhereBadge />
      <UpdateReady />
      <div className="footer-row">
        <Menu
          className="control-ghost account"
          side="top"
          width={232}
          entries={() => [
            { heading: who },
            {
              label: "Settings",
              icon: "settings",
              hint: "⌘,",
              onSelect: () => app.setView({ page: settingsOpen ? "thread" : "settings" }),
            },
            { separator: true },
            { heading: "Appearance" },
            ...THEMES.map((each): MenuEntry => ({
              label: each.label,
              checked: theme === each.value,
              onSelect: () => app.setView({ theme: each.value }),
            })),
          ]}
        >
          <span className="avatar">{initial}</span>
          <span className="fade-x">{who}</span>
        </Menu>
        {usage && usage.tokens.total > 0 ? (
          <button
            type="button"
            className="ghost meta muted tabular usage-today"
            title={`Today: ${usage.tokens.input.toLocaleString()} in, ${usage.tokens.output.toLocaleString()} out, ${usage.turns} turns`}
            onClick={() => app.setView({ page: "settings", settingsSection: "account" })}
          >
            {compactNumber(usage.tokens.total)}
          </button>
        ) : null}
      </div>
    </footer>
  );
}

/**
 * Archived sessions: a nav row with their count, opening a panel over the list with a field to
 * search them and their rows, 32 high.
 */
function Archived({ onDelete }: { onDelete(info: Session): void }) {
  const app = useApp();
  const archived = useStore(app.archived, (value) => value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, ref, close);
  useEffect(() => {
    if (open && archived === null) void app.loadArchived();
  }, [open, archived, app]);
  const shown = (archived ?? []).filter(
    (info) =>
      !query || fuzzyScore(`${sessionTitle(info)} ${info.tag ?? ""} ${info.preview}`, query) > 0,
  );
  return (
    <div className="archived" ref={ref}>
      <button type="button" className="nav-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="nav-icon">
          <Icon name="archive" />
        </span>
        <span className="grow fade-x">Archived</span>
        <span className="nav-trailing">
          {archived ? <span className="muted tabular">{archived.length}</span> : null}
        </span>
      </button>
      {open ? (
        <div className="archived-panel" role="dialog" aria-label="Archived sessions">
          <label className="archived-search">
            <span className="nav-icon">
              <Icon name="search" />
            </span>
            <input
              type="search"
              className="bare"
              aria-label="Search archived sessions"
              placeholder="Search archived"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <div
            className="archived-list fade-y no-scrollbar"
            ref={oneTabStop}
            onKeyDown={onRowsKeyDown}
          >
            {archived === null ? (
              <p className="archived-note">Reading the archive…</p>
            ) : shown.length === 0 ? (
              <p className="archived-note">
                {archived.length ? "No archived sessions match." : "Nothing archived."}
              </p>
            ) : (
              shown.map((info) => (
                <SessionRow key={info.id} info={info} active={false} onDelete={onDelete} />
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const SETTINGS: { section: SettingsSection; label: string; icon: IconName }[] = [
  { section: "general", label: "General", icon: "sliders" },
  { section: "account", label: "Account and usage", icon: "user" },
  { section: "providers", label: "Model providers", icon: "sparkle" },
  { section: "sandboxes", label: "Sandboxes", icon: "file-lock" },
  { section: "remotes", label: "Remote servers", icon: "globe" },
  { section: "about", label: "About", icon: "info" },
];

/** The sidebar while Settings is open: the way back, then its sections. */
function SettingsSidebar() {
  const app = useApp();
  const section = useStore(app.view, (view) => view.settingsSection);
  // Remote servers are the desktop app's: a browser has no bridge to them.
  const hasRemote = useStore(app.remote, (view) => view !== null);
  return (
    <aside className="sidebar" data-inset={host.insetTitleBar()}>
      <div className="sidebar-top">
        <button
          type="button"
          className="icon-button"
          title="Hide sidebar (⌘B)"
          aria-label="Hide sidebar"
          onClick={() => app.setView({ sidebar: false })}
        >
          <Icon name="panel-left" />
        </button>
      </div>
      <nav className="sidebar-nav" aria-label="Settings">
        <button type="button" className="nav-row" onClick={() => app.setView({ page: "thread" })}>
          <span className="nav-icon">
            <Icon name="arrow-left" />
          </span>
          <span className="grow fade-x">Back to sessions</span>
          <span className="nav-trailing">
            <kbd>Esc</kbd>
          </span>
        </button>
      </nav>
      <div className="rule inset" />
      <nav className="sidebar-nav" aria-label="Settings sections">
        {SETTINGS.filter((each) => hasRemote || each.section !== "remotes").map((each) => (
          <button
            key={each.section}
            type="button"
            className="nav-row"
            aria-current={section === each.section ? "page" : undefined}
            onClick={() => app.setView({ settingsSection: each.section })}
          >
            <span className="nav-icon">
              <Icon name={each.icon} />
            </span>
            <span className="grow fade-x">{each.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

export function Sidebar() {
  const app = useApp();
  const settings = useStore(app.view, (view) => view.page === "settings");
  return settings ? <SettingsSidebar /> : <SessionSidebar />;
}

function SessionSidebar() {
  const app = useApp();
  const sessions = useStore(app.sessions, (value) => value);
  const projectsSetting = useStore(app.settings, (settings) => settings?.projects);
  const { sessionId, project, page } = useStore(app.view, (view) => ({
    sessionId: view.sessionId,
    project: view.project,
    page: view.page,
  }));
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);

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
        (info) =>
          fuzzyScore(`${sessionTitle(info)} ${info.tag ?? ""} ${info.preview} ${info.cwd}`, query) >
          0,
      );
    }
    return groupSessions(list, Date.now());
  }, [all, project, query]);

  useEffect(() => {
    const focusSearch = () => {
      setSearching(true);
      searchRef.current?.focus();
    };
    window.addEventListener("cycle:search", focusSearch);
    return () => window.removeEventListener("cycle:search", focusSearch);
  }, []);

  let shown = 0;
  const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);
  return (
    <aside className="sidebar" data-inset={host.insetTitleBar()}>
      <div className="sidebar-top">
        <button
          ref={searchButton}
          type="button"
          className="icon-button"
          title="Search sessions"
          aria-label="Search sessions"
          aria-pressed={searching}
          onClick={() => {
            setSearching(!searching);
            setQuery("");
          }}
        >
          <Icon name="search" />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Hide sidebar (⌘B)"
          aria-label="Hide sidebar"
          onClick={() => app.setView({ sidebar: false })}
        >
          <Icon name="panel-left" />
        </button>
      </div>
      {searching ? (
        <div className="sidebar-search">
          <input
            ref={searchRef}
            className="field"
            aria-label="Search sessions"
            placeholder="Search sessions"
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setLimit(PAGE);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setQuery("");
                setSearching(false);
                // The field goes away with the focus in it: give it back to what opened it.
                searchButton.current?.focus();
              }
              const first = groups[0]?.sessions[0];
              if (event.key === "Enter" && first && !isComposing(event)) {
                app.selectSession(first.id);
              }
            }}
          />
        </div>
      ) : null}
      <nav className="sidebar-nav" aria-label="Sidebar">
        <button type="button" className="nav-row new-session" onClick={() => app.newSession()}>
          <span className="nav-icon">
            <Icon name="plus" />
          </span>
          <span className="grow fade-x">New</span>
          <span className="nav-trailing">
            <kbd>⌘ N</kbd>
          </span>
        </button>
        {PAGES.map((each) => (
          <button
            key={each.page}
            type="button"
            className="nav-row"
            aria-current={page === each.page ? "page" : undefined}
            onClick={() => app.setView({ page: page === each.page ? "thread" : each.page })}
          >
            <span className="nav-icon">
              <Icon name={each.icon} />
            </span>
            <span className="grow fade-x">{each.label}</span>
          </button>
        ))}
      </nav>
      <div className="rule inset" />
      <div className="sidebar-project">
        <Menu
          entries={() => projectEntries(app, projects, project)}
          className="nav-row project-switch"
          title="Choose a project"
        >
          <span className="nav-icon">
            <Icon name="folder" />
          </span>
          <span className="grow fade-x">{project ? basename(project) : "All projects"}</span>
          <span className="nav-trailing">
            <Icon name="chevrons-up-down" size={14} className="muted" />
          </span>
        </Menu>
      </div>
      <div className="session-list fade-y no-scrollbar" ref={oneTabStop} onKeyDown={onRowsKeyDown}>
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
                <h3>
                  <span className="fade-x">{group.label}</span>
                </h3>
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
          <button
            type="button"
            className="nav-row more muted"
            onClick={() => setLimit(limit + PAGE)}
          >
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

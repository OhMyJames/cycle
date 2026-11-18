import type { WorktreeEntry } from "@cycle/protocol";
import { useEffect, useMemo, useState } from "react";
import { projectOf } from "../client/app.ts";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { basename, tailPath, tildePath } from "../lib/format.ts";
import { describeRemoval, describeWorktree, worktreeKey } from "../lib/worktrees.ts";
import { Dialog } from "./menu.tsx";

function WorktreeRow({
  entry,
  home,
  busy,
  onRemove,
}: {
  entry: WorktreeEntry;
  home: string | undefined;
  /** Being removed: confirmed, and the list not yet read again. */
  busy: boolean;
  onRemove(): void;
}) {
  const view = describeWorktree(entry);
  const path = tildePath(entry.path, home);
  return (
    <div className="setting">
      <div className="grow worktree-body">
        <div className="worktree-title">
          <span className="setting-name">{view.name}</span>
          {view.marks.map((mark) => (
            <span key={mark.label} className={`chip tone-${mark.tone}`}>
              {mark.label}
            </span>
          ))}
        </div>
        <div className="caption muted" title={path}>
          {tailPath(path)}
        </div>
        {view.origin ? <div className="caption muted">{view.origin}</div> : null}
        {view.users.length ? (
          <div className="caption muted">
            Used by{" "}
            {view.users.map((user, index) => (
              <span key={user.id}>
                {index ? ", " : ""}
                {user.label}
              </span>
            ))}
          </div>
        ) : null}
        {view.removal.blocked ? (
          <div className="caption tone-warning">{view.removal.blocked}</div>
        ) : null}
      </div>
      {view.removal.offered ? (
        <button
          type="button"
          className="button"
          disabled={busy || view.removal.blocked !== null}
          aria-label={`Remove the worktree ${view.name}`}
          onClick={onRemove}
        >
          {busy ? "Removing…" : "Remove…"}
        </button>
      ) : null}
    </div>
  );
}

/** A workspace's worktrees, the sessions that use each, and a way to remove the ones Cycle made. */
export function WorktreesSection() {
  const app = useApp();
  const projects = useStore(app.settings, (settings) => settings?.projects);
  const home = useStore(app.daemon, (daemon) => daemon?.userHome);
  const inView = useStore(app.view, (view) => {
    const session = view.sessionId ? app.sessions.get().byId[view.sessionId] : undefined;
    return session ? projectOf(session) : view.project;
  });
  const { workspace: shown, worktrees, problem } = useStore(app.worktrees, (value) => value);
  // A folder just opened has a new session's draft but is in no list yet.
  const drafting = useStore(app.view, (view) => view.draft?.cwd ?? null);
  const workspaces = useMemo(
    () => [
      ...new Set([
        ...(inView ? [inView] : []),
        ...(drafting ? [drafting] : []),
        ...(projects ?? []),
      ]),
    ],
    [inView, drafting, projects],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const workspace = chosen ?? workspaces[0] ?? null;
  const [removing, setRemoving] = useState<WorktreeEntry | null>(null);
  /** Paths being removed: confirmed, and the list not yet read again. */
  const [busy, setBusy] = useState<string[]>([]);

  // A session entering or leaving a worktree while the list is open is read again: the page hears
  // of it in the sessions, which carry their worktree.
  const used = useStore(app.sessions, (value) => worktreeKey(Object.values(value.byId)));
  useEffect(() => {
    if (workspace) void app.loadWorktrees(workspace);
  }, [app, workspace, used]);

  if (workspaces.length === 0) {
    return (
      <div className="empty-card">
        <p>No workspace yet</p>
        <p className="caption muted">
          Open a folder, and the worktrees of its repository are here.
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="card">
        <div className="setting">
          <label className="grow" htmlFor="worktree-workspace">
            <div className="setting-name">Workspace</div>
            <div className="caption muted">The worktrees of its repository are listed.</div>
          </label>
          <select
            id="worktree-workspace"
            className="field select"
            value={workspace ?? ""}
            onChange={(event) => setChosen(event.currentTarget.value)}
          >
            {(workspace && !workspaces.includes(workspace)
              ? [workspace, ...workspaces]
              : workspaces
            ).map((path) => (
              <option key={path} value={path}>
                {basename(path)} ({tildePath(path, home)})
              </option>
            ))}
          </select>
        </div>
      </div>

      <h2>In this repository</h2>
      {shown !== workspace ? (
        <div className="note">Reading the worktrees…</div>
      ) : problem ? (
        <div className="card">
          <div className="note" role="alert">
            {problem}
          </div>
        </div>
      ) : worktrees === null ? (
        <div className="note">Reading the worktrees…</div>
      ) : worktrees.length === 0 ? (
        <div className="empty-card">
          <p>No worktrees.</p>
          <p className="caption muted">
            Start a session in a new worktree, from the composer, to have one here.
          </p>
        </div>
      ) : (
        <div className="card">
          {worktrees.map((entry) => (
            <WorktreeRow
              key={entry.path}
              entry={entry}
              home={home}
              busy={busy.includes(entry.path)}
              onRemove={() => setRemoving(entry)}
            />
          ))}
        </div>
      )}
      <div className="caption muted">
        Worktrees made by hand with git, or by an agent's own tool, are listed and are not removed
        here: remove those with git.
      </div>

      {removing && workspace ? (
        <RemoveDialog
          entry={removing}
          workspace={workspace}
          home={home}
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            // The row stays disabled until the list is read again, so it cannot be confirmed twice.
            const { path } = removing;
            setBusy((now) => [...now, path]);
            void app
              .removeWorktree(workspace, path)
              .finally(() => setBusy((now) => now.filter((one) => one !== path)));
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The question before a removal. It reads the list as it opens and says what is true of the
 * worktree then: what the row showed may be older (changes made since are lost with the folder).
 */
function RemoveDialog({
  entry,
  workspace,
  home,
  onClose,
  onConfirm,
}: {
  entry: WorktreeEntry;
  workspace: string;
  home: string | undefined;
  onClose(): void;
  onConfirm(): void;
}) {
  const app = useApp();
  const [read, setRead] = useState<WorktreeEntry[] | string | null>(null);
  useEffect(() => {
    let current = true;
    void app.loadWorktrees(workspace).then((answer) => {
      if (current) setRead(answer);
    });
    return () => {
      current = false;
    };
  }, [app, workspace]);
  const asked = read === null ? null : describeRemoval(entry, read);
  return (
    <Dialog label="Remove worktree" onClose={onClose}>
      <div className="dialog-body">
        <h2 className="dialog-title">
          {asked?.title ?? describeWorktree(entry).confirmation.title}
        </h2>
        <p className="dialog-text">{tildePath(entry.path, home)}</p>
        {asked === null ? <p className="dialog-text">Checking what is in it…</p> : null}
        {asked?.lines.map((line) => (
          <p key={line} className="dialog-text">
            {line}
          </p>
        ))}
        {asked?.blocked ? (
          <p className="dialog-text tone-warning" role="alert">
            {asked.blocked}
          </p>
        ) : null}
      </div>
      <div className="dialog-actions">
        <button type="button" className="button" autoFocus onClick={onClose}>
          {asked?.blocked ? "Close" : "Cancel"}
        </button>
        {asked?.blocked ? null : (
          <button
            type="button"
            className="button danger"
            disabled={asked === null}
            onClick={() => {
              onClose();
              onConfirm();
            }}
          >
            Remove
          </button>
        )}
      </div>
    </Dialog>
  );
}

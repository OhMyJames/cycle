import type { WorktreeEntry } from "@cycle/protocol";
import { useEffect, useMemo, useState } from "react";
import { projectOf } from "../client/app.ts";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { basename, tailPath, tildePath } from "../lib/format.ts";
import { describeWorktree } from "../lib/worktrees.ts";
import { ConfirmDialog } from "./controls.tsx";

function WorktreeRow({
  entry,
  home,
  onRemove,
}: {
  entry: WorktreeEntry;
  home: string | undefined;
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
          disabled={view.removal.blocked !== null}
          aria-label={`Remove the worktree ${view.name}`}
          onClick={onRemove}
        >
          Remove…
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
  const workspaces = useMemo(
    () => [...new Set([...(inView ? [inView] : []), ...(projects ?? [])])],
    [inView, projects],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const workspace = chosen ?? workspaces[0] ?? null;
  const [removing, setRemoving] = useState<WorktreeEntry | null>(null);

  useEffect(() => {
    if (workspace) void app.loadWorktrees(workspace);
  }, [app, workspace]);

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
          home={home}
          onClose={() => setRemoving(null)}
          onConfirm={() => void app.removeWorktree(workspace, removing.path)}
        />
      ) : null}
    </>
  );
}

function RemoveDialog({
  entry,
  home,
  onClose,
  onConfirm,
}: {
  entry: WorktreeEntry;
  home: string | undefined;
  onClose(): void;
  onConfirm(): void;
}) {
  const { confirmation } = describeWorktree(entry);
  return (
    <ConfirmDialog
      title={confirmation.title}
      text={tildePath(entry.path, home)}
      action="Remove"
      onConfirm={onConfirm}
      onClose={onClose}
    >
      {confirmation.lines.map((line) => (
        <p key={line} className="dialog-text">
          {line}
        </p>
      ))}
    </ConfirmDialog>
  );
}

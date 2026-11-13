import type { GitFile, GitStatus, SessionInfo } from "@cycle/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { PatchView, Stats } from "../components/diff-view.tsx";
import { Icon, Spinner } from "../components/icons.tsx";
import { Chevron } from "../components/items.tsx";
import { PanelHeader } from "../components/panel.tsx";
import { Menu } from "../components/menu.tsx";
import { useApp } from "../context.ts";
import { basename, dirname } from "../lib/format.ts";

const STATUS_LABEL: Record<GitFile["status"], string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  U: "New",
};

function FileCard({
  cwd,
  from,
  file,
  open,
  wrap,
  onToggle,
}: {
  cwd: string;
  from: string;
  file: GitFile;
  open: boolean;
  wrap: boolean;
  onToggle(): void;
}) {
  const app = useApp();
  const [patch, setPatch] = useState<{ patch: string; truncated: boolean } | null>(null);
  useEffect(() => {
    if (!open || file.binary) return;
    let current = true;
    app.request("git.diff", { cwd, from, path: file.path, status: file.status }).then(
      (answer) => current && setPatch(answer),
      () => current && setPatch({ patch: "", truncated: false }),
    );
    return () => {
      current = false;
    };
    // The counts change whenever the file does, so the patch is read again then.
  }, [app, cwd, from, file.path, file.status, file.additions, file.deletions, file.binary, open]);
  const folder = dirname(file.path);
  return (
    <div className="file-card" data-open={open}>
      <button type="button" className="file-card-header" aria-expanded={open} onClick={onToggle}>
        <Chevron open={open} small />
        <span className="path fade-x-start grow" title={file.path}>
          {folder !== "/" && folder !== "." ? <span className="muted">{folder}/</span> : null}
          <span className="name">{basename(file.path)}</span>
        </span>
        <Stats additions={file.additions} deletions={file.deletions} />
        <span className="status-letter" data-status={file.status} title={STATUS_LABEL[file.status]}>
          {file.status}
        </span>
      </button>
      {open ? (
        file.binary ? (
          <div className="note">A binary file.</div>
        ) : patch === null ? (
          <div className="note">Reading the changes…</div>
        ) : (
          <>
            <PatchView patch={patch.patch} path={file.path} wrap={wrap} />
            {patch.truncated ? <div className="note">The rest is too large to show.</div> : null}
          </>
        )
      ) : null}
    </div>
  );
}

function CommitBox({ cwd, onDone }: { cwd: string; onDone(): void }) {
  const app = useApp();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="commit-box"
      onSubmit={(event) => {
        event.preventDefault();
        if (!message.trim() || busy) return;
        setBusy(true);
        void app
          .attempt(app.request("git.commit", { cwd, message: message.trim() }))
          .then((done) => {
            setBusy(false);
            if (!done) return;
            setMessage("");
            app.toast(`Committed ${done.commit}`);
            onDone();
          });
      }}
    >
      <input
        className="field small"
        aria-label="Commit message"
        placeholder="Commit message"
        value={message}
        onChange={(event) => setMessage(event.currentTarget.value)}
      />
      <button type="submit" className="button primary" disabled={!message.trim() || busy}>
        {busy ? <Spinner size={14} /> : null}
        Commit all
      </button>
    </form>
  );
}

/** What the checkout changed: a worktree's whole work, or what is uncommitted. */
export function ChangesPanel({ info }: { info: SessionInfo }) {
  const app = useApp();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [wrap, setWrap] = useState(false);
  const [uncommitted, setUncommitted] = useState(false);
  const touched = useRef(false);
  const base = info.worktree && !uncommitted ? info.worktree.base : undefined;
  const cwd = info.cwd;

  const refresh = useCallback(() => {
    app.request("git.status", { cwd, ...(base ? { base } : {}) }).then(
      (answer) => {
        setStatus(answer);
        // A short list opens by itself, until the owner folds something.
        if (!touched.current && answer.files.length <= 6) {
          setOpen(new Set(answer.files.map((file) => file.path)));
        }
      },
      () => setStatus({ repo: null, files: [], truncated: false }),
    );
  }, [app, cwd, base]);

  // The agent's work shows up as it lands: reread when a turn moves on.
  useEffect(() => {
    refresh();
    const store = app.conversation(info.id);
    let seen = store.get().state?.turns.at(-1)?.items.length ?? 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = store.subscribe(() => {
      const turn = store.get().state?.turns.at(-1);
      const count = (turn?.items.length ?? 0) + (turn?.status === "running" ? 0 : 1000);
      if (count === seen) return;
      seen = count;
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 400);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [app, info.id, refresh]);

  const toggle = (path: string) => {
    touched.current = true;
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const files = status?.files ?? [];
  const totals = files.reduce(
    (sum, file) => ({
      additions: sum.additions + file.additions,
      deletions: sum.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  return (
    <>
      <PanelHeader
        title="Changes"
        actions={
          <Menu
            className="icon-button"
            title="More"
            align="end"
            width={200}
            entries={() => [
              { label: "Refresh", icon: "refresh", onSelect: refresh },
              {
                label: "Expand all",
                onSelect: () => {
                  touched.current = true;
                  setOpen(new Set(files.map((file) => file.path)));
                },
              },
              {
                label: "Collapse all",
                onSelect: () => {
                  touched.current = true;
                  setOpen(new Set());
                },
              },
              { label: "Wrap lines", checked: wrap, onSelect: () => setWrap(!wrap) },
              ...(info.worktree
                ? [
                    {
                      label: "Only uncommitted changes",
                      checked: uncommitted,
                      onSelect: () => setUncommitted(!uncommitted),
                    },
                  ]
                : []),
            ]}
          >
            <Icon name="more" />
          </Menu>
        }
      >
        {status?.repo?.branch ? (
          <span className="fade-x mono">{status.repo.branch}</span>
        ) : (
          <span className="fade-x">Changes</span>
        )}
        {files.length ? (
          <span className="panel-meta">
            <span className="muted">
              {files.length} {files.length === 1 ? "file" : "files"}
            </span>
            <Stats {...totals} />
          </span>
        ) : null}
      </PanelHeader>
      <div className="panel-body changes fade-y">
        {status === null ? (
          <div className="note">Reading the changes…</div>
        ) : !status.repo ? (
          <div className="note">This folder is not a git repository.</div>
        ) : files.length === 0 ? (
          <div className="note">
            {base ? "No changes on this branch yet." : "Nothing uncommitted."}
          </div>
        ) : (
          <>
            {files.map((file) => (
              <FileCard
                key={file.path}
                cwd={cwd}
                from={status.repo?.from ?? ""}
                file={file}
                open={open.has(file.path)}
                wrap={wrap}
                onToggle={() => toggle(file.path)}
              />
            ))}
            {status.truncated ? (
              <div className="note">More files changed than are shown.</div>
            ) : null}
          </>
        )}
      </div>
      {status?.repo && files.length ? <CommitBox cwd={cwd} onDone={refresh} /> : null}
    </>
  );
}

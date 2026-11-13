import { useEffect, useState } from "react";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { dirname, tildePath } from "../lib/format.ts";
import { Icon } from "./icons.tsx";
import { Dialog } from "./menu.tsx";

/** Chooses a folder on the agent's machine, where the host has no chooser of its own. */
export function FolderPicker() {
  const app = useApp();
  const home = useStore(app.daemon, (daemon) => daemon?.userHome ?? "/");
  const recent = useStore(app.settings, (settings) => settings?.projects ?? []);
  const [path, setPath] = useState(home);
  const [typed, setTyped] = useState(home);
  const [folders, setFolders] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => app.setView({ folderPicker: false });
  useEffect(() => {
    let current = true;
    setFolders(null);
    setTyped(path);
    app.request("files.list", { path }).then(
      (answer) => {
        if (!current) return;
        setError(null);
        setFolders(
          answer.entries
            .filter((entry) => entry.directory && !entry.name.startsWith("."))
            .map((entry) => entry.name),
        );
      },
      (reason: unknown) => {
        if (!current) return;
        setFolders([]);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      current = false;
    };
  }, [app, path]);
  const choose = () => {
    close();
    app.newSession(path);
  };
  return (
    <Dialog label="Choose a folder" onClose={close} wide top>
      <form
        className="picker-path"
        onSubmit={(event) => {
          event.preventDefault();
          setPath(typed.trim().replace(/\/+$/, "") || "/");
        }}
      >
        <button
          type="button"
          className="icon-button"
          title="Up one folder"
          aria-label="Up one folder"
          onClick={() => setPath(dirname(path))}
        >
          <Icon name="arrow-left" />
        </button>
        <input
          className="field"
          value={typed}
          spellCheck={false}
          aria-label="Folder path"
          onChange={(event) => setTyped(event.currentTarget.value)}
        />
      </form>
      <div className="picker-list fade-y no-scrollbar">
        {path === home && recent.length ? (
          <>
            <div className="menu-label">Recent</div>
            {recent.slice(0, 5).map((folder) => (
              <button
                key={folder}
                type="button"
                className="menu-item"
                onClick={() => setPath(folder)}
              >
                <Icon name="clock" />
                <span className="fade-x">{tildePath(folder, home)}</span>
              </button>
            ))}
            <div className="menu-separator" />
          </>
        ) : null}
        {folders === null ? (
          <div className="note">Reading…</div>
        ) : error ? (
          <div className="note">{error}</div>
        ) : folders.length === 0 ? (
          <div className="note">No folders inside.</div>
        ) : (
          folders.map((name) => (
            <button
              key={name}
              type="button"
              className="menu-item"
              onClick={() => setPath(path === "/" ? `/${name}` : `${path}/${name}`)}
            >
              <Icon name="folder" />
              <span className="fade-x">{name}</span>
            </button>
          ))
        )}
      </div>
      <div className="dialog-actions picker-actions">
        <span className="fade-x-start grow meta muted mono">{tildePath(path, home)}</span>
        <button type="button" className="button" onClick={close}>
          Cancel
        </button>
        <button type="button" className="button primary" onClick={choose}>
          Use this folder
        </button>
      </div>
    </Dialog>
  );
}

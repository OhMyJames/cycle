import { useState } from "react";
import type { RemoteServer } from "../client/host.ts";
import { host } from "../client/host.ts";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import {
  type RemoteForm,
  guard,
  remoteFormFor,
  remoteInput,
  serverStatus,
  serverTone,
} from "../lib/remote.ts";
import { Icon } from "./icons.tsx";

function ServerForm({ server, onDone }: { server: RemoteServer | null; onDone(): void }) {
  const app = useApp();
  const [form, setForm] = useState(() => remoteFormFor(server));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (change: Partial<RemoteForm>) => setForm((value) => ({ ...value, ...change }));

  const save = async () => {
    const input = remoteInput(form);
    if (typeof input === "string") {
      setProblem(input);
      return;
    }
    const bridge = host.remote();
    if (!bridge) return;
    setProblem(null);
    setSaving(true);
    const saved = await guard(() => (form.id ? bridge.update(form.id, input) : bridge.add(input)));
    setSaving(false);
    if (!saved.ok) {
      setProblem(saved.error);
      return;
    }
    await app.refreshRemote();
    onDone();
  };

  return (
    <form
      className="card provider-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) void save();
      }}
    >
      <label className="form-row">
        <span className="form-label">Name</span>
        <input
          className="field"
          placeholder="Build server"
          value={form.name}
          onChange={(event) => set({ name: event.currentTarget.value })}
        />
      </label>
      <label className="form-row">
        <span className="form-label">ssh target</span>
        <input
          className="field mono"
          placeholder="user@host or a name from your ssh config"
          spellCheck={false}
          value={form.target}
          onChange={(event) => set({ target: event.currentTarget.value })}
        />
      </label>
      <label className="form-row">
        <span className="form-label">Folder</span>
        <input
          className="field mono"
          placeholder="~/.cycle-codex (default)"
          spellCheck={false}
          value={form.home}
          onChange={(event) => set({ home: event.currentTarget.value })}
        />
      </label>
      <div className="caption muted">
        Cycle uses your own ssh setup and its agent, and keeps no password or key. The daemon must
        already be running on the server.
      </div>
      {problem ? (
        <div className="caption tone-error" role="alert">
          {problem}
        </div>
      ) : null}
      <div className="row form-actions">
        <button type="button" className="button" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={saving}>
          {form.id ? "Save" : "Add server"}
        </button>
      </div>
    </form>
  );
}

function ServerRow({
  server,
  onEdit,
  onProblem,
}: {
  server: RemoteServer;
  onEdit(): void;
  onProblem(message: string | null): void;
}) {
  const app = useApp();
  const state = useStore(app.remote, (view) => view?.state ?? { status: "idle" as const });
  const [removing, setRemoving] = useState(false);
  const tone = serverTone(state, server.id);
  const status = serverStatus(state, server.id);
  const here = state.status !== "idle" && state.id === server.id;

  const run = async (call: () => Promise<unknown>) => {
    onProblem(null);
    const done = await guard(async () => {
      await call();
    });
    if (!done.ok) onProblem(done.error);
    // The window may stay where it is, as when a connection fails: say how it stands.
    await app.refreshRemote();
  };
  const bridge = host.remote();
  return (
    <div className="setting">
      {tone ? <span className={`dot ${tone === "ok" ? "" : tone}`} aria-hidden="true" /> : null}
      <div className="grow">
        <div className="setting-name fade-x">{server.name}</div>
        <div className="caption muted fade-x">
          {removing
            ? "Remove it from this list. Nothing changes on the server."
            : [server.target, status].filter(Boolean).join(" · ")}
        </div>
      </div>
      {removing ? (
        <>
          <button type="button" className="button" onClick={() => setRemoving(false)}>
            Keep
          </button>
          <button
            type="button"
            className="button danger"
            onClick={() => void run(() => bridge?.remove(server.id) ?? Promise.resolve())}
          >
            Remove it
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={here ? "button" : "button primary"}
            disabled={state.status === "connecting"}
            onClick={() => void run(() => bridge?.connect(server.id) ?? Promise.resolve())}
          >
            {here && state.status === "failed" ? "Try again" : "Connect"}
          </button>
          <button type="button" className="button" onClick={onEdit}>
            Edit
          </button>
          <button
            type="button"
            className="icon-button"
            title="Remove this server"
            aria-label={`Remove ${server.name}`}
            onClick={() => setRemoving(true)}
          >
            <Icon name="trash" />
          </button>
        </>
      )}
    </div>
  );
}

/** Servers the app reaches through ssh, and the way back to this computer. */
export function RemotesSection() {
  const app = useApp();
  const view = useStore(app.remote, (value) => value);
  /** The server being changed, `{ id: null }` for one being added, or null. */
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (!view) return null;
  const edited = view.servers.find((one) => one.id === editing?.id) ?? null;
  // A failed connection leaves the window on this computer, so only a live one is "away".
  const away = view.state.status === "connected" || view.state.status === "reconnecting";
  const shown = problem ?? view.problem;
  return (
    <>
      {shown ? (
        <div className="card">
          <div className="note tone-error" role="alert">
            {shown}
          </div>
        </div>
      ) : null}
      <h2>Remote servers</h2>
      <div className="card">
        <div className="setting">
          <div className="grow">
            <div className="setting-name fade-x">This computer</div>
            <div className="caption muted fade-x">
              {away ? "Agents run on a remote server now." : "Shown now."}
            </div>
          </div>
          {away ? (
            <button
              type="button"
              className="button"
              onClick={async () => {
                setProblem(null);
                const done = await guard(async () => {
                  await host.remote()?.connect(null);
                });
                if (!done.ok) setProblem(done.error);
              }}
            >
              Back to this computer
            </button>
          ) : null}
        </div>
        {view.servers.map((one) =>
          one.id === editing?.id ? null : (
            <ServerRow
              key={one.id}
              server={one}
              onEdit={() => setEditing({ id: one.id })}
              onProblem={setProblem}
            />
          ),
        )}
        {editing === null ? (
          <div className="setting">
            <div className="grow caption muted">
              A server runs its own Cycle daemon, and agents there run commands on it. Cycle reaches
              it through an ssh tunnel.
            </div>
            <button type="button" className="button" onClick={() => setEditing({ id: null })}>
              <Icon name="plus" /> Add server
            </button>
          </div>
        ) : null}
      </div>
      {editing !== null ? (
        <ServerForm key={editing.id ?? ""} server={edited} onDone={() => setEditing(null)} />
      ) : null}
    </>
  );
}

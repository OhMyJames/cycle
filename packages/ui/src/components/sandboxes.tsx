import type { SandboxEnvironment, SandboxSecret } from "@cycle/protocol";
import { useCallback, useEffect, useState } from "react";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import {
  type SandboxForm,
  type VariableRow,
  sandboxDraft,
  sandboxFormFor,
  sandboxSummary,
} from "../lib/sandbox-form.ts";
import { Icon } from "./icons.tsx";

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="form-row">
      <span className="form-label">{label}</span>
      {children}
    </label>
  );
}

function Variables({
  rows,
  onChange,
}: {
  rows: VariableRow[];
  onChange(rows: VariableRow[]): void;
}) {
  const set = (index: number, change: Partial<VariableRow>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));
  return (
    <div className="model-rows">
      {rows.map((row, index) => (
        // A row has no identity but its place: its name is still being typed.
        <div key={index} className="pair-row">
          <input
            className="field mono"
            placeholder="NAME"
            aria-label="Variable name"
            spellCheck={false}
            value={row.name}
            // A stored value belongs to the name it was saved under.
            readOnly={row.stored}
            onChange={(event) => set(index, { name: event.currentTarget.value })}
          />
          <input
            className="field mono"
            type="password"
            autoComplete="off"
            aria-label="Variable value"
            placeholder={row.stored ? "Saved. Type a new one to replace it." : "Value"}
            value={row.value}
            onChange={(event) => set(index, { value: event.currentTarget.value })}
          />
          <button
            type="button"
            className="icon-button"
            title="Remove this variable"
            aria-label={`Remove ${row.name || "this variable"}`}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            <Icon name="x" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button add-row"
        onClick={() => onChange([...rows, { name: "", value: "", stored: false }])}
      >
        <Icon name="plus" /> Add variable
      </button>
    </div>
  );
}

function EnvironmentForm({
  environment,
  onDone,
}: {
  environment: SandboxEnvironment | null;
  onDone(): void;
}) {
  const app = useApp();
  const [form, setForm] = useState(() => sandboxFormFor(environment));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (change: Partial<SandboxForm>) => setForm((value) => ({ ...value, ...change }));

  const save = async () => {
    const draft = sandboxDraft(form);
    if (typeof draft === "string") {
      setProblem(draft);
      return;
    }
    setProblem(null);
    setSaving(true);
    const saved = await app.attempt(app.request("sandboxes.save", draft));
    setSaving(false);
    if (saved) onDone();
  };

  return (
    <form
      className="card provider-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) void save();
      }}
    >
      <Labeled label="Name">
        <input
          className="field"
          placeholder="Node projects"
          value={form.name}
          onChange={(event) => set({ name: event.currentTarget.value })}
        />
      </Labeled>
      <Labeled label="CPUs">
        <input
          className="field"
          inputMode="numeric"
          placeholder="All of this machine's (Docker's choice)"
          value={form.cpus}
          onChange={(event) => set({ cpus: event.currentTarget.value })}
        />
      </Labeled>
      <Labeled label="Memory, GB">
        <input
          className="field"
          inputMode="numeric"
          placeholder="Half of this machine's (Docker's choice)"
          value={form.memoryGb}
          onChange={(event) => set({ memoryGb: event.currentTarget.value })}
        />
      </Labeled>
      <div className="form-row top">
        <span className="form-label">Network</span>
        <textarea
          className="field area mono"
          aria-label="Hosts the sandbox may reach"
          placeholder={
            "Hosts to allow beyond Docker's own list, one a line\napi.example.com\n*.example.org"
          }
          spellCheck={false}
          value={form.hosts}
          onChange={(event) => set({ hosts: event.currentTarget.value })}
        />
      </div>
      <div className="form-row top">
        <span className="form-label">Variables</span>
        <Variables rows={form.variables} onChange={(variables) => set({ variables })} />
      </div>
      <div className="form-row top">
        <span className="form-label">Setup script</span>
        <textarea
          className="field area mono"
          aria-label="Setup script"
          placeholder={
            "Run once with bash for the environment, to install what its sandboxes need\nsudo apt-get install -y ripgrep"
          }
          spellCheck={false}
          value={form.setup}
          onChange={(event) => set({ setup: event.currentTarget.value })}
        />
      </div>
      <div className="caption muted">
        Hosts take effect the next time a sandbox is used. For anything else that changes, a sandbox
        is made again the next time it is used and no session is running in it. The setup script
        runs in the first sandbox made, which is then saved: the next folder's starts from it
        without running the script, so what one project needs (npm ci) is not for here.
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
          {form.id ? "Save" : "Add environment"}
        </button>
      </div>
    </form>
  );
}

function EnvironmentRow({
  environment,
  only,
  onEdit,
}: {
  environment: SandboxEnvironment;
  only: boolean;
  onEdit(): void;
}) {
  const app = useApp();
  const [removing, setRemoving] = useState(false);
  return (
    <div className="setting">
      <div className="grow">
        <div className="setting-name fade-x">{environment.name}</div>
        <div className="caption muted fade-x">
          {removing
            ? "Its sandboxes are removed too, but for one a session is running in."
            : sandboxSummary(environment)}
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
            onClick={() =>
              void app.attempt(app.request("sandboxes.delete", { id: environment.id }))
            }
          >
            Remove it
          </button>
        </>
      ) : (
        <>
          <button type="button" className="button" onClick={onEdit}>
            Edit
          </button>
          {only ? null : (
            <button
              type="button"
              className="icon-button"
              title="Remove this environment"
              aria-label={`Remove ${environment.name}`}
              onClick={() => setRemoving(true)}
            >
              <Icon name="trash" />
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** The secrets Docker keeps for the services a sandbox signs in to. Cycle only hands them over. */
function Secrets() {
  const app = useApp();
  const [secrets, setSecrets] = useState<SandboxSecret[] | null>(null);
  const [service, setService] = useState("anthropic");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const read = useCallback(() => {
    app.request("sandboxes.secrets", {}).then(
      (answer) => setSecrets(answer.secrets),
      () => setSecrets([]),
    );
  }, [app]);
  useEffect(read, [read]);
  const save = async () => {
    setSaving(true);
    const saved = await app.attempt(app.request("sandboxes.secret.set", { service, value }));
    setSaving(false);
    if (!saved) return;
    setValue("");
    read();
  };
  if (secrets === null) return <div className="note">Reading the sign-ins…</div>;
  const kept = secrets.filter((secret) => secret.set).map((secret) => secret.service);
  return (
    <form
      className="provider-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() && !saving) void save();
      }}
    >
      <div className="caption muted">
        {kept.length ? `Kept for ${kept.join(", ")}. ` : "None kept yet. "}
        Docker holds a key outside every sandbox and adds it to requests on their way out, so the
        agent never has it. Cycle hands it over and keeps no copy. A sandbox needs one for anthropic
        to run Claude Code.
      </div>
      <div className="inline-form">
        <select
          className="field select"
          aria-label="Service"
          value={service}
          onChange={(event) => setService(event.currentTarget.value)}
        >
          {secrets.map((secret) => (
            <option key={secret.service} value={secret.service}>
              {secret.service}
              {secret.set ? " (kept)" : ""}
            </option>
          ))}
        </select>
        <input
          className="field mono"
          type="password"
          autoComplete="off"
          aria-label="Key or token"
          placeholder="Key or token"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
        <button type="submit" className="button" disabled={!value.trim() || saving}>
          {kept.includes(service) ? "Replace" : "Save"}
        </button>
      </div>
    </form>
  );
}

/** What the owner's sandboxes are made with, and the sign-ins they use. */
export function SandboxesSection() {
  const app = useApp();
  const { available, environments } = useStore(app.sandboxes, (value) => value);
  /** The environment being changed, `{ id: null }` for one being added, or null. */
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const edited = environments.find((one) => one.id === editing?.id) ?? null;
  // Docker's sandboxes may have been installed since the page connected.
  useEffect(() => {
    app.request("sandboxes.list", {}).then(
      (value) => app.sandboxes.set(value),
      () => {},
    );
  }, [app]);
  return (
    <>
      {available ? null : (
        <div className="card">
          <div className="note">
            Docker Sandboxes is not installed on the daemon's machine: sbx is not on its PATH.
            Environments can be set up now and used once it is.
          </div>
        </div>
      )}
      <h2>Environments</h2>
      <div className="card">
        {environments.map((one) =>
          one.id === editing?.id ? null : (
            <EnvironmentRow
              key={one.id}
              environment={one}
              only={environments.length === 1}
              onEdit={() => setEditing({ id: one.id })}
            />
          ),
        )}
        {editing === null ? (
          <div className="setting">
            <div className="grow caption muted">
              A new session on a Claude model can run its agent in a sandbox made with one of these.
              Each folder gets a sandbox of its own.
            </div>
            <button type="button" className="button" onClick={() => setEditing({ id: null })}>
              <Icon name="plus" /> Add environment
            </button>
          </div>
        ) : null}
      </div>
      {editing !== null ? (
        <EnvironmentForm
          key={editing.id ?? ""}
          environment={edited}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {available ? (
        <>
          <h2>Sign-ins</h2>
          <div className="card">
            <Secrets />
          </div>
        </>
      ) : null}
    </>
  );
}

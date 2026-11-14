import { SESSION_MODES, type Schedule, type ScheduleTiming } from "@cycle/protocol";
import { useState } from "react";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { tildePath } from "../lib/format.ts";
import {
  type RunEntry,
  type ScheduleDraft,
  WEEKDAYS,
  describeTiming,
  draftOf,
  draftProblem,
  inputOf,
} from "../lib/schedule-text.ts";
import { MODE_LABELS } from "./composer.tsx";
import { FormField, Segmented, Setting, Switch } from "./controls.tsx";
import { Icon } from "./icons.tsx";
import { Menu, type MenuEntry } from "./menu.tsx";
import { RunList } from "./run-list.tsx";

const KINDS: { value: ScheduleTiming["kind"]; label: string }[] = [
  { value: "daily", label: "At a time of day" },
  { value: "every", label: "On an interval" },
  { value: "once", label: "Once" },
];

/** The page that makes a schedule or changes one, with the runs it already made. */
export function ScheduleEditor({
  editing,
  runs,
  onDone,
  onDelete,
}: {
  editing: Schedule | null;
  runs: readonly RunEntry[];
  onDone(): void;
  onDelete(schedule: Schedule): void;
}) {
  const app = useApp();
  const home = useStore(app.daemon, (daemon) => daemon?.userHome);
  const models = useStore(app.models, (value) => value);
  const [draft, setDraft] = useState<ScheduleDraft>(() => {
    const { project } = app.view.get();
    const folder = project ?? app.settings.get()?.projects[0] ?? "";
    return draftOf(editing, folder, new Date());
  });
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<ScheduleDraft>) => setDraft((old) => ({ ...old, ...patch }));
  const now = new Date();
  const problem = draftProblem(draft, now);
  const save = () => {
    if (problem || saving) return;
    setSaving(true);
    void app
      .putSchedule(inputOf(draft, editing, new Date()))
      .then((saved) => saved && onDone())
      .finally(() => setSaving(false));
  };
  const model = models.find((each) => each.id === draft.model);
  const modelEntries = (): MenuEntry[] => [
    {
      label: "What new sessions start with (default)",
      checked: draft.model === null,
      onSelect: () => set({ model: null, effort: null }),
    },
    { separator: true },
    ...models.map((each): MenuEntry => ({
      label: each.name,
      checked: each.id === draft.model,
      onSelect: () => set({ model: each.id, effort: null }),
    })),
  ];
  const modeEntries = (): MenuEntry[] => [
    {
      label: "What new sessions start with (default)",
      checked: draft.mode === null,
      onSelect: () => set({ mode: null }),
    },
    { separator: true },
    ...SESSION_MODES.map((mode): MenuEntry => ({
      label: MODE_LABELS[mode].label,
      sub: MODE_LABELS[mode].sub,
      icon: MODE_LABELS[mode].icon,
      warning: mode === "fullAccess",
      checked: mode === draft.mode,
      onSelect: () => set({ mode }),
    })),
  ];
  return (
    <div className="page fade-y">
      <form
        className="page-content"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <header className="page-header">
          <button type="button" className="ghost page-back" onClick={onDone}>
            <Icon name="chevron-left" />
            Automatic
          </button>
          <h1>{editing ? editing.name : "New schedule"}</h1>
        </header>
        <div className="form">
          <FormField label="Name">
            <input
              className="field"
              value={draft.name}
              autoFocus={!editing}
              placeholder="Morning report"
              onChange={(event) => set({ name: event.currentTarget.value })}
            />
          </FormField>
          <FormField label="Message" help="Sent to a new session each time, as you would type it.">
            <textarea
              className="field area"
              rows={5}
              value={draft.prompt}
              placeholder="Summarize what changed in this repository since yesterday."
              onChange={(event) => set({ prompt: event.currentTarget.value })}
            />
          </FormField>
        </div>

        <h2>When</h2>
        <div className="form">
          <Segmented
            label="How often"
            value={draft.kind}
            onChange={(kind) => set({ kind })}
            options={KINDS}
          />
          {draft.kind === "daily" ? (
            <>
              <FormField label="Time">
                <input
                  className="field narrow"
                  type="time"
                  value={draft.time}
                  onChange={(event) => set({ time: event.currentTarget.value || draft.time })}
                />
              </FormField>
              <div className="form-field">
                <span className="form-label">Days</span>
                <div className="weekdays" role="group" aria-label="Days">
                  {WEEKDAYS.map((name, day) => {
                    const on = draft.weekdays.length === 0 || draft.weekdays.includes(day);
                    return (
                      <button
                        key={name}
                        type="button"
                        className="weekday"
                        aria-pressed={on}
                        title={name}
                        onClick={() => {
                          const all =
                            draft.weekdays.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : draft.weekdays;
                          const next = on ? all.filter((each) => each !== day) : [...all, day];
                          // None chosen reads as every day, so the last day cannot be turned off.
                          if (next.length > 0) set({ weekdays: next.length === 7 ? [] : next });
                        }}
                      >
                        {name.slice(0, 2)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          ) : draft.kind === "every" ? (
            <div className="form-field">
              <span className="form-label">Every</span>
              <div className="row">
                <input
                  className="field narrow"
                  type="number"
                  min={1}
                  aria-label="Interval"
                  value={Number.isNaN(draft.every) ? "" : draft.every}
                  onChange={(event) => set({ every: event.currentTarget.valueAsNumber })}
                />
                <Segmented
                  label="Unit"
                  value={draft.unit}
                  onChange={(unit) => set({ unit })}
                  options={[
                    { value: "minutes", label: "Minutes" },
                    { value: "hours", label: "Hours" },
                  ]}
                />
              </div>
            </div>
          ) : (
            <FormField label="At">
              <input
                className="field medium"
                type="datetime-local"
                value={draft.at}
                onChange={(event) => set({ at: event.currentTarget.value })}
              />
            </FormField>
          )}
          {problem === null ? (
            <span className="caption muted">
              {describeTiming(inputOf(draft, editing, now).timing, now)}. A run that was missed
              while Cycle was closed starts when it opens, the latest one only.
            </span>
          ) : null}
        </div>

        <h2>Where and how</h2>
        <div className="card">
          <Setting
            title="Folder"
            note={draft.cwd ? tildePath(draft.cwd, home) : "Each run's session works here."}
          >
            <button
              type="button"
              className="button"
              onClick={() => void app.chooseFolder().then((cwd) => cwd && set({ cwd }))}
            >
              {draft.cwd ? "Change…" : "Choose…"}
            </button>
          </Setting>
          <Setting
            title="Start in a new worktree"
            note="In a git repository, each run gets its own checkout and branch."
          >
            <Switch
              label="Start in a new worktree"
              checked={draft.worktree}
              onChange={(worktree) => set({ worktree })}
            />
          </Setting>
          <Setting title="Model">
            <Menu className="button" align="end" width={280} entries={modelEntries}>
              {model?.name ?? (draft.model || "New sessions' model (default)")}
              <Icon name="chevron-down-sm" size={14} className="muted" />
            </Menu>
          </Setting>
          <Setting
            title="Permissions"
            note={
              draft.mode === "fullAccess"
                ? "Runs unattended with no sandbox and never asks."
                : "A run that has to ask waits for you."
            }
          >
            <Menu className="button" align="end" width={300} entries={modeEntries}>
              <span className={draft.mode === "fullAccess" ? "tone-warning" : undefined}>
                {draft.mode ? MODE_LABELS[draft.mode].label : "New sessions' mode (default)"}
              </span>
              <Icon name="chevron-down-sm" size={14} className="muted" />
            </Menu>
          </Setting>
        </div>

        <div className="form-actions">
          {editing ? (
            <button type="button" className="button danger" onClick={() => onDelete(editing)}>
              Delete…
            </button>
          ) : null}
          <span className="grow caption muted">{problem ?? ""}</span>
          <button type="button" className="button" onClick={onDone}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={problem !== null || saving}>
            {saving ? "Saving…" : editing ? "Save" : "Create schedule"}
          </button>
        </div>

        {editing ? (
          <>
            <h2>Runs</h2>
            <RunList runs={runs} showSchedule={false} empty="It has not run yet." />
          </>
        ) : null}
      </form>
    </div>
  );
}

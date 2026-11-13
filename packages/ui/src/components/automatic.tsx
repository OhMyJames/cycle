import type { Schedule } from "@cycle/protocol";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { basename } from "../lib/format.ts";
import {
  describeTiming,
  inputFromSchedule,
  lowerFirst,
  runEntries,
  whenLabel,
} from "../lib/schedule-text.ts";
import { ConfirmDialog, Switch } from "./controls.tsx";
import { Icon } from "./icons.tsx";
import { Menu } from "./menu.tsx";
import { RunList } from "./run-list.tsx";
import { ScheduleEditor } from "./schedule-editor.tsx";

function ScheduleRow({
  schedule,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  onEdit(): void;
  onDelete(): void;
}) {
  const app = useApp();
  const [starting, setStarting] = useState(false);
  const now = new Date();
  const failed = schedule.runs[0]?.error ?? null;
  const runNow = () => {
    setStarting(true);
    void app.runSchedule(schedule.id).finally(() => setStarting(false));
  };
  return (
    <div className="list-item" data-off={!schedule.enabled}>
      <div className="list-row">
        <button type="button" className="list-main" onClick={onEdit}>
          <span className="list-lead">
            <Icon name="automation" />
          </span>
          <span className="list-text">
            <span className="list-name fade-x">{schedule.name}</span>
            <span className="caption muted fade-x">
              {describeTiming(schedule.timing, now)}
              {" · "}
              {basename(schedule.cwd)}
              {schedule.next !== null
                ? ` · Next ${lowerFirst(whenLabel(new Date(schedule.next), now))}`
                : ""}
            </span>
          </span>
        </button>
        <Switch
          label={schedule.enabled ? `Turn ${schedule.name} off` : `Turn ${schedule.name} on`}
          checked={schedule.enabled}
          onChange={(enabled) => void app.putSchedule({ ...inputFromSchedule(schedule), enabled })}
        />
        <Menu
          className="icon-button small"
          title={`More options for ${schedule.name}`}
          align="end"
          width={180}
          entries={() => [
            {
              label: starting ? "Starting…" : "Run now",
              icon: "play",
              disabled: starting,
              onSelect: runNow,
            },
            { label: "Edit", icon: "edit", onSelect: onEdit },
            { label: "Delete…", icon: "trash", danger: true, onSelect: onDelete },
          ]}
        >
          <Icon name="more" size={14} />
        </Menu>
      </div>
      {failed ? (
        <p className="caption tone-error list-problem" role="alert">
          Last run did not start: {failed}
        </p>
      ) : null}
    </div>
  );
}

type AutomaticView = { kind: "list" } | { kind: "new" } | { kind: "edit"; id: string };

const ALL = "";

/**
 * The Automatic area: the schedules and every run they made, or one schedule's page to make or
 * change it.
 */
export function AutomaticPage() {
  const app = useApp();
  const schedules = useStore(app.schedules, (value) => value);
  const sessions = useStore(app.sessions, (value) => value.byId);
  const connected = useStore(app.connection, (status) => status === "open");
  useEffect(() => {
    if (connected) void app.loadSchedules();
  }, [app, connected]);
  const [view, setView] = useState<AutomaticView>({ kind: "list" });
  const [deleting, setDeleting] = useState<Schedule | null>(null);
  const [filter, setFilter] = useState(ALL);
  const runs = useMemo(
    () => runEntries(Object.values(sessions), schedules ?? []),
    [sessions, schedules],
  );
  const toList = () => setView({ kind: "list" });
  const deleteDialog = deleting ? (
    <ConfirmDialog
      title={`Delete ${deleting.name}?`}
      text="It will not run again. The sessions it started stay in the list."
      action="Delete"
      onConfirm={() => {
        void app.deleteSchedule(deleting.id);
        toList();
      }}
      onClose={() => setDeleting(null)}
    />
  ) : null;
  const editing = view.kind === "edit" ? schedules?.find((each) => each.id === view.id) : undefined;
  if (view.kind === "new" || editing) {
    return (
      <>
        <ScheduleEditor
          key={editing?.id ?? "new"}
          editing={editing ?? null}
          runs={editing ? runs.filter((run) => run.schedule?.id === editing.id) : []}
          onDone={toList}
          onDelete={setDeleting}
        />
        {deleteDialog}
      </>
    );
  }
  const filtered = schedules?.some((each) => each.id === filter) ? filter : ALL;
  const shown = filtered === ALL ? runs : runs.filter((run) => run.schedule?.id === filtered);
  return (
    <div className="page fade-y">
      <div className="page-content">
        <header className="page-header with-action">
          <div className="grow">
            <h1>Automatic</h1>
            <p className="page-lead">
              A schedule sends a message to a new session on its own. Schedules run while Cycle
              does.
            </p>
          </div>
          <button
            type="button"
            className="button primary"
            disabled={schedules === null}
            onClick={() => setView({ kind: "new" })}
          >
            New schedule
          </button>
        </header>

        <section aria-label="Schedules">
          <div className="section-head">
            <h2>Schedules</h2>
          </div>
          {schedules === null ? (
            <p className="note" role="status">
              Reading the schedules…
            </p>
          ) : schedules.length === 0 ? (
            <div className="empty-card">
              <p>No schedules yet</p>
              <p className="caption muted">
                A daily report, a weekly cleanup, a reminder for tomorrow.
              </p>
            </div>
          ) : (
            <div className="card">
              {schedules.map((schedule) => (
                <ScheduleRow
                  key={schedule.id}
                  schedule={schedule}
                  onEdit={() => setView({ kind: "edit", id: schedule.id })}
                  onDelete={() => setDeleting(schedule)}
                />
              ))}
            </div>
          )}
        </section>

        <section aria-label="Runs">
          <div className="section-head">
            <h2>Runs</h2>
            {schedules && schedules.length > 1 ? (
              <Menu
                title="Show runs of"
                align="end"
                width={220}
                entries={() => [
                  {
                    label: "All schedules",
                    checked: filtered === ALL,
                    onSelect: () => setFilter(ALL),
                  },
                  ...schedules.map((each) => ({
                    label: each.name,
                    checked: filtered === each.id,
                    onSelect: () => setFilter(each.id),
                  })),
                ]}
              >
                {schedules.find((each) => each.id === filtered)?.name ?? "All schedules"}
                <Icon name="chevron-down-sm" size={14} className="muted" />
              </Menu>
            ) : null}
          </div>
          <RunList
            runs={shown}
            showSchedule={filtered === ALL}
            empty="Runs show here, each with the session it started."
          />
        </section>
        {deleteDialog}
      </div>
    </div>
  );
}

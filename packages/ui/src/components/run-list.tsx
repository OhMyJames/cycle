import { useApp } from "../context.ts";
import { type RunEntry, clock, runsByDay } from "../lib/schedule-text.ts";
import { Icon } from "./icons.tsx";

/** Runs under the day each started. A row with a session opens it; one without says why. */
export function RunList({
  runs,
  showSchedule,
  empty,
}: {
  runs: readonly RunEntry[];
  showSchedule: boolean;
  empty: string;
}) {
  const app = useApp();
  const groups = runsByDay(runs, new Date());
  if (groups.length === 0) return <p className="note">{empty}</p>;
  return (
    <div className="card run-list">
      {groups.map((group) => (
        <div key={group.day} className="run-group">
          <div className="menu-label">{group.day}</div>
          {group.runs.map((run) => (
            <button
              key={run.key}
              type="button"
              className="run-row"
              disabled={run.sessionId === null}
              title={run.error ?? run.title}
              onClick={() => run.sessionId && app.selectSession(run.sessionId)}
            >
              <span className="list-lead">
                <Icon
                  name={run.error === null ? "clock" : "alert"}
                  size={14}
                  className={run.error === null ? "muted" : "tone-error"}
                />
              </span>
              <span className={run.error === null ? "grow fade-x" : "grow fade-x tone-error"}>
                {run.error === null ? run.title.split("\n")[0] : `Did not start: ${run.error}`}
              </span>
              {showSchedule ? (
                <span className="muted run-schedule fade-x">
                  {run.schedule?.name ?? "Deleted schedule"}
                </span>
              ) : null}
              <span className="muted tabular">{clock(new Date(run.at))}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

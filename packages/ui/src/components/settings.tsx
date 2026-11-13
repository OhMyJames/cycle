import { SESSION_MODES } from "@cycle/protocol";
import { useEffect, useState } from "react";
import type { Theme } from "../client/app.ts";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { compactNumber, tildePath } from "../lib/format.ts";
import { MODE_LABELS } from "./composer.tsx";
import { Icon } from "./icons.tsx";

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          className="segment"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** On or off, taking effect at once: a 28 by 16 pill named by its row. */
function Switch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange(checked: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    />
  );
}

function Setting({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting">
      <div className="grow">
        <div className="setting-name">{title}</div>
        {note ? <div className="caption muted">{note}</div> : null}
      </div>
      {children}
    </div>
  );
}

function Limit({
  label,
  used,
  resetsAt,
}: {
  label: string;
  used: number;
  resetsAt: number | null;
}) {
  return (
    <div className="limit">
      <div className="row meta">
        <span className="grow">{label}</span>
        <span className="tabular muted">
          {Math.round(used)}% used
          {resetsAt
            ? ` · resets ${new Date(resetsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`
            : ""}
        </span>
      </div>
      <div className="meter" data-high={used > 80}>
        <span style={{ width: `${Math.min(100, used)}%` }} />
      </div>
    </div>
  );
}

function UsageChart() {
  const app = useApp();
  const today = useStore(app.usage, (value) => value);
  const [days, setDays] = useState<{ date: string; total: number; turns: number }[]>([]);
  useEffect(() => {
    let current = true;
    app.request("usage.daily", {}).then(
      (answer) =>
        current &&
        setDays(
          answer.days
            .slice(-14)
            .map((day) => ({ date: day.date, total: day.tokens.total, turns: day.turns })),
        ),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [app, today]);
  const max = Math.max(1, ...days.map((day) => day.total));
  if (!days.length) return <div className="note">Nothing used yet.</div>;
  return (
    <div className="usage-chart" role="img" aria-label="Tokens used per day">
      {days.map((day) => (
        <div
          key={day.date}
          className="bar"
          title={`${day.date}: ${day.total.toLocaleString()} tokens, ${day.turns} turns`}
        >
          <span style={{ height: `${Math.max(2, (day.total / max) * 100)}%` }} />
          <small className="tabular">{day.date.slice(8)}</small>
        </div>
      ))}
      <div className="caption muted chart-max">{compactNumber(max)}</div>
    </div>
  );
}

export function SettingsPage() {
  const app = useApp();
  const settings = useStore(app.settings, (value) => value);
  const account = useStore(app.account, (value) => value);
  const daemon = useStore(app.daemon, (value) => value);
  const models = useStore(app.models, (value) => value);
  const { theme, showReasoning } = useStore(app.view, (view) => ({
    theme: view.theme,
    showReasoning: view.showReasoning,
  }));
  useEffect(() => {
    void app.refreshAccount();
  }, [app]);
  const set = (patch: Parameters<typeof app.request<"settings.set">>[1]) =>
    void app.attempt(app.request("settings.set", patch));
  return (
    <div className="page fade-y">
      <div className="page-content">
        <header className="page-header">
          <button
            type="button"
            className="ghost page-back"
            title="Back (Esc)"
            onClick={() => app.setView({ page: "thread" })}
          >
            <Icon name="chevron-left" />
            Back
          </button>
          <h1>Settings</h1>
        </header>

        <h2>Appearance</h2>
        <div className="card">
          <Setting title="Theme">
            <Segmented<Theme>
              value={theme}
              onChange={(value) => app.setView({ theme: value })}
              options={[
                { value: "system", label: "System (default)" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </Setting>
          <Setting
            title="Show the agent's thinking"
            note="Reasoning summaries appear among the work of a turn."
          >
            <Switch
              label="Show the agent's thinking"
              checked={showReasoning}
              onChange={(checked) => app.setView({ showReasoning: checked })}
            />
          </Setting>
        </div>

        <h2>New sessions</h2>
        <div className="card">
          <Setting title="Model" note="What a new session starts with. Each session can change it.">
            <select
              className="field select"
              value={settings?.model ?? ""}
              onChange={(event) => set({ model: event.currentTarget.value || null, effort: null })}
            >
              <option value="">Codex's choice (default)</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </Setting>
          <Setting title="Permissions" note={MODE_LABELS[settings?.mode ?? "auto"].sub}>
            <Segmented
              value={settings?.mode ?? "auto"}
              onChange={(mode) => set({ mode })}
              options={SESSION_MODES.map((mode) => ({
                value: mode,
                label:
                  mode === "auto"
                    ? `${MODE_LABELS[mode].label} (default)`
                    : MODE_LABELS[mode].label,
              }))}
            />
          </Setting>
          <Setting
            title="Start in a new worktree"
            note="In a git repository, each session gets its own checkout and branch."
          >
            <Switch
              label="Start in a new worktree"
              checked={settings?.worktree ?? false}
              onChange={(worktree) => set({ worktree })}
            />
          </Setting>
        </div>

        <h2>Codex account</h2>
        <div className="card">
          {account === null ? (
            <div className="note">Reading the account…</div>
          ) : account.kind === null ? (
            <Setting
              title="Not signed in"
              note="Run `codex login` in a terminal, or set OPENAI_API_KEY before starting Cycle."
            >
              <button type="button" className="button" onClick={() => void app.refreshAccount()}>
                Check again
              </button>
            </Setting>
          ) : (
            <>
              <Setting
                title={account.email ?? (account.kind === "apiKey" ? "API key" : "Signed in")}
                note={
                  account.plan
                    ? `Plan: ${account.plan}`
                    : account.kind === "apiKey"
                      ? "Billed by usage"
                      : ""
                }
              >
                <Icon name="check-circle" className="tone-success" />
              </Setting>
              {account.limits?.primary ? (
                <Limit
                  label={`${Math.round((account.limits.primary.windowMinutes ?? 300) / 60)}-hour limit`}
                  used={account.limits.primary.usedPercent}
                  resetsAt={account.limits.primary.resetsAt}
                />
              ) : null}
              {account.limits?.secondary ? (
                <Limit
                  label="Weekly limit"
                  used={account.limits.secondary.usedPercent}
                  resetsAt={account.limits.secondary.resetsAt}
                />
              ) : null}
            </>
          )}
        </div>

        <h2>Usage</h2>
        <div className="card">
          <UsageChart />
        </div>

        <h2>About</h2>
        <div className="card">
          <Setting
            title="Cycle"
            note={`Daemon ${daemon?.version ?? "…"} on ${daemon?.harness ?? "…"}`}
          >
            <span className="caption muted">{tildePath(daemon?.home ?? "", daemon?.userHome)}</span>
          </Setting>
        </div>
      </div>
    </div>
  );
}

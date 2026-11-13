import { type ModelInfo, SESSION_MODES } from "@cycle/protocol";
import { useEffect, useState } from "react";
import type { SettingsSection, Theme } from "../client/app.ts";
import { host } from "../client/host.ts";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { compactNumber, tildePath } from "../lib/format.ts";
import { updateOffer } from "../lib/update.ts";
import { MODE_LABELS } from "./composer.tsx";
import { Segmented, Setting, Switch } from "./controls.tsx";
import { Icon } from "./icons.tsx";
import { ProvidersSection } from "./providers.tsx";

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

/** Models under the name of whoever serves them, codex's own first. */
function groupByProvider(models: ModelInfo[]): [string, ModelInfo[]][] {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const name = model.provider?.name ?? "Codex";
    groups.set(name, [...(groups.get(name) ?? []), model]);
  }
  return [...groups];
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

/** The app's version and its update. Nothing in a browser, which has no app to update. */
function AppUpdate() {
  const app = useApp();
  const update = useStore(app.update, (value) => value);
  if (!update) return null;
  const offer = updateOffer(update);
  return (
    <Setting title={`Version ${update.current}`} note={offer.note}>
      <button
        type="button"
        className={offer.primary ? "button primary" : "button"}
        disabled={offer.action === null}
        onClick={() => (offer.action === "install" ? host.installUpdate() : host.checkForUpdate())}
      >
        <span className="tabular">{offer.label}</span>
      </button>
    </Setting>
  );
}

const TITLES: Record<SettingsSection, string> = {
  general: "General",
  account: "Account and usage",
  providers: "Model providers",
  about: "About",
};

export function SettingsPage() {
  const app = useApp();
  const settings = useStore(app.settings, (value) => value);
  const account = useStore(app.account, (value) => value);
  const daemon = useStore(app.daemon, (value) => value);
  const models = useStore(app.models, (value) => value);
  const login = useStore(app.login, (value) => value);
  const features = useStore(app.features, (value) => value);
  const { theme, showReasoning, section } = useStore(app.view, (view) => ({
    section: view.settingsSection,
    theme: view.theme,
    showReasoning: view.showReasoning,
  }));
  useEffect(() => {
    void app.refreshAccount();
    void app.loadFeatures();
  }, [app]);
  const set = (patch: Parameters<typeof app.request<"settings.set">>[1]) =>
    void app.attempt(app.request("settings.set", patch));
  return (
    <div className="page fade-y">
      <div className="page-content">
        <header className="page-header">
          <h1>{TITLES[section]}</h1>
        </header>

        {section === "general" ? (
          <>
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
              <Setting
                title="Model"
                note="What a new session starts with. Each session can change it."
              >
                <select
                  className="field select"
                  value={settings?.model ?? ""}
                  onChange={(event) =>
                    set({ model: event.currentTarget.value || null, effort: null })
                  }
                >
                  <option value="">Codex's choice (default)</option>
                  {groupByProvider(models).map(([name, group]) => (
                    <optgroup key={name} label={name}>
                      {group.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </optgroup>
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
              <Setting
                title="Subagents"
                note="The agent may start helper agents. Their tools take about 2.5k tokens of every request to a model that offers them. A codex setting: every session follows it from its next request, and so does the codex CLI."
              >
                {features ? (
                  <Switch
                    label="Subagents"
                    checked={features.subagents}
                    onChange={(subagents) => void app.setFeatures({ subagents })}
                  />
                ) : null}
              </Setting>
            </div>
          </>
        ) : null}

        {section === "account" ? (
          <>
            <h2>Codex account</h2>
            <div className="card">
              {account === null ? (
                <div className="note">Reading the account…</div>
              ) : login ? (
                <Setting
                  title="Finish signing in in your browser"
                  note="The page that opened asks for your ChatGPT account. This updates when you are done."
                >
                  <button
                    type="button"
                    className="button"
                    onClick={() => host.openExternal(login.url)}
                  >
                    Open it again
                  </button>
                  <button type="button" className="button" onClick={() => void app.cancelSignIn()}>
                    Cancel
                  </button>
                </Setting>
              ) : account.kind === null ? (
                <Setting
                  title="Not signed in"
                  note="Sign in to use the models of your ChatGPT plan. An OPENAI_API_KEY set before Cycle starts works too."
                >
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => void app.signIn()}
                  >
                    Sign in with ChatGPT
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
                    <button type="button" className="button" onClick={() => void app.signOut()}>
                      Sign out
                    </button>
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
          </>
        ) : null}

        {section === "providers" ? <ProvidersSection /> : null}

        {section === "about" ? (
          <div className="card">
            <Setting
              title="Cycle"
              note={`Daemon ${daemon?.version ?? "…"} on ${daemon?.harness ?? "…"}`}
            >
              <span className="caption muted">
                {tildePath(daemon?.home ?? "", daemon?.userHome)}
              </span>
            </Setting>
            <AppUpdate />
          </div>
        ) : null}
      </div>
    </div>
  );
}

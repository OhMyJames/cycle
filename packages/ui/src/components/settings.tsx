import { type LimitWindow, type ModelInfo, harnessLabel } from "@cycle/protocol";
import { useEffect, useState } from "react";
import type { SettingsSection, Theme } from "../client/app.ts";
import { host } from "../client/host.ts";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { accountDetails, accountTitle, limitText } from "../lib/account.ts";
import { compactNumber, tildePath } from "../lib/format.ts";
import { modeNamed, modesOf } from "../lib/modes.ts";
import { isRemote } from "../lib/remote.ts";
import { updateOffer } from "../lib/update.ts";
import { Segmented, Setting, Switch } from "./controls.tsx";
import { Icon } from "./icons.tsx";
import { ModeMenu } from "./mode-menu.tsx";
import { ProvidersSection } from "./providers.tsx";
import { RemotesSection } from "./remotes.tsx";
import { SandboxesSection } from "./sandboxes.tsx";

function Limit({ limit }: { limit: LimitWindow }) {
  const used = limit.usedPercent;
  const high = limit.status !== "ok" || (used ?? 0) > 80;
  return (
    <div className="limit">
      <div className="row meta">
        <span className="grow">{limit.name}</span>
        <span className={`tabular ${limit.status === "exceeded" ? "tone-warning" : "muted"}`}>
          {limitText(limit)}
          {limit.resetsAt
            ? ` · resets ${new Date(limit.resetsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`
            : ""}
        </span>
      </div>
      {used !== null ? (
        <div className="meter" data-high={high}>
          <span style={{ width: `${Math.min(100, used)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** One agent's account: who is signed in, how, and the limits it is under. */
function AccountCard({ harness }: { harness: string }) {
  const app = useApp();
  const account = useStore(app.accounts, (all) => all[harness] ?? null);
  const login = useStore(app.login, (value) => (value?.harness === harness ? value : null));
  const canLogin = app.capabilities(harness).login;
  const label = harnessLabel(harness);
  const details = account ? accountDetails(account) : "";
  return (
    <>
      <h2>{label} account</h2>
      <div className="card">
        {account === null ? (
          <div className="note">Reading the account…</div>
        ) : login ? (
          <Setting
            title="Finish signing in in your browser"
            note="The page that opened asks for your ChatGPT account. This updates when you are done."
          >
            <button type="button" className="button" onClick={() => host.openExternal(login.url)}>
              Open it again
            </button>
            <button type="button" className="button" onClick={() => void app.cancelSignIn()}>
              Cancel
            </button>
          </Setting>
        ) : account.kind === null ? (
          canLogin ? (
            <Setting
              title="Not signed in"
              note="Sign in to use the models of your ChatGPT plan. An OPENAI_API_KEY set before Cycle starts works too."
            >
              <button
                type="button"
                className="button primary"
                onClick={() => void app.signIn(harness)}
              >
                Sign in with ChatGPT
              </button>
            </Setting>
          ) : (
            <Setting
              title="Not signed in"
              note={`Sign in with the ${harness} command line, then reopen this page.`}
            />
          )
        ) : (
          <>
            <Setting title={accountTitle(account)} note={details}>
              <Icon name="check-circle" className="tone-success" />
              {canLogin ? (
                <button type="button" className="button" onClick={() => void app.signOut(harness)}>
                  Sign out
                </button>
              ) : null}
            </Setting>
            {account.limits.map((limit) => (
              <Limit key={limit.id} limit={limit} />
            ))}
          </>
        )}
      </div>
    </>
  );
}

/** Models under the name of whoever serves them, the main agent's own first. */
function groupByProvider(models: ModelInfo[]): [string, ModelInfo[]][] {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const name = model.provider?.name ?? harnessLabel(model.harness);
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
  const remote = useStore(app.remote, isRemote);
  if (!update) return null;
  const offer = updateOffer(update);
  // The app is this computer's, whichever server the window shows: say so while one is shown.
  const note = remote
    ? `${offer.note} This is the app on this computer, not the server.`
    : offer.note;
  return (
    <Setting title={`Version ${update.current}`} note={note}>
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
  sandboxes: "Sandboxes",
  remotes: "Remote servers",
  about: "About",
};

export function SettingsPage() {
  const app = useApp();
  const settings = useStore(app.settings, (value) => value);
  const daemon = useStore(app.daemon, (value) => value);
  const models = useStore(app.models, (value) => value);
  const modes = useStore(app.modes, (value) => value);
  const agents = [...new Set(modes.map((mode) => mode.harness))];
  const harnesses = useStore(app.harnesses, (value) => value);
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
                  label="Theme"
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
                  aria-label="Model"
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
              {agents.map((agent) => {
                const current = modeNamed(modes, agent, settings?.modes[agent]);
                return (
                  <Setting
                    key={agent}
                    title={
                      agents.length > 1 ? `Permissions in ${harnessLabel(agent)}` : "Permissions"
                    }
                    note={current?.description ?? ""}
                  >
                    <ModeMenu
                      modes={modesOf(modes, agent)}
                      current={current}
                      onChoose={(mode) => set({ modes: { [agent]: mode } })}
                      className="button"
                    />
                  </Setting>
                );
              })}
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
            {harnesses.map((each) => (
              <AccountCard key={each.name} harness={each.name} />
            ))}

            <h2>Usage</h2>
            <div className="card">
              <UsageChart />
            </div>
          </>
        ) : null}

        {section === "providers" ? <ProvidersSection /> : null}

        {section === "sandboxes" ? <SandboxesSection /> : null}

        {section === "remotes" ? <RemotesSection /> : null}

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

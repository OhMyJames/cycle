import { HOOK_EVENTS, type HookInfo, type HookSettings, type RunSettings } from "@cycle/protocol";
import { useEffect, useState } from "react";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { ConfirmDialog, Setting, Switch } from "./controls.tsx";
import { Icon } from "./icons.tsx";

/** The skills the shown agent has outside any project, each to turn off for every session. */
export function SkillsTab() {
  const app = useApp();
  const home = useStore(app.daemon, (daemon) => daemon?.userHome ?? null);
  const skills = useStore(app.skills, (value) => value);
  useEffect(() => {
    if (home) void app.loadSkills(home);
  }, [app, home]);
  return (
    <section aria-label="Skills">
      <div className="section-head">
        <h2>Skills</h2>
      </div>
      <p className="caption muted">
        Your own, and those your plugins bring. A skill a project brings shows in its sessions, and
        is turned off here by the same name.
      </p>
      {skills === null ? (
        <p className="note" role="status">
          Reading the skills…
        </p>
      ) : skills.length === 0 ? (
        <div className="empty-card">
          <p>No skills yet</p>
        </div>
      ) : (
        <div className="card">
          {skills.map((skill) => (
            <div key={skill.name} className="list-item" data-off={!skill.enabled}>
              <div className="list-row">
                <span className="list-main">
                  <span className="list-lead">
                    <Icon name="sparkle" />
                  </span>
                  <span className="list-text">
                    <span className="list-name fade-x mono">{skill.name}</span>
                    <span className="caption muted fade-x">{skill.description}</span>
                  </span>
                </span>
                <Switch
                  label={skill.enabled ? `Turn ${skill.name} off` : `Turn ${skill.name} on`}
                  checked={skill.enabled}
                  onChange={(enabled) => home && void app.enableSkill(home, skill.name, enabled)}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Text for a number the owner may leave empty; `undefined` when it is not one. */
function numberOrNull(text: string): number | null | undefined {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

const keys = (event: { key: string; currentTarget: HTMLInputElement }) => {
  if (event.key === "Enter") event.currentTarget.blur();
};

/**
 * What a Claude Code process is started with: models to fall back to, and two limits that Claude
 * Code itself counts from its process's start, which a session's closes after five idle minutes.
 */
function RunFields({ run, onChange }: { run: RunSettings; onChange(run: RunSettings): void }) {
  const [fallback, setFallback] = useState(run.fallbackModel ?? "");
  const [turns, setTurns] = useState(run.maxTurns === null ? "" : String(run.maxTurns));
  const [budget, setBudget] = useState(run.maxBudgetUsd === null ? "" : String(run.maxBudgetUsd));
  const commit = () => {
    const maxTurns = numberOrNull(turns);
    const maxBudgetUsd = numberOrNull(budget);
    if (maxTurns === undefined || maxBudgetUsd === undefined) return;
    const next = { ...run, fallbackModel: fallback.trim() || null, maxTurns, maxBudgetUsd };
    if (JSON.stringify(next) !== JSON.stringify(run)) onChange(next);
  };
  return (
    <div className="card">
      <Setting
        title="Suggest what to send next"
        note="After a turn, Claude Code guesses your next message, which shows over the message box. It reuses the turn's prompt cache, so it costs next to nothing. It is left out in plan mode, on a session's first turn, and near your plan's usage limit."
      >
        <Switch
          label="Suggest what to send next"
          checked={run.promptSuggestions}
          onChange={(promptSuggestions) => onChange({ ...run, promptSuggestions })}
        />
      </Setting>
      <Setting
        title="Fallback models"
        note="Model ids, separated by commas, that Claude Code tries in order when the one in use is overloaded. Empty: none."
      >
        <input
          className="field mono"
          aria-label="Fallback models"
          spellCheck={false}
          value={fallback}
          onChange={(event) => setFallback(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={keys}
        />
      </Setting>
      <Setting
        title="Most requests to the model"
        note="Claude Code stops there. It counts from when its process started, and a session's process closes after five idle minutes. Empty: no limit."
      >
        <input
          className="field mono"
          aria-label="Most requests to the model"
          inputMode="numeric"
          value={turns}
          onChange={(event) => setTurns(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={keys}
        />
      </Setting>
      <Setting
        title="Most to spend, in dollars"
        note="Claude Code stops the turn there, counting from when its process started, as above. An estimate. Empty: no limit."
      >
        <input
          className="field mono"
          aria-label="Most to spend, in dollars"
          inputMode="decimal"
          value={budget}
          onChange={(event) => setBudget(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={keys}
        />
      </Setting>
    </div>
  );
}

const NEW_HOOK: HookInfo = { id: "", event: "PreToolUse", matcher: "", command: "", timeout: null };

/** A form for one hook. It is kept only once the owner has read its command and said yes. */
function HookForm({
  hook,
  onSave,
  onCancel,
}: {
  hook: HookInfo;
  onSave(hook: HookInfo): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState(hook);
  const [timeout, setTimeoutText] = useState(hook.timeout === null ? "" : String(hook.timeout));
  const seconds = timeout.trim() === "" ? null : Number(timeout);
  const problem = !draft.command.trim()
    ? "A hook needs a command."
    : seconds !== null && (!Number.isInteger(seconds) || seconds < 1)
      ? "The time is a whole number of seconds."
      : null;
  return (
    <form
      className="list-detail"
      onSubmit={(event) => {
        event.preventDefault();
        if (!problem) onSave({ ...draft, timeout: seconds });
      }}
    >
      <div className="inline-form">
        <select
          className="field select"
          aria-label="When it runs"
          value={draft.event}
          onChange={(event) => setDraft({ ...draft, event: event.currentTarget.value })}
        >
          {HOOK_EVENTS.map((event) => (
            <option key={event} value={event}>
              {event}
            </option>
          ))}
        </select>
        <input
          className="field mono"
          aria-label="For which tools"
          placeholder="Tools it is for, as Bash or Edit|Write; empty for all"
          value={draft.matcher}
          onChange={(event) => setDraft({ ...draft, matcher: event.currentTarget.value })}
        />
      </div>
      <input
        className="field mono"
        aria-label="Command"
        placeholder="The command it runs"
        spellCheck={false}
        value={draft.command}
        onChange={(event) => setDraft({ ...draft, command: event.currentTarget.value })}
      />
      <div className="inline-form">
        <input
          className="field mono"
          aria-label="Seconds it may run"
          placeholder="Seconds it may run; empty for Claude Code's own limit"
          inputMode="numeric"
          value={timeout}
          onChange={(event) => setTimeoutText(event.currentTarget.value)}
        />
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button" disabled={problem !== null}>
          Save
        </button>
      </div>
      {problem && draft.command ? <p className="caption tone-error">{problem}</p> : null}
    </form>
  );
}

/**
 * The hooks Cycle keeps for the shown agent, and how much of the owner's own configuration of it
 * applies. A hook runs any command as the owner, so a new or changed one is asked about first.
 */
export function HooksTab() {
  const app = useApp();
  const settings = useStore(app.hooks, (value) => value);
  /** The hook being edited, by id; "" for one being added. */
  const [editing, setEditing] = useState<string | null>(null);
  const [asking, setAsking] = useState<HookSettings | null>(null);
  const [command, setCommand] = useState("");
  if (settings === null) {
    return (
      <p className="note" role="status">
        Reading the hooks…
      </p>
    );
  }
  const save = (hook: HookInfo) => {
    const hooks =
      hook.id === ""
        ? [...settings.hooks, hook]
        : settings.hooks.map((each) => (each.id === hook.id ? hook : each));
    setCommand(hook.command);
    setAsking({ ...settings, hooks });
  };
  const set = (next: HookSettings) => {
    void app.setHooks(next).then((done) => done && setEditing(null));
  };
  return (
    <section aria-label="Hooks">
      <div className="section-head">
        <h2>Hooks</h2>
        <button
          type="button"
          className="button"
          disabled={editing !== null}
          onClick={() => setEditing("")}
        >
          Add hook
        </button>
      </div>
      <p className="caption muted">
        A hook runs a command as you when Claude Code reaches a point in a session, in every
        session, whatever its mode. The <code>claude</code> command line does not run the ones kept
        here.
      </p>
      {editing === "" ? (
        <div className="card">
          <HookForm hook={NEW_HOOK} onSave={save} onCancel={() => setEditing(null)} />
        </div>
      ) : null}
      {settings.hooks.length === 0 && editing !== "" ? (
        <div className="empty-card">
          <p>No hooks kept here</p>
        </div>
      ) : settings.hooks.length > 0 ? (
        <div className="card">
          {settings.hooks.map((hook) => (
            <div key={hook.id} className="list-item">
              <div className="list-row">
                <span className="list-main">
                  <span className="list-lead">
                    <Icon name="zap" />
                  </span>
                  <span className="list-text">
                    <span className="list-name fade-x mono">{hook.command}</span>
                    <span className="caption muted fade-x">
                      {hook.event}
                      {hook.matcher ? ` · ${hook.matcher}` : ""}
                      {hook.timeout !== null ? ` · ${hook.timeout}s` : ""}
                    </span>
                  </span>
                </span>
                <button
                  type="button"
                  className="icon-button small"
                  aria-label={`Edit the hook that runs ${hook.command}`}
                  disabled={editing !== null}
                  onClick={() => setEditing(hook.id)}
                >
                  <Icon name="edit" size={14} />
                </button>
                <button
                  type="button"
                  className="icon-button small"
                  aria-label={`Remove the hook that runs ${hook.command}`}
                  onClick={() =>
                    set({
                      ...settings,
                      hooks: settings.hooks.filter((each) => each.id !== hook.id),
                    })
                  }
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
              {editing === hook.id ? (
                <HookForm hook={hook} onSave={save} onCancel={() => setEditing(null)} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="section-head sub">
        <h3>How it runs</h3>
      </div>
      <RunFields run={settings.run} onChange={(run) => set({ ...settings, run })} />
      <div className="section-head sub">
        <h3>Your own Claude Code configuration</h3>
      </div>
      <div className="card">
        <Setting
          title="Your settings"
          note="Your ~/.claude settings: their servers, plugins, skills, hooks and permissions. Off, sessions have only what is kept here and in each project."
        >
          <Switch
            label="Read your own Claude Code settings"
            checked={settings.ownerSettings}
            onChange={(ownerSettings) => set({ ...settings, ownerSettings })}
          />
        </Setting>
        <Setting
          title="Your hooks"
          note="Claude Code has one switch for every hook: off, the hooks kept here are off too."
        >
          <Switch
            label="Run your own hooks"
            checked={settings.ownerHooks}
            onChange={(ownerHooks) => set({ ...settings, ownerHooks })}
          />
        </Setting>
      </div>
      {asking ? (
        <ConfirmDialog
          title="Run this command in every session?"
          text="It runs as you, outside Claude Code's sandbox, in every Claude Code session Cycle starts on this machine, whatever its mode."
          action="Keep the hook"
          onConfirm={() => set(asking)}
          onClose={() => setAsking(null)}
        >
          <pre className="dialog-code mono">{command}</pre>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

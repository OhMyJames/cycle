import { type ModelInfo, sameModelFamily } from "@cycle/protocol";
import { useRef, useState } from "react";
import { Icon } from "./icons.tsx";
import { useDismiss } from "./menu.tsx";

/** Whoever serves a group of models: codex itself, or a provider of the owner's. */
interface Group {
  /** Null for codex's own. */
  id: string | null;
  name: string;
  models: ModelInfo[];
}

const EFFORT_NAMES: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

export function effortName(id: string): string {
  return EFFORT_NAMES[id] ?? id;
}

function groupsOf(models: ModelInfo[]): Group[] {
  const groups: Group[] = [];
  for (const model of models) {
    const id = model.provider?.id ?? null;
    let group = groups.find((other) => other.id === id);
    if (!group) {
      group = { id, name: model.provider?.name ?? "Codex", models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

/** A provider's mark in the rail: codex's is Cycle's own, the others their first letter. */
function GroupMark({ group }: { group: Group }) {
  if (group.id === null) return <Icon name="sparkle" />;
  return <span className="mark">{group.name.trim().charAt(0).toUpperCase() || "?"}</span>;
}

/** How hard the chosen model thinks, from its quickest setting to its most careful. */
function EffortSlider({
  model,
  effort,
  onChange,
}: {
  model: ModelInfo;
  effort: string;
  onChange(effort: string): void;
}) {
  const index = Math.max(
    0,
    model.efforts.findIndex((entry) => entry.id === effort),
  );
  return (
    <div className="effort-panel">
      <div className="row">
        <span className="muted">Effort</span>
        <span>{effortName(effort)}</span>
        {effort === model.defaultEffort ? <span className="muted">(default)</span> : null}
      </div>
      <div className="row caption muted effort-ends">
        <span>Faster</span>
        <span>Smarter</span>
      </div>
      <input
        type="range"
        className="effort-range"
        aria-label="Reasoning effort"
        aria-valuetext={effortName(effort)}
        min={0}
        max={model.efforts.length - 1}
        step={1}
        value={index}
        onChange={(event) => {
          const next = model.efforts[Number(event.currentTarget.value)];
          if (next) onChange(next.id);
        }}
      />
      <div className="effort-ticks" aria-hidden="true">
        {model.efforts.map((entry) => (
          <span key={entry.id} />
        ))}
      </div>
    </div>
  );
}

/**
 * The model a session uses and how hard it thinks: providers in a rail, the
 * chosen one's models beside it, and the chosen model's effort on its row.
 */
export function ModelPicker({
  models,
  current,
  begun,
  onChoose,
}: {
  models: ModelInfo[];
  current: { model: string | null; effort: string | null };
  /** Whether the conversation has begun, and so stays with its kind of model. */
  begun: boolean;
  onChoose(model: string, effort: string | null): void;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tuning, setTuning] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useDismiss(open, ref, () => setOpen(false));

  const known = models.find((model) => model.id === current.model);
  const active = known ?? (current.model ? undefined : models.find((model) => model.isDefault));
  const effort = active ? (current.effort ?? active.defaultEffort) : current.effort;
  const groups = groupsOf(models);
  const closed = (group: Group) =>
    begun &&
    active !== undefined &&
    !sameModelFamily({ provider: active.provider }, toFamily(group));
  const group = groups.find((other) => other.id === shown) ?? groups[0];
  const needle = query.trim().toLowerCase();
  const rows = needle
    ? groups
        .filter((other) => !closed(other))
        .flatMap((other) => other.models)
        .filter(
          (model) =>
            model.name.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle),
        )
    : (group?.models ?? []);
  const label = known?.name ?? current.model ?? active?.name ?? "Model";

  return (
    <span className="menu-anchor" ref={ref}>
      <button
        type="button"
        className="ghost"
        title="Model and reasoning effort"
        aria-label="Model and reasoning effort"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setShown(active?.provider?.id ?? null);
          setQuery("");
          setTuning(false);
          setOpen((value) => !value);
        }}
      >
        <span className="fade-x">{label}</span>
        {effort ? <span className="muted">{effortName(effort)}</span> : null}
      </button>
      {open ? (
        <div
          className="menu model-picker"
          role="dialog"
          aria-label="Models"
          data-side="top"
          data-align="start"
        >
          {groups.length > 1 ? (
            <div className="picker-rail" role="tablist" aria-label="Providers">
              {groups.map((other) => (
                <button
                  key={other.id ?? ""}
                  type="button"
                  role="tab"
                  className="rail-item"
                  aria-selected={!needle && other === group}
                  aria-label={other.name}
                  title={
                    closed(other)
                      ? `${other.name}: a session that has begun stays with its kind of model. Start a new session to use these.`
                      : other.name
                  }
                  disabled={closed(other)}
                  onClick={() => {
                    setShown(other.id);
                    setQuery("");
                    setTuning(false);
                  }}
                >
                  <GroupMark group={other} />
                </button>
              ))}
            </div>
          ) : null}
          <div className="picker-main">
            <div className="row picker-head">
              <span className="muted grow fade-x">
                {needle ? "Models" : (group?.name ?? "Models")}
              </span>
              <label className="row picker-search">
                <input
                  autoFocus
                  placeholder="Quick search"
                  aria-label="Search models"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    const first = rows[0];
                    if (event.key === "Enter" && needle && first) {
                      event.preventDefault();
                      onChoose(first.id, null);
                      setQuery("");
                      setShown(first.provider?.id ?? null);
                    }
                  }}
                />
                <Icon name="search" />
              </label>
            </div>
            <div className="picker-list" role="radiogroup" aria-label="Models">
              {rows.map((model) => {
                const chosen = model.id === active?.id;
                return (
                  <div key={model.id} className="picker-row" data-chosen={chosen}>
                    <div className="row">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={chosen}
                        className="picker-model grow"
                        title={model.provider ? model.id : model.description}
                        onClick={() => {
                          if (!chosen) onChoose(model.id, null);
                          setTuning(false);
                        }}
                      >
                        <span className="fade-x">{model.name}</span>
                        {model.isDefault ? <span className="muted">(default)</span> : null}
                      </button>
                      {chosen && effort && model.efforts.length > 1 ? (
                        <button
                          type="button"
                          className="chip effort-chip"
                          aria-expanded={tuning}
                          title="Reasoning effort"
                          onClick={() => setTuning((value) => !value)}
                        >
                          {effortName(effort)}
                          <Icon name="chevron-down" />
                        </button>
                      ) : null}
                      <span className="radio" aria-hidden="true" />
                    </div>
                    {chosen && tuning && effort ? (
                      <EffortSlider
                        model={model}
                        effort={effort}
                        onChange={(next) => onChoose(model.id, next)}
                      />
                    ) : null}
                  </div>
                );
              })}
              {rows.length === 0 ? <div className="note">No model matches.</div> : null}
            </div>
          </div>
        </div>
      ) : null}
    </span>
  );
}

function toFamily(group: Group): Pick<ModelInfo, "provider"> {
  return { provider: group.id === null ? null : { id: group.id, name: group.name } };
}

import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Switch, SwitchThumb } from "@ui-sdk/react/switch";
import { useEffect, useId, useState } from "react";
import type { AgentRuntimePatchValue, AgentRuntimeValue } from "../api.ts";
import { type DynamicConfigOption, effortLevelsOf } from "../model/index.ts";
import { useI18n } from "./i18n.tsx";
import { PageRow, PageRows } from "./page-layout.tsx";

type Choice = {
  const: string;
  title?: string;
  description?: string;
  _meta?: Record<string, unknown>;
};

export type Property = {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  oneOf?: Choice[];
  default?: string;
  _meta?: Record<string, unknown>;
};

export type Option = {
  value: string;
  label: string;
  description?: string | undefined;
  recommended?: boolean;
  danger?: boolean;
  /** On a model: the effort levels it takes; `[]` none, absent not known (docs/protocol.md §10). */
  efforts?: readonly string[] | undefined;
};

/** Marks the choice the agent suggests or warns on, in `_meta`. Mirrors `META` of `@cycle/protocol`. */
const RECOMMENDED = "cycle/recommended";
const DANGER = "cycle/danger";
const NEXT_TURN = "cycle/nextTurn";
const EFFORTS = "cycle/efforts";
const APPLY_SCOPE = "cycle/applyScope";
const ENABLED_WHEN = "cycle/enabledWhen";

/** Whether the agent takes a change to this setting only from its next turn (`cycle/nextTurn`, docs/protocol.md §10). */
export const appliesNextTurn = (property: Property): boolean =>
  property._meta?.[NEXT_TURN] === true;

/** A property's values, with a name and a line on each when the schema gives them (`oneOf`). */
export const optionsOf = (property: Property): Option[] | undefined => {
  if (Array.isArray(property.oneOf)) {
    return property.oneOf
      .filter((c) => typeof c?.const === "string")
      .map((c) => {
        const efforts = effortLevelsOf(c._meta);
        return {
          value: c.const,
          label: c.title ?? c.const,
          description: c.description,
          recommended: c._meta?.[RECOMMENDED] === true,
          danger: c._meta?.[DANGER] === true,
          ...(efforts !== undefined ? { efforts } : {}),
        };
      });
  }
  return property.enum?.map((v) => ({ value: v, label: v }));
};

/**
 * A new session's settings with its effort put back to `default` when the chosen model is known not to take it
 * (docs/protocol.md §10). A session that exists has its agent do this; one not made yet has none to ask.
 */
export const withEffortFor = (
  schema: Record<string, unknown>,
  config: Record<string, string>,
  defaults: Record<string, string> = {},
): Record<string, string> => {
  const properties = (schema.properties ?? {}) as Record<string, Property>;
  const model = config.model ?? defaults.model;
  const effort = config.effort ?? defaults.effort;
  if (properties.effort === undefined || model === undefined) return config;
  if (effort === undefined || effort === "default") return config;
  const levels = optionsOf(properties.model ?? {})?.find((o) => o.value === model)?.efforts;
  if (levels === undefined || levels.includes(effort)) return config;
  return { ...config, effort: "default" };
};

/** The settings an agent says it has, from its JSON Schema: a choice if it lists values, else text. */
export const propertiesOf = (schema: Record<string, unknown>): [string, Property][] => {
  const properties = (schema.properties ?? {}) as Record<string, Property>;
  return Object.entries(properties).filter(([, p]) => p.type === undefined || p.type === "string");
};

/**
 * Overlays live ACP `config_option_update` choices (such as models discovered from `initializationResult().models`
 * and per-model effort levels) onto an agent's static `configSchema`, preserving defaults and metadata.
 */
export const mergeConfigSchema = (
  schema: Record<string, unknown>,
  live: readonly DynamicConfigOption[] | undefined,
): Record<string, unknown> => {
  if (live === undefined || live.length === 0) return schema;
  const properties = (schema.properties ?? {}) as Record<string, Property>;
  let changed = false;
  const nextProperties: Record<string, Property> = { ...properties };
  for (const option of live) {
    if (option.options.length === 0) continue;
    const existing = properties[option.configId];
    const oneOf: Choice[] = option.options.map((c) => ({
      const: c.value,
      title: c.name,
      ...(c.description !== undefined ? { description: c.description } : {}),
      ...(c.recommended || c.danger || c.efforts !== undefined
        ? {
            _meta: {
              ...(c.recommended ? { [RECOMMENDED]: true } : {}),
              ...(c.danger ? { [DANGER]: true } : {}),
              ...(c.efforts !== undefined ? { [EFFORTS]: c.efforts } : {}),
            },
          }
        : {}),
    }));
    nextProperties[option.configId] = {
      ...existing,
      type: existing?.type ?? "string",
      title: existing?.title ?? option.name,
      oneOf,
    };
    changed = true;
  }
  return changed ? { ...schema, properties: nextProperties } : schema;
};

/** How a choice is drawn wherever it is offered: its name, a mark if it is the one suggested, and what it does. */
export function OptionLabel({ option }: { option: Option }) {
  const { t } = useI18n();
  return (
    <span data-slot="option">
      <span data-slot="option-name">
        {option.label}
        {option.recommended ? <span data-slot="option-tag">{t("config.recommended")}</span> : null}
        {option.danger ? (
          <span data-slot="option-tag" data-tone="attention">
            {t("config.caution")}
          </span>
        ) : null}
      </span>
      {option.description ? <span data-slot="option-description">{option.description}</span> : null}
    </span>
  );
}

export type ConfigFormProps = {
  schema: Record<string, unknown>;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  /**
   * Whether a setting with no value shows the schema's `default`. True for what a new session will
   * get; false for a session that exists, whose unknown setting is not necessarily today's default.
   */
  defaults?: boolean;
  /** The settings of a session that exists: a setting its agent takes only from the next turn says so. */
  live?: boolean;
};

export function ConfigForm({
  schema,
  value,
  onChange,
  defaults = true,
  live = false,
}: ConfigFormProps) {
  const { t } = useI18n();
  const set = (key: string, next: string | null) => {
    const { [key]: _old, ...rest } = value;
    onChange(next === null || next === "" ? rest : { ...rest, [key]: next });
  };
  const properties = propertiesOf(schema);
  if (properties.length === 0) return <p data-slot="hint">{t("config.nothingToSet")}</p>;
  return (
    <div data-slot="config-form">
      {properties.map(([key, property]) => {
        const options = optionsOf(property);
        const current = value[key] ?? (defaults ? property.default : undefined) ?? null;
        const chosen = options?.find((o) => o.value === current)?.description;
        return (
          <Field key={key} name={key}>
            <FieldLabel>{property.title ?? key}</FieldLabel>
            {options !== undefined ? (
              <Select
                items={options.map((o) => ({ value: o.value, label: o.label }))}
                value={current}
                placeholder={t("config.notSet")}
                onValueChange={(next) => set(key, next as string | null)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value} label={o.label}>
                      <OptionLabel option={o} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={value[key] ?? ""}
                placeholder={property.default ?? ""}
                onChange={(event) => set(key, event.currentTarget.value)}
              />
            )}
            {property.description ? (
              <FieldDescription>{property.description}</FieldDescription>
            ) : null}
            {chosen ? <FieldDescription>{chosen}</FieldDescription> : null}
            {live && appliesNextTurn(property) ? (
              <FieldDescription>{t("config.nextTurn")}</FieldDescription>
            ) : null}
          </Field>
        );
      })}
    </div>
  );
}

type RuntimePropertyShape = {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  default?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  multipleOf?: unknown;
  enum?: unknown;
  oneOf?: unknown;
  _meta?: unknown;
};

type EnabledWhenCondition = {
  key: string;
  equals: AgentRuntimeValue;
};

type ApplyScope = "immediate" | "next_idle_restart" | "next_session" | "daemon_restart";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const readEnabledWhen = (
  meta: Record<string, unknown> | undefined,
): EnabledWhenCondition | undefined => {
  const raw = meta?.[ENABLED_WHEN];
  if (!isRecord(raw) || typeof raw.key !== "string") return undefined;
  const eq = raw.equals;
  if (typeof eq !== "boolean" && typeof eq !== "number" && typeof eq !== "string") return undefined;
  return { key: raw.key, equals: eq };
};

const readApplyScope = (meta: Record<string, unknown> | undefined): ApplyScope | undefined => {
  const raw = meta?.[APPLY_SCOPE];
  if (
    raw === "immediate" ||
    raw === "next_idle_restart" ||
    raw === "next_session" ||
    raw === "daemon_restart"
  ) {
    return raw;
  }
  return undefined;
};

const formatReadonlyValue = (value: unknown): string => {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export type RuntimeFieldText = {
  title?: string | undefined;
  description?: string | undefined;
};

export type RuntimeConfigFormProps = {
  schema: { type: "object"; properties: Record<string, unknown> };
  values: Record<string, AgentRuntimeValue>;
  overrides: readonly string[];
  /** True when `agent-settings.json` is corrupt (read-only) or a save is disabled globally. */
  disabled?: boolean | undefined;
  /** Property currently being saved, if any. */
  busyKey?: string | undefined;
  onPatch: (patch: Record<string, AgentRuntimePatchValue>) => void;
  /** Optional localized text for known keys; falls back to the daemon's `title` and `description`. */
  describe?: ((key: string) => RuntimeFieldText | undefined) | undefined;
};

/**
 * Closed-schema runtime settings editor (`docs/protocol.md §16`, `CYCL-232`):
 * renders boolean switches, bounded integer inputs, string `oneOf` selects, and read-only
 * fallback for unknown future property types from newer daemons.
 */
export function RuntimeConfigForm({
  schema,
  values,
  overrides,
  disabled = false,
  busyKey,
  onPatch,
  describe,
}: RuntimeConfigFormProps) {
  const entries = Object.entries(schema.properties ?? {});
  if (entries.length === 0) return null;
  const overrideSet = new Set(overrides);

  return (
    <PageRows>
      {entries.map(([key, raw]) => (
        <RuntimeFieldRow
          key={key}
          fieldKey={key}
          rawProperty={raw}
          values={values}
          overridden={overrideSet.has(key)}
          disabled={disabled}
          busy={busyKey !== undefined}
          onPatch={onPatch}
          localized={describe?.(key)}
        />
      ))}
    </PageRows>
  );
}

function RuntimeFieldRow({
  fieldKey,
  rawProperty,
  values,
  overridden,
  disabled,
  busy,
  onPatch,
  localized,
}: {
  fieldKey: string;
  rawProperty: unknown;
  values: Record<string, AgentRuntimeValue>;
  overridden: boolean;
  disabled: boolean;
  busy: boolean;
  onPatch: (patch: Record<string, AgentRuntimePatchValue>) => void;
  localized: RuntimeFieldText | undefined;
}) {
  const { t } = useI18n();
  const labelId = useId();
  const prop: RuntimePropertyShape = isRecord(rawProperty) ? rawProperty : {};
  const meta = isRecord(prop._meta) ? prop._meta : undefined;
  const enabledWhen = readEnabledWhen(meta);
  const applyScope = readApplyScope(meta);
  const danger = meta?.[DANGER] === true;

  const conditionUnmet =
    enabledWhen !== undefined && values[enabledWhen.key] !== enabledWhen.equals;
  const controlDisabled = disabled || busy || conditionUnmet;

  const daemonTitle = typeof prop.title === "string" ? prop.title : undefined;
  const daemonDescription = typeof prop.description === "string" ? prop.description : undefined;
  const label = localized?.title ?? daemonTitle ?? fieldKey;
  const descriptionText = localized?.description ?? daemonDescription;

  const current = values[fieldKey] ?? (prop.default as AgentRuntimeValue | undefined);
  const type = prop.type;
  const stringOptions =
    type === "string"
      ? optionsOf({
          type: "string",
          ...(Array.isArray(prop.oneOf) ? { oneOf: prop.oneOf as Choice[] } : {}),
          ...(Array.isArray(prop.enum) ? { enum: prop.enum as string[] } : {}),
        })
      : undefined;

  const isBoolean = type === "boolean";
  const isInteger = type === "integer";
  const isStringSelect =
    type === "string" && stringOptions !== undefined && stringOptions.length > 0;
  const isSupported = isBoolean || isInteger || isStringSelect;

  const scopeText =
    applyScope !== undefined ? t(`settings.harness.runtime.scope.${applyScope}`) : undefined;

  const descriptionNode = (
    <span data-slot="runtime-description">
      {descriptionText !== undefined ? <span>{descriptionText}</span> : null}
      {!isSupported ? (
        <span data-slot="runtime-meta-note">{t("settings.harness.runtime.unsupportedField")}</span>
      ) : null}
      {scopeText !== undefined || danger ? (
        <span data-slot="runtime-tags">
          {danger ? (
            <span data-slot="option-tag" data-tone="attention">
              {t("config.caution")}
            </span>
          ) : null}
          {scopeText !== undefined ? <span data-slot="runtime-scope">{scopeText}</span> : null}
        </span>
      ) : null}
    </span>
  );

  return (
    <PageRow label={label} labelId={labelId} description={descriptionNode}>
      <div data-slot="runtime-control">
        {overridden && isSupported ? (
          <Button
            type="button"
            data-variant="ghost"
            aria-label={t("settings.harness.runtime.resetField", { field: label })}
            disabled={disabled || busy}
            onClick={() => onPatch({ [fieldKey]: null })}
          >
            {t("settings.harness.runtime.reset")}
          </Button>
        ) : null}
        {isBoolean ? (
          <Switch
            aria-labelledby={labelId}
            checked={current === true}
            disabled={controlDisabled}
            onCheckedChange={(checked) => onPatch({ [fieldKey]: checked === true })}
          >
            <SwitchThumb />
          </Switch>
        ) : isInteger ? (
          <RuntimeIntegerInput
            labelId={labelId}
            value={typeof current === "number" ? current : undefined}
            minimum={typeof prop.minimum === "number" ? prop.minimum : undefined}
            maximum={typeof prop.maximum === "number" ? prop.maximum : undefined}
            multipleOf={typeof prop.multipleOf === "number" ? prop.multipleOf : undefined}
            disabled={controlDisabled}
            onCommit={(next) => onPatch({ [fieldKey]: next })}
          />
        ) : isStringSelect ? (
          <Select
            items={stringOptions.map((o) => ({ value: o.value, label: o.label }))}
            value={typeof current === "string" ? current : null}
            disabled={controlDisabled}
            onValueChange={(next) => {
              if (typeof next === "string" && next !== current) onPatch({ [fieldKey]: next });
            }}
          >
            <SelectTrigger aria-labelledby={labelId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {stringOptions.map((o) => (
                <SelectItem key={o.value} value={o.value} label={o.label}>
                  <OptionLabel option={o} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <code data-slot="reason">{formatReadonlyValue(current)}</code>
        )}
      </div>
    </PageRow>
  );
}

function RuntimeIntegerInput({
  labelId,
  value,
  minimum,
  maximum,
  multipleOf,
  disabled,
  onCommit,
}: {
  labelId: string;
  value: number | undefined;
  minimum: number | undefined;
  maximum: number | undefined;
  multipleOf: number | undefined;
  disabled: boolean;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState(value !== undefined ? String(value) : "");

  // Back to what is saved whenever that changes, and whenever a save settles: a refused save (a conflict, an error)
  // leaves `value` as it was, and the refused number must not stay on screen as if it had been kept.
  useEffect(() => {
    if (disabled) return;
    setDraft(value !== undefined ? String(value) : "");
  }, [value, disabled]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setDraft(value !== undefined ? String(value) : "");
      return;
    }
    const parsed = Number(trimmed);
    const inRange =
      Number.isInteger(parsed) &&
      (minimum === undefined || parsed >= minimum) &&
      (maximum === undefined || parsed <= maximum) &&
      (multipleOf === undefined || parsed % multipleOf === 0);
    if (!inRange) {
      setDraft(value !== undefined ? String(value) : "");
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <Input
      type="number"
      data-slot="runtime-integer"
      aria-labelledby={labelId}
      min={minimum}
      max={maximum}
      step={multipleOf ?? 1}
      disabled={disabled}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

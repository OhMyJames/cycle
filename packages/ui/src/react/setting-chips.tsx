// The session's settings that are a choice (the permission mode, the model and its reasoning effort), at hand in the
// composer utility bar: what the agent does next is decided where the next message is written. Read from the agent's
// own schema, so nothing here knows Claude.
// Each is a menu of radio choices (the SDK's, so keys, focus, dismissal and placement are the same as every other menu):
// a short list that is read at a glance, so no filter. The effort is a chip of its own beside the model's, offering only
// the levels that model takes. The chip shows what the session has, never a value it was asked for and may not get.
import {
  Menu,
  MenuContent,
  MenuGroupLabel,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { useEffect, useId, useRef, useState } from "react";
import { type Option, OptionLabel, optionsOf, propertiesOf } from "./config-form.tsx";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, ShieldAlertIcon, ShieldIcon } from "./icons.tsx";

export type SettingsOf = {
  /** The agent's `configSchema`. */
  schema: Record<string, unknown>;
  /** What the session has: a setting with no value is not shown as today's default, which it may not have. */
  value: Record<string, string>;
};

function SettingPickerChip({
  settingKey,
  heading,
  options,
  current,
  valueLabel,
  compact = false,
  align = "start",
  disabled,
  onSet,
}: {
  settingKey: string;
  heading: string;
  options: readonly Option[];
  current: string | undefined;
  /** What the chip says for the current value, when not the option's own label. */
  valueLabel?: string | undefined;
  /** Compact mode omits option descriptions inside the list (the model's and the effort's: read by name). */
  compact?: boolean;
  align?: "start" | "end";
  disabled: boolean;
  onSet: SetSetting;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);

  const chosen = current === undefined ? undefined : options.find((o) => o.value === current);
  // A value the schema does not list (a model named in full, say) is still what the session runs on: it is shown as it is.
  const named = current === undefined ? t("config.notSet") : (chosen?.label ?? current);
  const label = current === undefined ? named : (valueLabel ?? named);
  const name = t("composer.setting", { setting: heading, value: named });
  // What was last asked for and is not the session's yet. The chip does not show it, but the menu's tick does, and it
  // is what a choice is measured against: asking again for it sends nothing, and going back to the session's value
  // while it is on its way sends that, so the last choice is the one that lands.
  const [asked, setAsked] = useState<string | undefined>(undefined);
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    // The session's value moved: what was asked is answered, or overtaken.
    setSeen(current);
    setAsked(undefined);
  }

  const choose = (value: string) => {
    setAsked(value);
    // Settled with no change (refused, say): nothing is on its way any more, so the same choice can be made again.
    void Promise.resolve(onSet(settingKey, value)).finally(() =>
      setAsked((now) => (now === value ? undefined : now)),
    );
  };

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  const leadingIcon =
    settingKey === "mode" ? (
      chosen?.danger ? (
        <ShieldAlertIcon size={12} data-slot="setting-icon" aria-hidden="true" />
      ) : (
        <ShieldIcon size={12} data-slot="setting-icon" aria-hidden="true" />
      )
    ) : null;

  return (
    // Not modal: with one chip's menu open, a press on the next chip opens that one, rather than only closing this.
    <Menu modal={false} open={open} onOpenChange={(next) => setOpen(next && !disabled)}>
      <MenuTrigger
        ref={triggerRef}
        data-variant="ghost"
        data-kind="setting-chip"
        data-setting={settingKey}
        data-unset={current === undefined || undefined}
        data-danger={chosen?.danger || undefined}
        disabled={disabled}
        aria-label={name}
        title={name}
      >
        {leadingIcon}
        <span data-slot="setting-value">{label}</span>
      </MenuTrigger>
      <MenuContent
        side="top"
        align={align}
        sideOffset={6}
        collisionPadding={12}
        finalFocus={() => triggerRef.current}
        aria-labelledby={headingId}
        data-kind="setting"
        data-compact={compact || undefined}
      >
        <MenuRadioGroup
          value={asked ?? current ?? null}
          onValueChange={(next) => {
            if (typeof next === "string") choose(next);
          }}
        >
          <MenuGroupLabel id={headingId}>{heading}</MenuGroupLabel>
          {options.map((option) => (
            <MenuRadioItem
              key={option.value}
              value={option.value}
              label={option.label}
              closeOnSelect
              data-danger={option.danger || undefined}
              title={option.description}
            >
              <OptionLabel option={compact ? { ...option, description: undefined } : option} />
              <MenuItemIndicator>
                <CheckIcon size={13} />
              </MenuItemIndicator>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/** Asks for a setting; what it returns, if anything, settles when the asking is over. */
export type SetSetting = (key: string, value: string) => unknown;

type ChoiceEntry = {
  key: string;
  heading: string;
  options: Option[];
  current: string | undefined;
};

/** The effort Claude Code runs at when none is asked for (measured; docs/protocol.md §10). */
const DEFAULT_EFFORT_LEVEL_AS = "medium";

/**
 * The effort levels a model takes, from its `cycle/efforts` (docs/protocol.md §10): `undefined` when the model does not
 * say, so every level stays; `[]` when it takes none.
 */
const effortsFor = (models: readonly Option[], model: string | undefined) =>
  model === undefined ? undefined : models.find((m) => m.value === model)?.efforts;

export function SettingChips({
  settings,
  disabled,
  onSet,
  side = "all",
}: {
  settings: SettingsOf;
  disabled: boolean;
  onSet: SetSetting;
  /** Partition settings across the composer utility bar: permission/other on the left, model and effort on the right. */
  side?: "left" | "right" | "all";
}) {
  const { t } = useI18n();
  const entries: ChoiceEntry[] = [];
  for (const [key, property] of propertiesOf(settings.schema)) {
    // A setting the agent keeps to the settings pages (`cycle/composer` false) is no chip here.
    if (property._meta?.["cycle/composer"] === false) continue;
    const options = optionsOf(property);
    if (options === undefined || options.length === 0) continue;
    entries.push({
      key,
      heading: property.title ?? key,
      options,
      current: settings.value[key],
    });
  }
  const modelEntry = entries.find((entry) => entry.key === "model");
  // The effort is the model's second word: right after it, wherever the schema lists it.
  const effortAt = entries.findIndex((entry) => entry.key === "effort");
  if (modelEntry !== undefined && effortAt >= 0) {
    const [effort] = entries.splice(effortAt, 1);
    if (effort !== undefined) entries.splice(entries.indexOf(modelEntry) + 1, 0, effort);
  }
  // The levels the chosen model takes; a model that takes none has no effort to show.
  const levels =
    modelEntry !== undefined ? effortsFor(modelEntry.options, modelEntry.current) : undefined;

  return entries.map((entry) => {
    const isRight = entry.key === "model" || entry.key === "effort";
    if (side === "left" && isRight) return null;
    if (side === "right" && !isRight) return null;
    let options = entry.options;
    let valueLabel: string | undefined;
    const current = entry.current;
    if (entry.key === "effort" && modelEntry !== undefined) {
      if (levels !== undefined)
        options = options.filter(
          // The level in force stays shown until the agent says otherwise, rather than reading "Not set".
          (o) => o.value === "default" || levels.includes(o.value) || o.value === entry.current,
        );
      if (options.length <= 1) return null;
      // `default` is no level of its own: it is the level Claude Code uses unless told otherwise, which is the
      // medium one (measured; the agent does not name it, docs/protocol.md §10). So the `default` row takes medium's
      // place, written "medium (default)". A session set to medium itself keeps a medium row too, or that could not be
      // seen nor cleared. A model with no medium keeps a "Model default" row.
      if (
        options.some((o) => o.value === DEFAULT_EFFORT_LEVEL_AS) &&
        (levels === undefined || levels.includes(DEFAULT_EFFORT_LEVEL_AS))
      ) {
        const medium = options.find((o) => o.value === DEFAULT_EFFORT_LEVEL_AS);
        options = options.flatMap((o) => {
          if (o.value === "default") return [];
          if (o.value !== DEFAULT_EFFORT_LEVEL_AS) return [o];
          const asDefault = options.find((d) => d.value === "default");
          const row =
            asDefault === undefined
              ? []
              : [
                  {
                    ...asDefault,
                    label: t("composer.default.suffix", { name: medium?.label ?? o.label }),
                  },
                ];
          return entry.current === DEFAULT_EFFORT_LEVEL_AS ? [...row, o] : row;
        });
      } else {
        options = options.map((o) =>
          o.value === "default" ? { ...o, label: t("composer.effort.modelDefault") } : o,
        );
        if (entry.current === "default") valueLabel = t("composer.effort.chip");
      }
    }
    return (
      <SettingPickerChip
        key={entry.key}
        settingKey={entry.key}
        heading={entry.heading}
        options={options}
        current={current}
        valueLabel={valueLabel}
        // The model and its effort are read by name; what a level does is in its title.
        compact={isRight}
        align={side === "right" ? "end" : "start"}
        disabled={disabled}
        onSet={onSet}
      />
    );
  });
}

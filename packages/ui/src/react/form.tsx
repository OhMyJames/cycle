import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { useId, useRef, useState } from "react";
import type { FormAnswer, PermissionRequest } from "../api.ts";
import { type Option, OptionLabel, optionsOf } from "./config-form.tsx";
import { useI18n } from "./i18n.tsx";
import { CheckIcon } from "./icons.tsx";
import { useFocusHandoff } from "./permission.tsx";

/** One field of an agent's form, as this card can draw it. A schema is the agent's word: anything else is left out. */
type Base = { key: string; title: string; question?: string; required: boolean };
export type FormField = Base &
  (
    | { kind: "choice"; options: Option[] }
    | { kind: "choices"; options: Option[] }
    | { kind: "text"; max?: number }
    | { kind: "number"; integer: boolean; min?: number; max?: number }
    | { kind: "yes" }
  );

/** The fields a form says must be answered (`required`), drawn or not. */
export const requiredOf = (schema: unknown): string[] => {
  const required = (schema as { required?: unknown } | null)?.required;
  return Array.isArray(required) ? required.filter((key) => typeof key === "string") : [];
};

type Property = Record<string, unknown>;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * The fields of a form, in the schema's order, from the flat JSON Schema MCP and ACP allow: text, a number, yes/no, one
 * of a list (`oneOf` or `enum`), several of a list (an array of those). A question Claude asks is one choice field and
 * one optional text field for an answer of its own (docs/protocol.md §9).
 */
export const fieldsOf = (schema: unknown): FormField[] => {
  const properties = ((schema as { properties?: unknown } | null)?.properties ?? {}) as Record<
    string,
    Property
  >;
  const fields: FormField[] = [];
  const required = new Set(requiredOf(schema));
  for (const [key, property] of Object.entries(properties)) {
    if (typeof property !== "object" || property === null) continue;
    const title = text(property.title) ?? key;
    const question = text(property.description);
    const base = {
      key,
      title,
      ...(question !== undefined ? { question } : {}),
      required: required.has(key),
    };
    if (property.type === "array") {
      const items = (property.items ?? {}) as Property;
      const options = optionsOf({
        ...(Array.isArray(items.anyOf) ? { oneOf: items.anyOf as never } : {}),
        ...(Array.isArray(items.oneOf) ? { oneOf: items.oneOf as never } : {}),
        ...(Array.isArray(items.enum) ? { enum: items.enum as string[] } : {}),
      });
      if (options !== undefined && options.length > 0)
        fields.push({ kind: "choices", ...base, options });
    } else if (property.type === "string" || property.type === undefined) {
      const options = optionsOf(property as never);
      if (options !== undefined && options.length > 0)
        fields.push({ kind: "choice", ...base, options });
      else if (property.type === "string") {
        const max = typeof property.maxLength === "number" ? property.maxLength : undefined;
        fields.push({ kind: "text", ...base, ...(max !== undefined ? { max } : {}) });
      }
    } else if (property.type === "number" || property.type === "integer") {
      const [min, max] = [property.minimum, property.maximum];
      fields.push({
        kind: "number",
        ...base,
        integer: property.type === "integer",
        ...(typeof min === "number" ? { min } : {}),
        ...(typeof max === "number" ? { max } : {}),
      });
    } else if (property.type === "boolean") {
      fields.push({ kind: "yes", ...base });
    }
  }
  return fields;
};

type Value = string | number | boolean | string[];

/** What goes back: the fields that were filled, as the schema types them. A field left empty is left out. */
export const contentOf = (
  fields: readonly FormField[],
  values: Record<string, Value | undefined>,
): Record<string, Value> => {
  const content: Record<string, Value> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (value === undefined) continue;
    if (field.kind === "choices" && Array.isArray(value) && value.length > 0)
      content[field.key] = value;
    else if (field.kind === "number" && typeof value === "string" && value.trim() !== "") {
      // A number the schema would refuse is not sent: the field counts as empty, and a required one keeps the card from
      // being answered. Never rounded or clamped behind the person's back.
      const n = Number(value);
      const fits =
        Number.isFinite(n) &&
        (!field.integer || Number.isInteger(n)) &&
        (field.min === undefined || n >= field.min) &&
        (field.max === undefined || n <= field.max);
      if (fits) content[field.key] = n;
    } else if (field.kind === "yes" && typeof value === "boolean") content[field.key] = value;
    else if ((field.kind === "choice" || field.kind === "text") && typeof value === "string") {
      if (value.trim() !== "") content[field.key] = value;
    }
  }
  return content;
};

export type FormCardProps = {
  request: PermissionRequest & { form: NonNullable<PermissionRequest["form"]> };
  disabled: boolean;
  onAnswer: (key: string, answer: FormAnswer) => unknown;
  /** How many more requests wait behind this one. They are shown one at a time, in the order they came. */
  waiting?: number;
};

/**
 * The agent asks: one card above the input, as a permission is asked. Each question with its choices as rows to pick,
 * and a line for an answer of its own; "Answer" sends what was filled, "Skip" says no answer, dismissing stops the turn
 * as dismissing a permission does.
 */
export function FormCard({ request, disabled, onAnswer, waiting = 0 }: FormCardProps) {
  const { t } = useI18n();
  const card = useRef<HTMLElement>(null);
  useFocusHandoff(card);
  const fields = fieldsOf(request.form.schema);
  const [values, setValues] = useState<Record<string, Value | undefined>>({});
  const set = (key: string, value: Value | undefined) =>
    setValues((was) => ({ ...was, [key]: value }));
  const title = request.form.message !== "" ? request.form.message : t("form.title");
  const content = contentOf(fields, values);
  // A field it must have that this card cannot draw: it cannot be answered here, only skipped or dismissed.
  // Nothing it can draw, or a field it must have that it cannot: it cannot be answered here, only skipped or dismissed.
  const unanswerable =
    fields.length === 0 ||
    requiredOf(request.form.schema).some((key) => !fields.some((field) => field.key === key));
  const missing = fields.some((field) => field.required && content[field.key] === undefined);
  // An answer with nothing in it is not one: Skip says that.
  const empty = Object.keys(content).length === 0;
  const ready = !disabled && !unanswerable && !missing && !empty;
  const submit = () => onAnswer(request.key, { action: "accept", content });
  return (
    <section ref={card} data-slot="permission" data-kind="form" aria-label={title} tabIndex={-1}>
      <div data-slot="permission-title">
        {title}
        {waiting > 0 ? (
          <span data-slot="permission-waiting">{t("permission.waiting", { count: waiting })}</span>
        ) : null}
      </div>
      <form
        data-slot="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) void submit();
        }}
      >
        {/* The questions scroll; what answers them stays in reach under them. */}
        <div data-slot="form-fields">
          {fields.map((field) => (
            <FieldView
              key={field.key}
              field={field}
              value={values[field.key]}
              // A question's own title is said once: a field that only repeats the form's message is not titled again.
              repeat={field.question === request.form.message}
              disabled={disabled}
              onChange={(value) => set(field.key, value)}
            />
          ))}
        </div>
        {unanswerable ? <p data-slot="tool-note">{t("form.cannotShow")}</p> : null}
        <div data-slot="permission-actions">
          <Button type="submit" data-variant="solid" disabled={!ready}>
            {t("form.answer")}
          </Button>
          <Button
            type="button"
            data-variant="outline"
            disabled={disabled}
            onClick={() => onAnswer(request.key, { action: "decline" })}
          >
            {t("form.skip")}
          </Button>
          <Button
            type="button"
            data-variant="ghost"
            data-kind="permission-dismiss"
            disabled={disabled}
            onClick={() => onAnswer(request.key, { action: "cancel" })}
          >
            {t("permission.dismiss")}
          </Button>
        </div>
      </form>
    </section>
  );
}

function FieldView({
  field,
  value,
  repeat,
  disabled,
  onChange,
}: {
  field: FormField;
  value: Value | undefined;
  repeat: boolean;
  disabled: boolean;
  onChange: (value: Value | undefined) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  // The header names it ("Library"), the question asks it ("Which library should we use?").
  const heading =
    field.question !== undefined && !repeat ? (
      <span data-slot="form-question" id={`${id}-q`}>
        {field.question}
      </span>
    ) : null;
  if (field.kind === "choice" || field.kind === "choices") {
    const several = field.kind === "choices";
    const chosen = several ? (Array.isArray(value) ? value : []) : [value];
    const toggle = (option: string) => {
      if (!several) return onChange(value === option ? undefined : option);
      const list = Array.isArray(value) ? value : [];
      onChange(list.includes(option) ? list.filter((v) => v !== option) : [...list, option]);
    };
    return (
      <fieldset
        data-slot="form-field"
        data-kind={field.kind}
        aria-describedby={heading !== null ? `${id}-q` : undefined}
      >
        <legend data-slot="form-title">
          {field.title}
          {field.required ? <span data-slot="form-required">{t("form.required")}</span> : null}
        </legend>
        {heading}
        <div data-slot="form-options">
          {field.options.map((option) => (
            <label key={option.value} data-slot="form-option">
              <input
                type={several ? "checkbox" : "radio"}
                name={id}
                value={option.value}
                checked={chosen.includes(option.value)}
                disabled={disabled}
                // A radio cannot be unchecked by itself: clicking the chosen one again takes the choice back.
                onClick={() => toggle(option.value)}
                onChange={() => {}}
              />
              <span data-slot="form-mark" data-several={several || undefined} aria-hidden="true">
                {several ? <CheckIcon size={12} /> : null}
              </span>
              <OptionLabel option={option} />
            </label>
          ))}
        </div>
        {several ? <span data-slot="form-hint">{t("form.several")}</span> : null}
      </fieldset>
    );
  }
  if (field.kind === "yes") {
    return (
      <div data-slot="form-field" data-kind="yes">
        <label data-slot="form-option">
          <input
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
          <span data-slot="form-mark" data-several aria-hidden="true">
            <CheckIcon size={12} />
          </span>
          <span data-slot="option-name">{field.title}</span>
        </label>
        {heading}
      </div>
    );
  }
  // A line to write in: what it is for is its placeholder ("Your own answer, if none of the choices fits").
  return (
    <Field name={field.key} data-slot="form-field" data-kind={field.kind}>
      <FieldLabel data-slot="form-title">
        {field.title}
        {field.required ? <span data-slot="form-required">{t("form.required")}</span> : null}
      </FieldLabel>
      <Input
        type={field.kind === "number" ? "number" : "text"}
        {...(field.question !== undefined ? { placeholder: field.question } : {})}
        value={typeof value === "string" ? value : ""}
        {...(field.kind === "text" && field.max !== undefined ? { maxLength: field.max } : {})}
        {...(field.kind === "number"
          ? {
              step: field.integer ? 1 : "any",
              ...(field.min !== undefined ? { min: field.min } : {}),
              ...(field.max !== undefined ? { max: field.max } : {}),
            }
          : {})}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

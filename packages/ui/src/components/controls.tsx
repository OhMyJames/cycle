import type { ReactNode } from "react";
import { Dialog } from "./menu.tsx";

export function Segmented<T extends string>({
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
export function Switch({
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

export function Setting({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children?: ReactNode;
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

/** A labelled part of a form: the label over its control, with a line of help under it. */
export function FormField({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <label className="form-field">
      <span className="form-label">{label}</span>
      {children}
      {help ? <span className="caption muted">{help}</span> : null}
    </label>
  );
}

/** A question before something is removed, with the action in the danger color. */
export function ConfirmDialog({
  title,
  text,
  action,
  onConfirm,
  onClose,
}: {
  title: string;
  text: string;
  action: string;
  onConfirm(): void;
  onClose(): void;
}) {
  return (
    <Dialog label={title} onClose={onClose}>
      <div className="dialog-body">
        <h2 className="dialog-title">{title}</h2>
        <p className="dialog-text">{text}</p>
      </div>
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button danger"
          autoFocus
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {action}
        </button>
      </div>
    </Dialog>
  );
}

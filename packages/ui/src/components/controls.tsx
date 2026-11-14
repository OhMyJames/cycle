import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import { type ReactNode, useRef } from "react";
import { Dialog } from "./menu.tsx";

/**
 * One of a few choices, all in view: a radio group with one Tab stop, where the arrow keys move
 * the choice. The behavior is ui-sdk's; the look is Cycle's `.segmented`.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  /** What is being chosen, for a reader that cannot see the row it sits in. */
  label: string;
  value: T;
  /** An option marked `deliberate` is chosen by a press only: the arrow keys never land on it. */
  options: { value: T; label: string; deliberate?: boolean }[];
  onChange(value: T): void;
}) {
  return (
    <SegmentedControl<T>
      className="segmented"
      aria-label={label}
      value={value}
      onValueChange={(next, details) => {
        if (next === null) return;
        const deliberate = options.some((option) => option.value === next && option.deliberate);
        if (deliberate && details.reason === "list-navigation") details.cancel();
        else onChange(next);
      }}
    >
      {options.map((option) => (
        <SegmentedControlItem key={option.value} className="segment" value={option.value}>
          {option.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
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

/**
 * A key for each row of a list the owner edits, where the rows have no id of their own. A row keeps
 * its key while rows before it come and go, so its field keeps the focus and what is being typed.
 * Call `remove` with the index as a row is taken out; new rows at the end get new keys.
 */
export function useRowKeys(count: number): {
  keys: readonly number[];
  remove(index: number): void;
} {
  const keys = useRef<number[]>([]);
  const next = useRef(0);
  while (keys.current.length < count) keys.current.push(next.current++);
  keys.current.length = count;
  return { keys: keys.current, remove: (index) => void keys.current.splice(index, 1) };
}

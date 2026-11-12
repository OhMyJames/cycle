import { type ReactNode, useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./icons.tsx";

export type MenuEntry =
  | {
      label: string;
      sub?: string;
      icon?: IconName;
      hint?: string;
      checked?: boolean;
      danger?: boolean;
      onSelect(): void;
    }
  | { separator: true }
  | { heading: string };

function isItem(entry: MenuEntry): entry is Extract<MenuEntry, { label: string }> {
  return "label" in entry;
}

/** Closes something when a press lands outside it or Escape is pressed. */
export function useDismiss(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, ref, close]);
}

export function MenuList({
  entries,
  active,
  onPick,
}: {
  entries: MenuEntry[];
  active: number;
  onPick(entry: Extract<MenuEntry, { label: string }>): void;
}) {
  let index = -1;
  return entries.map((entry, position) => {
    if ("separator" in entry) return <div key={position} className="menu-separator" />;
    if ("heading" in entry) {
      return (
        <div key={position} className="menu-label">
          {entry.heading}
        </div>
      );
    }
    index++;
    return (
      <button
        key={position}
        type="button"
        role="menuitem"
        className={entry.danger ? "menu-item danger" : "menu-item"}
        data-active={index === active}
        ref={index === active ? (node) => node?.scrollIntoView({ block: "nearest" }) : undefined}
        onClick={() => onPick(entry)}
      >
        {entry.icon ? <Icon name={entry.icon} /> : null}
        <span className="grow">
          <span className="truncate" style={{ display: "block" }}>
            {entry.label}
          </span>
          {entry.sub ? <span className="sub">{entry.sub}</span> : null}
        </span>
        {entry.hint ? <span className="hint">{entry.hint}</span> : null}
        {entry.checked ? <Icon name="check" /> : null}
      </button>
    );
  });
}

/** A button that opens a list of choices beside it. */
export function Menu({
  children,
  entries,
  className = "ghost",
  title,
  side = "bottom",
  align = "start",
  disabled,
}: {
  children: ReactNode;
  entries(): MenuEntry[];
  className?: string;
  title?: string;
  side?: "top" | "bottom";
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLSpanElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  const list = open ? entries() : [];
  const items = list.filter(isItem);
  const pick = (entry: Extract<MenuEntry, { label: string }>) => {
    setOpen(false);
    entry.onSelect();
  };
  return (
    <span
      className="menu-anchor"
      ref={ref}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActive((current) => (current + step + items.length) % Math.max(items.length, 1));
        } else if (event.key === "Enter" && items[active]) {
          event.preventDefault();
          pick(items[active]);
        }
      }}
    >
      <button
        type="button"
        className={className}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={(event) => {
          event.stopPropagation();
          setActive(-1);
          setOpen((value) => !value);
        }}
      >
        {children}
      </button>
      {open ? (
        <div className="menu" role="menu" data-side={side} data-align={align}>
          <MenuList entries={list} active={active} onPick={pick} />
        </div>
      ) : null}
    </span>
  );
}

export function Dialog({
  children,
  onClose,
  label,
}: {
  children: ReactNode;
  onClose(): void;
  label: string;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

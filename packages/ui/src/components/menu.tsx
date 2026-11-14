import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons.tsx";

export type MenuEntry =
  | {
      label: string;
      sub?: string;
      /** What it is, after its label on the same line, where a list is long. */
      detail?: string;
      icon?: IconName;
      hint?: string;
      checked?: boolean;
      danger?: boolean;
      /** Stands apart in the warning color, as a mode that runs everything unasked. */
      warning?: boolean;
      disabled?: boolean;
      onSelect(): void;
    }
  | { separator: true }
  | { heading: string };

/** Where popups are drawn: over the page, inside the root that the fades are watched in. */
const overlayRoot = (): Element => document.querySelector(".app") ?? document.body;

function isItem(entry: MenuEntry): entry is Extract<MenuEntry, { label: string }> {
  return "label" in entry;
}

/**
 * Closes something when a press lands outside it or Escape is pressed. A menu's popup is drawn at
 * the end of the page, so that nothing clips it: a press inside one is never outside.
 */
export function useDismiss(
  open: boolean,
  ref: React.RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || ref.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".menu")) return;
      if (target instanceof Element && target.closest(".scrim") && !under()) return;
      close();
    };
    // A dialog opened from here is on top: a press in it, or Escape, is the dialog's.
    const under = () => ref.current?.closest(".scrim") != null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (document.querySelector(".scrim") && !under()) return;
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
  // Rows share one icon column, so a row without an icon keeps its place in a list that has them.
  const icons = entries.some((entry) => "label" in entry && entry.icon !== undefined);
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
        role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
        aria-checked={entry.checked}
        className={
          entry.danger ? "menu-item danger" : entry.warning ? "menu-item warning" : "menu-item"
        }
        disabled={entry.disabled}
        data-active={index === active}
        ref={index === active ? (node) => node?.scrollIntoView({ block: "nearest" }) : undefined}
        onClick={() => onPick(entry)}
      >
        {entry.icon ? <Icon name={entry.icon} /> : icons ? <span className="icon-space" /> : null}
        {entry.detail ? (
          <span className="grow one-line fade-x" title={entry.detail}>
            <span>{entry.label}</span>
            <span className="detail">{entry.detail}</span>
          </span>
        ) : (
          <span className="grow">
            <span className="fade-x" style={{ display: "block" }}>
              {entry.label}
            </span>
            {entry.sub ? <span className="sub">{entry.sub}</span> : null}
          </span>
        )}
        {entry.hint ? <span className="hint">{entry.hint}</span> : null}
        {entry.checked ? <Icon name="check" className="check" /> : null}
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
  width,
}: {
  children: ReactNode;
  entries(): MenuEntry[];
  className?: string;
  title?: string;
  side?: "top" | "bottom" | "right";
  /** The popup's width in px, where the design fixes one. */
  width?: number;
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const ref = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  useDismiss(open, ref, () => setOpen(false));
  const list = open ? entries() : [];
  const count = list.length;
  // Placed against the window, 6 from its button, so no scroller or card it sits in can clip it.
  useLayoutEffect(() => {
    const anchor = ref.current?.getBoundingClientRect();
    const node = popup.current;
    if (!open || !anchor || !node) {
      setPlace(null);
      return;
    }
    const { offsetWidth, offsetHeight } = node;
    const left =
      side === "right"
        ? anchor.right + 6
        : align === "start"
          ? anchor.left
          : anchor.right - offsetWidth;
    const top =
      side === "right"
        ? anchor.top
        : side === "top"
          ? anchor.top - 6 - offsetHeight
          : anchor.bottom + 6;
    setPlace({
      left: Math.max(8, Math.min(left, window.innerWidth - offsetWidth - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - offsetHeight - 8)),
    });
  }, [open, side, align, count]);
  const items = list.filter(isItem).filter((entry) => !entry.disabled);
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
      {open
        ? createPortal(
            <div
              className="menu"
              ref={popup}
              role="menu"
              data-side={side}
              style={{
                ...(width === undefined ? {} : { width, minWidth: width }),
                ...(place ?? { visibility: "hidden" }),
              }}
            >
              <MenuList entries={list} active={active} onPick={pick} />
            </div>,
            overlayRoot(),
          )
        : null}
    </span>
  );
}

export function Dialog({
  children,
  onClose,
  label,
  wide,
  top,
}: {
  children: ReactNode;
  onClose(): void;
  label: string;
  /** A list to search rather than a question: wider, and near the top of the window. */
  wide?: boolean;
  top?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focusable = (): HTMLElement[] => [
      ...(box.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select, textarea, [tabindex='0']",
      ) ?? []),
    ];
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      // Tab stays inside the dialog: what is behind it cannot be reached while it is open.
      if (event.key !== "Tab") return;
      const all = focusable();
      const first = all[0];
      const last = all.at(-1);
      if (!first || !last) return;
      const at = document.activeElement;
      const inside = at instanceof Node && box.current?.contains(at);
      if (event.shiftKey ? at === first || !inside : at === last || !inside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Focus goes into the dialog when it opens, and back to where it was when it closes.
  // Read while drawing, before a field inside takes the focus for itself.
  const [before] = useState(() => document.activeElement);
  useEffect(() => {
    if (!box.current?.contains(document.activeElement)) {
      box.current?.querySelector<HTMLElement>("input, textarea, button")?.focus();
    }
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, [before]);
  // Drawn over the whole window, so no scroller or mask it was opened from clips it.
  return createPortal(
    <div
      className={top ? "scrim top" : "scrim"}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        className={wide ? "dialog wide" : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>,
    overlayRoot(),
  );
}

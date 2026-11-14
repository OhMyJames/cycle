import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Menu as UiMenu,
} from "@ui-sdk/react/menu";
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
        className={rowClass(entry)}
        disabled={entry.disabled}
        data-active={index === active}
        ref={index === active ? (node) => node?.scrollIntoView({ block: "nearest" }) : undefined}
        onClick={() => onPick(entry)}
      >
        {rowContent(entry, icons)}
      </button>
    );
  });
}

type MenuChoice = Extract<MenuEntry, { label: string }>;

/** What a row shows, the same in a menu and in the palette's list. */
function rowContent(entry: MenuChoice, icons: boolean): ReactNode {
  return (
    <>
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
    </>
  );
}

const rowClass = (entry: MenuChoice): string =>
  entry.danger ? "menu-item danger" : entry.warning ? "menu-item warning" : "menu-item";

/**
 * A button that opens a list of choices beside it. The behavior is ui-sdk's menu: the focus goes
 * into the list, the arrow keys, Home, End and typing a name move in it, Escape and a press outside
 * close it, and the focus goes back to the button. The look is Cycle's `.menu`.
 */
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
  const list = open ? entries() : [];
  const icons = list.some((entry) => "label" in entry && entry.icon !== undefined);
  // A heading names the rows under it, up to the next heading or line.
  const groups: { heading?: string; rows: { entry: MenuEntry; at: number }[] }[] = [{ rows: [] }];
  list.forEach((entry, at) => {
    if ("heading" in entry) groups.push({ heading: entry.heading, rows: [] });
    else if ("separator" in entry) groups.push({ rows: [{ entry, at }] }, { rows: [] });
    else groups.at(-1)?.rows.push({ entry, at });
  });
  const row = ({ entry, at }: { entry: MenuEntry; at: number }) => {
    if ("separator" in entry) return <MenuSeparator key={at} className="menu-separator" />;
    if (!isItem(entry)) return null;
    // A choice that is on or off says so; picking it closes the menu, as picking any row does.
    return entry.checked === undefined ? (
      <MenuItem
        key={at}
        className={rowClass(entry)}
        label={entry.label}
        disabled={entry.disabled ?? false}
        onSelect={() => entry.onSelect()}
      >
        {rowContent(entry, icons)}
      </MenuItem>
    ) : (
      <MenuCheckboxItem
        key={at}
        value={String(at)}
        className={rowClass(entry)}
        label={entry.label}
        disabled={entry.disabled ?? false}
        checked={entry.checked}
        closeOnSelect
        onCheckedChange={() => entry.onSelect()}
      >
        {rowContent(entry, icons)}
      </MenuCheckboxItem>
    );
  };
  return (
    <span className="menu-anchor">
      <UiMenu open={open} onOpenChange={setOpen} modal={false}>
        <MenuTrigger
          className={className}
          title={title}
          aria-label={title}
          disabled={disabled ?? false}
          onClick={(event) => event.stopPropagation()}
        >
          {children}
        </MenuTrigger>
        <MenuContent
          className="menu"
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          container={overlayRoot()}
          style={width === undefined ? {} : { width, minWidth: width }}
        >
          {groups.map((group, index) =>
            group.heading === undefined ? (
              group.rows.map(row)
            ) : (
              <MenuGroup key={`group-${index}`}>
                <MenuGroupLabel className="menu-label">{group.heading}</MenuGroupLabel>
                {group.rows.map(row)}
              </MenuGroup>
            ),
          )}
        </MenuContent>
      </UiMenu>
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
  // A dialog opened from a menu's row comes back to that menu's button: the row is gone by then.
  const [before] = useState(() => {
    const at = document.activeElement;
    return at?.closest(".menu")
      ? document.querySelector('[data-slot="menu-trigger"][data-open]')
      : at;
  });
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

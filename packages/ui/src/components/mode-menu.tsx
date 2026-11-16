import type { ModeInfo, SessionMode } from "@cycle/protocol";
import { modeIcon, modeLabel } from "../lib/modes.ts";
import { Menu, type MenuEntry } from "./menu.tsx";

/** The rows of one agent's modes. One that never asks stands apart, in the warning color. */
export function modeEntries(
  modes: readonly ModeInfo[],
  current: SessionMode | null,
  choose: (mode: SessionMode) => void,
): MenuEntry[] {
  return modes.flatMap((mode, index): MenuEntry[] => [
    ...(mode.dangerous && !modes[index - 1]?.dangerous ? [{ separator: true } as const] : []),
    {
      label: modeLabel(mode),
      sub: mode.description,
      icon: modeIcon(mode),
      warning: mode.dangerous,
      checked: mode.id === current,
      onSelect: () => choose(mode.id),
    },
  ]);
}

/**
 * Picks one of an agent's modes. Its rows are taken by a press, so no arrow key lands on a mode
 * that never asks.
 */
export function ModeMenu({
  modes,
  current,
  onChoose,
  side = "bottom",
  className,
}: {
  /** One agent's modes, as `modesOf` gives them. */
  modes: readonly ModeInfo[];
  current: ModeInfo | undefined;
  onChoose(mode: SessionMode): void;
  side?: "top" | "bottom";
  className?: string;
}) {
  if (!current) return null;
  return (
    <Menu
      side={side}
      title="How much the agent may do unasked"
      entries={() => modeEntries(modes, current.id, onChoose)}
      width={320}
      {...(className ? { className } : {})}
    >
      <span className={current.dangerous ? "tone-warning" : undefined}>{current.name}</span>
    </Menu>
  );
}

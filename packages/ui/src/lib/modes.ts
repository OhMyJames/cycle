import { type ModeInfo, resolveMode } from "@cycle/protocol";
import type { IconName } from "../components/icons.tsx";

/** One agent's modes, in the order it offers them, with the ones that never ask last. */
export function modesOf(modes: readonly ModeInfo[], harness: string): ModeInfo[] {
  const own = modes.filter((mode) => mode.harness === harness);
  return [...own.filter((mode) => !mode.dangerous), ...own.filter((mode) => mode.dangerous)];
}

/** A mode as a value names it among one agent's: an old one by what replaced it, else the default. */
export function modeNamed(
  modes: readonly ModeInfo[],
  harness: string,
  value: string | null | undefined,
): ModeInfo | undefined {
  return resolveMode(modesOf(modes, harness), value);
}

/** A mode's name in a list of choices, which marks the agent's default. */
export function modeLabel(mode: ModeInfo): string {
  return mode.isDefault ? `${mode.name} (default)` : mode.name;
}

/** What a mode is drawn with: how much it lets the agent do unasked. */
export function modeIcon(mode: ModeInfo): IconName {
  if (mode.dangerous) return "warning";
  if (mode.plan) return "lightbulb";
  if (mode.replaces === "readOnly") return "lock";
  if (mode.isDefault || mode.replaces === "auto") return "automation";
  return "sparkle";
}

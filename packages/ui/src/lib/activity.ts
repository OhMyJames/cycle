import type { Item } from "@cycle/protocol";
import type { IconName } from "../components/icons.tsx";
import { basename } from "./format.ts";

/**
 * What the agent did, as the conversation words it: each piece of work has a kind, which gives its
 * verb, its icon and its phrase in a card's summary. The wording is old-cycle's.
 */
export type ActivityKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "list"
  | "execute"
  | "fetch"
  | "other";

/** An item that is work rather than words: what a card holds. */
export type ActivityItem = Extract<
  Item,
  { kind: "command" | "fileChange" | "toolCall" | "webSearch" | "image" }
>;

export function isActivity(item: Item): item is ActivityItem {
  return (
    item.kind === "command" ||
    item.kind === "fileChange" ||
    item.kind === "toolCall" ||
    item.kind === "webSearch" ||
    item.kind === "image"
  );
}

const ACTIONS: Readonly<Record<ActivityKind, readonly [running: string, done: string]>> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  delete: ["Deleting", "Deleted"],
  move: ["Moving", "Moved"],
  search: ["Searching", "Searched"],
  list: ["Listing", "Listed"],
  execute: ["Running", "Ran"],
  fetch: ["Fetching", "Fetched"],
  other: ["Calling", "Called"],
};

/** The icon of each kind of work, as old-cycle's tool rows have them. */
export const KIND_ICONS: Readonly<Record<ActivityKind, IconName>> = {
  read: "file",
  edit: "edit",
  delete: "trash",
  move: "file",
  search: "search",
  list: "folder",
  execute: "terminal",
  fetch: "globe",
  other: "wrench",
};

/** The command a shell wrapper was given, without the wrapper. */
export function plainCommand(command: string): string {
  const single = /^(?:\/\S+\/)?(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(command);
  if (single?.[1] !== undefined) return single[1].replaceAll("'\\''", "'");
  const double = /^(?:\/\S+\/)?(?:ba|z)?sh -l?c "([\s\S]*)"$/.exec(command);
  if (double?.[1] !== undefined) return double[1].replace(/\\(["$`\\])/g, "$1");
  return command;
}

/** A command's kind: what the harness says it was for, when every part of it was for the same. */
function commandKind(item: Extract<Item, { kind: "command" }>): ActivityKind {
  const [first] = item.actions;
  if (!first || item.actions.some((action) => action.type !== first.type)) return "execute";
  return first.type;
}

function changeKind(change: {
  change: "add" | "delete" | "update";
  movePath?: string;
}): ActivityKind {
  if (change.change === "delete") return "delete";
  return change.movePath ? "move" : "edit";
}

export function activityKind(item: ActivityItem): ActivityKind {
  switch (item.kind) {
    case "command":
      return commandKind(item);
    case "fileChange":
      return item.changes[0] ? changeKind(item.changes[0]) : "edit";
    case "toolCall":
      return "other";
    case "webSearch":
      return "search";
    case "image":
      return "read";
  }
}

export type ActivityStatus = "running" | "completed" | "failed" | "declined";

export function activityStatus(item: ActivityItem): ActivityStatus {
  return item.kind === "webSearch" || item.kind === "image" ? "completed" : item.status;
}

const files = (count: number): string => (count === 1 ? "1 file" : `${count} files`);

/** One row's words: what was done, then to what. */
export function activityRow(item: ActivityItem): {
  kind: ActivityKind;
  icon: IconName;
  action: string;
  detail: string;
} {
  const kind = activityKind(item);
  const running = activityStatus(item) === "running";
  const action = ACTIONS[kind][running ? 0 : 1];
  switch (item.kind) {
    case "command": {
      const [first] = item.actions;
      const detail =
        kind === "execute" || !first
          ? plainCommand(item.command)
          : item.actions.length > 1
            ? kind === "read"
              ? files(item.actions.length)
              : kind === "list"
                ? `${item.actions.length} folders`
                : `${item.actions.length} times`
            : first.type === "read"
              ? basename(first.path)
              : first.type === "search"
                ? (first.query ?? first.path ?? "")
                : (first.path ?? "files");
      return { kind, icon: KIND_ICONS[kind], action, detail };
    }
    case "fileChange": {
      const [first] = item.changes;
      const created =
        item.changes.length > 0 && item.changes.every((each) => each.change === "add");
      return {
        kind,
        icon: KIND_ICONS[kind],
        action: created ? (running ? "Creating" : "Created") : action,
        detail:
          item.changes.length === 1 && first
            ? basename(first.movePath ?? first.path)
            : files(item.changes.length),
      };
    }
    case "toolCall":
      return {
        kind,
        icon: KIND_ICONS[kind],
        action,
        detail: item.server ? `${item.server}.${item.tool}` : item.tool,
      };
    case "webSearch":
      return { kind, icon: "globe", action: "Searched the web", detail: item.query };
    case "image":
      return { kind, icon: "image", action: "Viewed", detail: basename(item.path) };
  }
}

/** How many of each kind an item did, for a card's summary: a change of three files edited three. */
function unitsOf(item: ActivityItem): [ActivityKind, number][] {
  if (item.kind === "fileChange") {
    return item.changes.length === 0
      ? [["edit", 1]]
      : item.changes.map((change) => [changeKind(change), 1]);
  }
  if (item.kind === "command") {
    const kind = commandKind(item);
    return [[kind, kind === "execute" ? 1 : item.actions.length]];
  }
  return [[activityKind(item), 1]];
}

const PHRASES: Readonly<Record<ActivityKind, (count: number) => string>> = {
  read: (count) => `read ${files(count)}`,
  edit: (count) => `edited ${files(count)}`,
  delete: (count) => `deleted ${files(count)}`,
  move: (count) => `moved ${files(count)}`,
  search: (count) => (count === 1 ? "searched once" : `searched ${count} times`),
  list: (count) => `listed ${count === 1 ? "1 folder" : `${count} folders`}`,
  execute: (count) => `ran ${count === 1 ? "1 command" : `${count} commands`}`,
  fetch: (count) => `fetched ${count === 1 ? "1 page" : `${count} pages`}`,
  other: (count) => `used ${count === 1 ? "1 tool" : `${count} tools`}`,
};

/**
 * A card's header: what its work came to, each kind once in the order it first happened, as
 * "Read 3 files, ran 2 commands".
 */
export function activitySummary(items: readonly ActivityItem[]): string {
  const counts = new Map<ActivityKind, number>();
  for (const item of items) {
    for (const [kind, count] of unitsOf(item)) counts.set(kind, (counts.get(kind) ?? 0) + count);
  }
  const text = [...counts].map(([kind, count]) => PHRASES[kind](count)).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** How many of a card's items failed, which its header says beside the summary. */
export function failedCount(items: readonly ActivityItem[]): number {
  return items.filter((item) => activityStatus(item) === "failed").length;
}

/** What each kind of work looks like from outside, for the loader of dots. */
export function loaderStateOf(kind: ActivityKind): "searching" | "executing" {
  return kind === "read" || kind === "search" || kind === "list" || kind === "fetch"
    ? "searching"
    : "executing";
}

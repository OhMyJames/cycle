// What a page, a panel or a list shows instead of its content (CYCL-67): nothing yet, loading, failed, or the
// environment is away. One block, so every place says it the same way: an icon only where it carries meaning, one line
// of what happened, a line of what to do, the system's own words in monospace (selectable, never retyped into prose),
// and at most one action. An empty or failed state always offers a way on (DESIGN.md §4.6).
import { Button } from "@ui-sdk/react/button";
import { ErrorCircleIcon, WarningIcon } from "./icons.tsx";

export type StateTone = "empty" | "loading" | "error" | "away";

export function StateBlock({
  tone,
  title,
  body,
  reason,
  action,
  secondaryAction,
  size = "page",
  align = "center",
}: {
  tone: StateTone;
  /** What is the case, in one line. */
  title: string;
  /** What it means, or what to do, when the title does not say. */
  body?: string | undefined;
  /** The system's or the remote's own words: shown as they are, in monospace. */
  reason?: string | undefined;
  action?: { label: string; onAction: () => void } | undefined;
  secondaryAction?: { label: string; onAction: () => void } | undefined;
  /** `page`: a whole pane's; `inline`: within a panel, a list or a dialog. */
  size?: "page" | "inline";
  align?: "center" | "start";
}) {
  const icon =
    tone === "loading" ? (
      <span data-slot="spinner" aria-hidden="true" />
    ) : tone === "error" ? (
      <ErrorCircleIcon size={size === "page" ? 20 : 16} aria-hidden="true" />
    ) : tone === "away" ? (
      <WarningIcon size={size === "page" ? 20 : 16} aria-hidden="true" />
    ) : null;
  return (
    <div
      data-slot="state"
      data-tone={tone}
      data-size={size}
      data-align={align}
      // A failure is said at once; loading and an away environment are said when the reader gets to them.
      role={tone === "error" ? "alert" : tone === "empty" ? undefined : "status"}
      aria-busy={tone === "loading" || undefined}
    >
      {icon}
      <p data-slot="state-title">{title}</p>
      {body !== undefined ? <p data-slot="state-body">{body}</p> : null}
      {reason !== undefined ? <code data-slot="reason">{reason}</code> : null}
      {action !== undefined || secondaryAction !== undefined ? (
        <div data-slot="state-actions">
          {action !== undefined ? (
            <Button data-variant="outline" onClick={action.onAction}>
              {action.label}
            </Button>
          ) : null}
          {secondaryAction !== undefined ? (
            <Button data-variant="ghost" onClick={secondaryAction.onAction}>
              {secondaryAction.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

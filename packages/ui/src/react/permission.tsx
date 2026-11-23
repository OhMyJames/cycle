import { Button } from "@ui-sdk/react/button";
import { type RefObject, useLayoutEffect, useMemo, useRef } from "react";
import type { PermissionRequest } from "../api.ts";
import { type Proposal, proposalOf } from "../model/index.ts";
import { composerInput } from "./composer.tsx";
import { useI18n } from "./i18n.tsx";
import { WarningIcon } from "./icons.tsx";
import { MOD } from "./sidebar.tsx";
import { DiffView } from "./tool.tsx";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The tool call a request carries: in `subject.toolCall` (ACP v2), or the subject itself in the older shape. */
const callOf = (subject: unknown): Record<string, unknown> => {
  const outer = isObject(subject) ? subject : {};
  return isObject(outer.toolCall) ? outer.toolCall : outer;
};

/** The most characters of an input shown; what is past them is counted. */
const MAX_INPUT = 4_000;

const inputText = (input: unknown): { text: string; hidden: number } => {
  let text: string;
  try {
    text = typeof input === "string" ? input : (JSON.stringify(input, null, 2) ?? "");
  } catch {
    text = String(input);
  }
  return text.length > MAX_INPUT
    ? { text: text.slice(0, MAX_INPUT), hidden: text.length - MAX_INPUT }
    : { text, hidden: 0 };
};

/** What a call was given, as text, and how much of it is not shown when it is long. */
function InputView({ input }: { input: unknown }) {
  const { t } = useI18n();
  const { text, hidden } = inputText(input);
  return (
    <>
      <pre data-slot="permission-detail">{text}</pre>
      {hidden > 0 ? (
        <p data-slot="permission-purpose">{t("permission.inputHidden", { count: hidden })}</p>
      ) : null}
    </>
  );
}

/**
 * What answering allows, shown whole before the answer: the change an edit makes, line by line; the command a shell call
 * runs, as it will run (what it is for is the agent's sentence, and is only beside it); else what the call was given.
 */
function ProposalView({ proposal, name }: { proposal: Proposal | undefined; name: string }) {
  const { t } = useI18n();
  if (proposal === undefined)
    return name !== "" ? <pre data-slot="permission-detail">{name}</pre> : null;
  if (proposal.kind === "command") {
    return (
      <>
        {proposal.description !== undefined ? (
          <p data-slot="permission-purpose">{proposal.description}</p>
        ) : null}
        <pre data-slot="permission-detail" data-kind="command">
          {proposal.command}
        </pre>
        {proposal.rest !== undefined ? <InputView input={proposal.rest} /> : null}
      </>
    );
  }
  if (proposal.kind === "input") {
    return <InputView input={proposal.input} />;
  }
  const label = t("tool.facts.diff", { added: proposal.additions, removed: proposal.deletions });
  return (
    <div data-slot="permission-change">
      <div data-slot="permission-file">
        <span data-slot="permission-path" title={proposal.path}>
          <bdi>{proposal.path}</bdi>
        </span>
        <span data-slot="tool-facts" title={label}>
          {proposal.additions > 0 ? (
            <span data-tone="add">{t("tool.facts.added", { count: proposal.additions })}</span>
          ) : null}
          {proposal.additions > 0 && proposal.deletions > 0 ? " " : null}
          {proposal.deletions > 0 ? (
            <span data-tone="del">{t("tool.facts.removed", { count: proposal.deletions })}</span>
          ) : null}
          <span data-slot="visually-hidden">{label}</span>
        </span>
      </div>
      {proposal.whole ? (
        <p data-slot="permission-purpose">
          {proposal.lines.length > 0 ? t("permission.wholeFile") : t("permission.emptyFile")}
        </p>
      ) : null}
      {proposal.everywhere ? (
        <p data-slot="permission-purpose">{t("permission.everywhere")}</p>
      ) : null}
      {proposal.lines.length > 0 ? <DiffView lines={proposal.lines} /> : null}
    </div>
  );
}

/**
 * Where the keyboard goes when a request's card leaves with the focus in it (answered, or closed by the agent): to the
 * card of the next request, a permission or a form, itself and not a button in it, so a second Enter allows nothing the
 * person has not read; when none is left, to the message box. The keyboard never falls to the page.
 */
export function useFocusHandoff(card: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = card.current;
    // Runs while the card is still on the page, so the focus can be seen inside it.
    return () => {
      if (element === null || !element.contains(element.ownerDocument.activeElement)) return;
      const page = element.ownerDocument;
      // After the commit that took the card away, when the next one, if any, is drawn.
      queueMicrotask(() => {
        const next = page.querySelector<HTMLElement>(
          '[data-slot="permissions"] [data-slot="permission"]',
        );
        if (next !== null) next.focus({ preventScroll: true });
        else composerInput()?.focus({ preventScroll: true });
      });
    };
  }, [card]);
}

export type PermissionCardProps = {
  request: PermissionRequest;
  disabled: boolean;
  onAnswer: (key: string, optionId: string | "cancelled") => void | Promise<void>;
  /** How many more requests wait behind this one. They are shown one at a time, in the order they came. */
  waiting?: number;
  /**
   * A sub-agent asks, not the main agent (docs/protocol.md §9): what it was sent to do, or `""` when that is not known.
   * Absent when the main agent asks.
   */
  asker?: string | undefined;
};

export function PermissionCard({
  request,
  disabled,
  onAnswer,
  waiting = 0,
  asker,
}: PermissionCardProps) {
  const { t } = useI18n();
  const card = useRef<HTMLElement>(null);
  const call = callOf(request.subject);
  const proposal = useMemo(() => proposalOf(call), [call]);
  const name =
    typeof call.title === "string" ? call.title : typeof call.name === "string" ? call.name : "";
  useFocusHandoff(card);
  return (
    <section ref={card} data-slot="permission" aria-label={request.title} tabIndex={-1}>
      <div data-slot="permission-title">
        <WarningIcon size={16} />
        {request.title}
        {waiting > 0 ? (
          <span data-slot="permission-waiting">{t("permission.waiting", { count: waiting })}</span>
        ) : null}
      </div>
      {/* Whose the ask is: the agent's words for the sub-agent are shown as text, never trusted. */}
      {asker !== undefined ? (
        <p data-slot="permission-asker">
          {asker !== ""
            ? t("permission.fromSubagent", { name: asker })
            : t("permission.fromAnySubagent")}
        </p>
      ) : null}
      <ProposalView proposal={proposal} name={name} />
      <div data-slot="permission-actions">
        {request.options.map((option) => {
          const allowOnce = option.kind === "allow_once";
          const label = allowOnce ? option.name : undefined;
          const tip = allowOnce ? `${option.name} (${MOD}↩)` : undefined;
          return (
            <Button
              key={option.optionId}
              // One main answer: allowing once. The rest are quieter, so that the strong one is not a default to click through.
              data-variant={allowOnce ? "solid" : "outline"}
              aria-label={label}
              title={tip}
              disabled={disabled}
              onClick={() => onAnswer(request.key, option.optionId)}
            >
              {option.name}
              {allowOnce ? <kbd>{MOD}↩</kbd> : null}
            </Button>
          );
        })}
        <Button
          data-variant="ghost"
          data-kind="permission-dismiss"
          disabled={disabled}
          onClick={() => onAnswer(request.key, "cancelled")}
        >
          {t("permission.dismiss")}
        </Button>
      </div>
    </section>
  );
}

import { Button } from "@ui-sdk/react/button";
import { useLayoutEffect, useMemo, useRef } from "react";
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

/** What the agent wants to do, as the request says it. Text only: it is the agent's word. */
export const describeSubject = (subject: unknown): string => {
  const call = callOf(subject);
  const input = isObject(call.rawInput) ? call.rawInput : {};
  const detail = ["command", "file_path", "path", "url", "pattern"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string");
  const name = typeof call.name === "string" ? call.name : "";
  return [name, detail].filter(Boolean).join(": ");
};

/** The most characters of an input shown; what is past them is counted. */
const MAX_INPUT = 4_000;

const inputText = (input: unknown): string => {
  let text: string;
  try {
    text = typeof input === "string" ? input : (JSON.stringify(input, null, 2) ?? "");
  } catch {
    text = String(input);
  }
  return text.length > MAX_INPUT ? `${text.slice(0, MAX_INPUT)}\n…` : text;
};

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
      </>
    );
  }
  if (proposal.kind === "input") {
    return <pre data-slot="permission-detail">{inputText(proposal.input)}</pre>;
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
      {proposal.whole ? <p data-slot="permission-purpose">{t("permission.wholeFile")}</p> : null}
      {proposal.lines.length > 0 ? <DiffView lines={proposal.lines} /> : null}
    </div>
  );
}

/**
 * Where the keyboard goes between requests. A request is answered from its card, the card goes, and the next request's
 * card comes in the same commit: it takes the focus the last one had. When none comes, the message box does, so the
 * keyboard never falls to the page.
 */
const handoff = { carry: false };

export type PermissionCardProps = {
  request: PermissionRequest;
  disabled: boolean;
  onAnswer: (key: string, optionId: string | "cancelled") => void | Promise<void>;
  /** How many more requests wait behind this one. They are shown one at a time, in the order they came. */
  waiting?: number;
};

export function PermissionCard({ request, disabled, onAnswer, waiting = 0 }: PermissionCardProps) {
  const { t } = useI18n();
  const card = useRef<HTMLElement>(null);
  const call = callOf(request.subject);
  const proposal = useMemo(() => proposalOf(call), [call]);
  const name = typeof call.name === "string" ? call.name : describeSubject(request.subject);
  useLayoutEffect(() => {
    const element = card.current;
    if (handoff.carry) {
      handoff.carry = false;
      element
        ?.querySelector<HTMLButtonElement>('[data-slot="permission-actions"] button')
        ?.focus({ preventScroll: true });
    }
    // Runs while the card is still on the page, so the focus can be seen inside it.
    return () => {
      if (element === null || !element.contains(element.ownerDocument.activeElement)) return;
      handoff.carry = true;
      queueMicrotask(() => {
        if (!handoff.carry) return;
        handoff.carry = false;
        composerInput()?.focus({ preventScroll: true });
      });
    };
  }, []);
  return (
    <section ref={card} data-slot="permission" aria-label={request.title}>
      <div data-slot="permission-title">
        <WarningIcon size={16} />
        {request.title}
        {waiting > 0 ? (
          <span data-slot="permission-waiting">{t("permission.waiting", { count: waiting })}</span>
        ) : null}
      </div>
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

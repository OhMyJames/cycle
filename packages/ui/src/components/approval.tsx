import type { Approval, ApprovalAnswer, FormField, Question } from "@cycle/protocol";
import { isComposing } from "@ui-sdk/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { host } from "../client/host.ts";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { plainCommand } from "../lib/activity.ts";
import { basename } from "../lib/format.ts";
import { modeLabel, modeNamed } from "../lib/modes.ts";
import { Markdown } from "./markdown.tsx";

function QuestionCard({
  questions,
  onAnswer,
}: {
  questions: Question[];
  onAnswer(answers: Record<string, string[]>): void;
}) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState("");
  const question = questions[step];
  if (!question) return null;
  const answer = (value: string) => {
    const next = { ...answers, [question.id]: [value] };
    setOther("");
    if (step + 1 < questions.length) {
      setAnswers(next);
      setStep(step + 1);
    } else {
      onAnswer(next);
    }
  };
  return (
    <div className="approval">
      <p className="approval-title">
        {question.header ? <span className="muted">{question.header}: </span> : null}
        <span className="label">{question.question}</span>
        {questions.length > 1 ? (
          <span className="muted caption">
            {" "}
            {step + 1} of {questions.length}
          </span>
        ) : null}
      </p>
      <div className="options">
        {question.options.map((option, index) => (
          <button
            key={option.label}
            type="button"
            className="option"
            autoFocus={index === 0}
            onClick={() => answer(option.label)}
          >
            <span>{option.label}</span>
            {option.description ? <span className="sub">{option.description}</span> : null}
          </button>
        ))}
      </div>
      {question.allowOther ? (
        <form
          className="row approval-other"
          onSubmit={(event) => {
            event.preventDefault();
            if (other.trim()) answer(other.trim());
          }}
        >
          <input
            className="field small"
            type={question.secret ? "password" : "text"}
            placeholder="Something else…"
            aria-label="Another answer"
            value={other}
            autoFocus={question.options.length === 0}
            onChange={(event) => setOther(event.currentTarget.value)}
          />
          <button type="submit" className="button" disabled={!other.trim()}>
            Answer
          </button>
        </form>
      ) : null}
    </div>
  );
}

type Request = Extract<Approval, { kind: "command" | "fileChange" | "permissions" | "tool" }>;

function titleOf(approval: Request): string {
  switch (approval.kind) {
    case "command":
      return "Run this command?";
    case "fileChange":
      return "Apply these file changes?";
    case "permissions":
      return "Grant these permissions?";
    case "tool":
      return (
        approval.title ?? `Use ${approval.server ? `${approval.server}.` : ""}${approval.tool}?`
      );
  }
}

/** What the card's keys do: ⌘↵ for its first answer, ⌘. for its refusal. */
interface Keys {
  accept(): void;
  decline(): void;
}

/**
 * Answers the card in view by ⌘↵ and ⌘. The card never takes the focus, so the keys need a
 * modifier, and they leave ⌘↵ to the composer while it holds text to steer with.
 */
function useCardKeys(on: boolean, keys: Keys): void {
  const current = useRef(keys);
  current.current = keys;
  useEffect(() => {
    if (!on) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key !== "Enter" && event.key !== ".") return;
      if (document.querySelector(".scrim, .menu")) return;
      // Only from nowhere, the composer or the card itself: the same keys pressed in the terminal,
      // a panel's field or another session's popover are that surface's own.
      const at = document.activeElement;
      const here =
        at === null || at === document.body || at.closest(".composer, .thread-scroll") !== null;
      if (!here) return;
      const typed = document.querySelector<HTMLTextAreaElement>(".composer textarea")?.value;
      if (event.key === "Enter" && typed?.trim()) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter") current.current.accept();
      else current.current.decline();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [on]);
}

function KeyHint({ accept, decline }: { accept: string; decline: string }) {
  return (
    <span className="approval-keys caption">
      <kbd>⌘ ↵</kbd> {accept} · <kbd>⌘ .</kbd> {decline}
    </span>
  );
}

/** A line the agent is told: what to do instead, or what to change. Enter sends it. */
function NoteField({
  label,
  action,
  onSend,
}: {
  label: string;
  action: string;
  onSend(note: string): void;
}) {
  const [note, setNote] = useState("");
  return (
    <form
      className="row approval-other"
      onSubmit={(event) => {
        event.preventDefault();
        if (note.trim()) onSend(note.trim());
      }}
    >
      <input
        className="field small"
        placeholder={label}
        aria-label={label}
        value={note}
        onChange={(event) => setNote(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && isComposing(event.nativeEvent)) event.preventDefault();
        }}
      />
      <button type="submit" className="button" disabled={!note.trim()}>
        {action}
      </button>
    </form>
  );
}

function Card({
  title,
  waiting,
  children,
}: {
  title: string;
  waiting: number;
  children: ReactNode;
}) {
  return (
    <div className="approval" role="alertdialog" aria-label={title}>
      <p className="approval-title">
        <span className="label">{title}</span>
        {waiting > 0 ? <span className="muted caption"> {waiting} more waiting</span> : null}
      </p>
      {children}
    </div>
  );
}

/**
 * A request to run something: a command, an edit, a tool, or more reach. Allowing comes first and is
 * the primary button; refusing comes last. The owner may change what runs where the agent takes
 * that, keep a rule it offers for the rest of the session, and say why they refuse.
 */
function RequestCard({
  approval,
  waiting,
  keys,
  answer,
}: {
  approval: Request;
  waiting: number;
  keys: boolean;
  answer(response: ApprovalAnswer): void;
}) {
  const original =
    approval.kind === "command"
      ? (approval.command ?? "")
      : approval.kind === "tool"
        ? approval.input
        : "";
  const editable = approval.kind === "tool" || (approval.kind === "command" && approval.editable);
  const rules = approval.kind === "permissions" ? [] : (approval.rules ?? []);
  const notes = approval.kind === "tool" || (approval.kind !== "permissions" && approval.notes);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(original);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [noting, setNoting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const accept = () => {
    const changed = editing && edited !== original;
    if (changed && approval.kind === "tool") {
      try {
        const parsed: unknown = JSON.parse(edited);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error();
      } catch {
        setProblem("The input must be a JSON object.");
        return;
      }
    }
    answer({
      decision: "accept",
      ...(changed ? { edited } : {}),
      ...(kept.size ? { rules: [...kept] } : {}),
    });
  };
  const decline = () => answer({ decision: "decline" });
  useCardKeys(keys, { accept, decline });
  return (
    <Card title={titleOf(approval)} waiting={waiting}>
      {approval.reason ? <p className="approval-reason">{approval.reason}</p> : null}
      {editing ? (
        <textarea
          className="field approval-edit"
          aria-label={approval.kind === "command" ? "The command" : "The tool's input"}
          rows={Math.min(12, Math.max(2, edited.split("\n").length))}
          value={edited}
          spellCheck={false}
          onChange={(event) => {
            setEdited(event.currentTarget.value);
            setProblem(null);
          }}
        />
      ) : approval.kind === "command" && approval.command ? (
        <pre className="approval-command no-scrollbar">
          {approval.cwd ? <span className="muted">{basename(approval.cwd)} $ </span> : null}
          {plainCommand(approval.command)}
        </pre>
      ) : approval.kind === "tool" ? (
        <pre className="approval-command no-scrollbar">{approval.input}</pre>
      ) : approval.kind === "permissions" ? (
        <pre className="approval-command no-scrollbar">{approval.summary}</pre>
      ) : null}
      {problem ? <p className="approval-problem caption">{problem}</p> : null}
      {rules.length ? (
        <fieldset className="approval-rules">
          <legend className="caption">Also allow for the rest of this session</legend>
          {rules.map((rule) => (
            <label key={rule.id} className="row check">
              <input
                type="checkbox"
                checked={kept.has(rule.id)}
                onChange={(event) => {
                  const next = new Set(kept);
                  if (event.currentTarget.checked) next.add(rule.id);
                  else next.delete(rule.id);
                  setKept(next);
                }}
              />
              <code>{rule.label}</code>
            </label>
          ))}
        </fieldset>
      ) : null}
      {noting ? (
        <NoteField
          label="Why, or what to do instead"
          action="Deny"
          onSend={(message) => answer({ decision: "decline", message })}
        />
      ) : null}
      <div className="approval-actions">
        <button type="button" className="button primary" onClick={accept}>
          {kept.size ? "Allow" : "Allow once"}
        </button>
        {rules.length ? null : (
          <button
            type="button"
            className="button"
            onClick={() => answer({ decision: "acceptForSession" })}
          >
            Allow for this session
          </button>
        )}
        {editable && !editing ? (
          <button type="button" className="ghost" onClick={() => setEditing(true)}>
            Edit
          </button>
        ) : null}
        <button type="button" className="button" data-refuses onClick={decline}>
          Deny
        </button>
        {notes && !noting ? (
          <button type="button" className="ghost" onClick={() => setNoting(true)}>
            Say why
          </button>
        ) : null}
        {keys ? <KeyHint accept="allows once" decline="denies" /> : null}
      </div>
    </Card>
  );
}

/**
 * The agent's plan, waiting to be approved. Approved, it goes on in the mode the owner picks; else
 * it plans again, with what they said.
 */
function PlanCard({
  sessionId,
  approval,
  waiting,
  keys,
  answer,
}: {
  sessionId: string;
  approval: Extract<Approval, { kind: "plan" }>;
  waiting: number;
  keys: boolean;
  answer(response: ApprovalAnswer): void;
}) {
  const app = useApp();
  const harness = useStore(app.sessions, (sessions) => sessions.byId[sessionId]?.harness ?? "");
  const all = useStore(app.modes, (modes) => modes);
  const offered = approval.modes.flatMap((id) => modeNamed(all, harness, id) ?? []);
  const [mode, setMode] = useState(
    () => offered.find((each) => each.isDefault)?.id ?? approval.modes[0] ?? "",
  );
  const accept = () => answer({ decision: "accept", ...(mode ? { mode } : {}) });
  const decline = () => answer({ decision: "decline" });
  useCardKeys(keys, { accept, decline });
  return (
    <Card title="Approve this plan?" waiting={waiting}>
      <div className="approval-plan fade-y">
        {approval.plan ? (
          <Markdown text={approval.plan} />
        ) : (
          <p className="muted">The agent did not say what the plan is.</p>
        )}
      </div>
      <NoteField
        label="What to change in the plan"
        action="Keep planning"
        onSend={(message) => answer({ decision: "decline", message })}
      />
      <div className="approval-actions">
        <button type="button" className="button primary" onClick={accept}>
          Approve
        </button>
        {offered.length > 1 ? (
          <label className="row approval-then">
            <span className="caption">then</span>
            <select
              className="field small"
              aria-label="The mode to work in"
              value={mode}
              onChange={(event) => setMode(event.currentTarget.value)}
            >
              {offered.map((each) => (
                <option key={each.id} value={each.id}>
                  {modeLabel(each)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button type="button" className="button" data-refuses onClick={decline}>
          Keep planning
        </button>
        {keys ? <KeyHint accept="approves" decline="keeps planning" /> : null}
      </div>
    </Card>
  );
}

/** A form field's value as the server's schema wants it, or a problem with it. */
function fieldValue(field: FormField, raw: string | boolean | undefined): unknown {
  if (field.type === "boolean") return raw === true;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return undefined;
  if (field.type === "string") return text;
  const number = Number(text);
  if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) {
    throw new Error(
      `${field.title} must be ${field.type === "integer" ? "a whole number" : "a number"}.`,
    );
  }
  return number;
}

/** What the owner filled in, as the server takes it. Throws with what is missing or wrong. */
function formContent(
  fields: FormField[] | null,
  values: Record<string, string | boolean>,
  json: string,
): Record<string, unknown> {
  if (fields === null) {
    const parsed: unknown = JSON.parse(json || "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The answer must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const value = fieldValue(field, values[field.name]);
    if (value === undefined) {
      if (field.required) throw new Error(`${field.title} is needed.`);
      continue;
    }
    content[field.name] = value;
  }
  return content;
}

/** An MCP server asks for something: a form to fill, or a page to visit and finish there. */
function ElicitationCard({
  approval,
  waiting,
  answer,
}: {
  approval: Extract<Approval, { kind: "elicitation" }>;
  waiting: number;
  answer(response: ApprovalAnswer): void;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [json, setJson] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => {
    try {
      answer({ decision: "accept", content: formContent(approval.fields, values, json) });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The answer must be a JSON object.");
    }
  };
  const set = (name: string, value: string | boolean) => {
    setValues((old) => ({ ...old, [name]: value }));
    setProblem(null);
  };
  return (
    <Card title={`${approval.server} asks for something`} waiting={waiting}>
      {approval.message ? <p className="approval-reason">{approval.message}</p> : null}
      {approval.url ? (
        <>
          <pre className="approval-command no-scrollbar">{approval.url}</pre>
          <div className="approval-actions">
            {/* The address is the server's: only a web page is opened. */}
            <button
              type="button"
              className="button"
              disabled={!/^https?:\/\//i.test(approval.url)}
              onClick={() => approval.url && host.openExternal(approval.url)}
            >
              Open the page
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => answer({ decision: "accept" })}
            >
              Done
            </button>
            <button
              type="button"
              className="button"
              data-refuses
              onClick={() => answer({ decision: "decline" })}
            >
              Decline
            </button>
          </div>
        </>
      ) : (
        <form
          className="approval-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {approval.fields === null ? (
            <label className="form-field">
              <span className="form-label">The answer, as JSON</span>
              <textarea
                className="field approval-edit"
                rows={4}
                spellCheck={false}
                value={json}
                onChange={(event) => {
                  setJson(event.currentTarget.value);
                  setProblem(null);
                }}
              />
              {approval.schema ? (
                <pre className="approval-command no-scrollbar">{approval.schema}</pre>
              ) : null}
            </label>
          ) : (
            approval.fields.map((field) =>
              field.type === "boolean" ? (
                <label key={field.name} className="row check">
                  <input
                    type="checkbox"
                    checked={values[field.name] === true}
                    onChange={(event) => set(field.name, event.currentTarget.checked)}
                  />
                  {field.title}
                </label>
              ) : (
                <label key={field.name} className="form-field">
                  <span className="form-label">
                    {field.title}
                    {field.required ? "" : " (optional)"}
                  </span>
                  {field.options ? (
                    <select
                      className="field small"
                      value={String(values[field.name] ?? "")}
                      onChange={(event) => set(field.name, event.currentTarget.value)}
                    >
                      <option value="">Choose…</option>
                      {field.options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="field small"
                      inputMode={field.type === "string" ? "text" : "decimal"}
                      value={String(values[field.name] ?? "")}
                      onChange={(event) => set(field.name, event.currentTarget.value)}
                    />
                  )}
                  {field.description ? (
                    <span className="caption muted">{field.description}</span>
                  ) : null}
                </label>
              ),
            )
          )}
          {problem ? <p className="approval-problem caption">{problem}</p> : null}
          <div className="approval-actions">
            <button type="submit" className="button primary">
              Send
            </button>
            <button
              type="button"
              className="button"
              data-refuses
              onClick={() => answer({ decision: "decline" })}
            >
              Decline
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

/**
 * What a turn is waiting on the owner for: one request at a time, where the status would be, so work
 * folded away in a card cannot hide it. The card never takes the focus: an Enter meant for something
 * else must not allow a command.
 */
export function ApprovalCard({
  sessionId,
  approval,
  waiting = 0,
  keys = false,
}: {
  sessionId: string;
  approval: Approval;
  /** How many more requests wait behind this one. */
  waiting?: number;
  /** Whether ⌘↵ and ⌘. answer it: only for the card of the conversation in view. */
  keys?: boolean;
}) {
  const app = useApp();
  const answer = (response: ApprovalAnswer) => app.respond(sessionId, approval.id, response);
  switch (approval.kind) {
    case "question":
      return (
        <QuestionCard
          questions={approval.questions}
          onAnswer={(answers) => app.respond(sessionId, approval.id, { answers })}
        />
      );
    case "plan":
      return (
        <PlanCard
          key={approval.id}
          sessionId={sessionId}
          approval={approval}
          waiting={waiting}
          keys={keys}
          answer={answer}
        />
      );
    case "elicitation":
      return (
        <ElicitationCard key={approval.id} approval={approval} waiting={waiting} answer={answer} />
      );
    default:
      return (
        <RequestCard
          key={approval.id}
          approval={approval}
          waiting={waiting}
          keys={keys}
          answer={answer}
        />
      );
  }
}

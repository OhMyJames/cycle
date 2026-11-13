import type { Approval, ApprovalDecision, Question } from "@cycle/protocol";
import { useState } from "react";
import { useApp } from "../context.ts";
import { basename } from "../lib/format.ts";
import { plainCommand } from "../lib/activity.ts";

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

const TITLES: Record<Exclude<Approval["kind"], "question">, string> = {
  command: "Run this command?",
  fileChange: "Apply these file changes?",
  permissions: "Grant these permissions?",
};

/**
 * What a turn is waiting on the owner for: one request at a time, where the status would be, so work
 * folded away in a card cannot hide it. Allowing comes first and is the primary button, which takes
 * the focus; refusing comes last.
 */
export function ApprovalCard({
  sessionId,
  approval,
  waiting = 0,
}: {
  sessionId: string;
  approval: Approval;
  /** How many more requests wait behind this one. */
  waiting?: number;
}) {
  const app = useApp();
  if (approval.kind === "question") {
    return (
      <QuestionCard
        questions={approval.questions}
        onAnswer={(answers) => app.respond(sessionId, approval.id, { answers })}
      />
    );
  }
  const decide = (decision: ApprovalDecision) => app.respond(sessionId, approval.id, { decision });
  return (
    <div className="approval" role="alertdialog" aria-label={TITLES[approval.kind]}>
      <p className="approval-title">
        <span className="label">{TITLES[approval.kind]}</span>
        {waiting > 0 ? <span className="muted caption"> {waiting} more waiting</span> : null}
      </p>
      {approval.reason ? <p className="approval-reason">{approval.reason}</p> : null}
      {approval.kind === "command" && approval.command ? (
        <pre className="approval-command no-scrollbar">
          {approval.cwd ? <span className="muted">{basename(approval.cwd)} $ </span> : null}
          {plainCommand(approval.command)}
        </pre>
      ) : null}
      {approval.kind === "permissions" ? (
        <pre className="approval-command no-scrollbar">{approval.summary}</pre>
      ) : null}
      <div className="approval-actions">
        <button type="button" className="button primary" autoFocus onClick={() => decide("accept")}>
          Allow once
        </button>
        <button type="button" className="button" onClick={() => decide("acceptForSession")}>
          Allow for this session
        </button>
        <button type="button" className="button" onClick={() => decide("decline")}>
          Deny
        </button>
      </div>
    </div>
  );
}

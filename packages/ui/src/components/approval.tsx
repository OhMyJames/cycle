import type { Approval, ApprovalDecision, Question } from "@cycle/protocol";
import { useState } from "react";
import { useApp } from "../context.ts";
import { Icon } from "./icons.tsx";
import { plainCommand } from "./items.tsx";

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
      <div className="card-title">
        <Icon name="message" /> {question.header || "Question"}
        {questions.length > 1 ? (
          <span className="muted caption">
            {step + 1} of {questions.length}
          </span>
        ) : null}
      </div>
      <p>{question.question}</p>
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
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            if (other.trim()) answer(other.trim());
          }}
        >
          <input
            className="field"
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

const TITLES: Record<Approval["kind"], string> = {
  command: "Run this command?",
  fileChange: "Apply these file changes?",
  permissions: "Grant these permissions?",
  question: "Question",
};

/** What a turn is waiting on the owner for. The first button takes the focus. */
export function ApprovalCard({ sessionId, approval }: { sessionId: string; approval: Approval }) {
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
      <div className="card-title">
        <Icon name="alert" className="tone-warning" /> {TITLES[approval.kind]}
      </div>
      {approval.reason ? <p className="meta">{approval.reason}</p> : null}
      {approval.kind === "command" && approval.command ? (
        <pre className="approval-command">
          <span className="prompt">$ </span>
          {plainCommand(approval.command)}
        </pre>
      ) : null}
      {approval.kind === "command" && approval.cwd ? (
        <div className="caption muted">in {approval.cwd}</div>
      ) : null}
      {approval.kind === "permissions" ? (
        <pre className="approval-command">{approval.summary}</pre>
      ) : null}
      <div className="row approval-actions">
        <button type="button" className="button primary" autoFocus onClick={() => decide("accept")}>
          Allow once
        </button>
        <button type="button" className="button" onClick={() => decide("acceptForSession")}>
          Allow for this session
        </button>
        <span className="grow" />
        <button type="button" className="button" onClick={() => decide("decline")}>
          Deny
        </button>
      </div>
    </div>
  );
}

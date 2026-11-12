import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Approval, ApprovalDecision, Item } from "@cycle/protocol";
import { useSession } from "./use-session.ts";

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "userMessage":
      return <div className="item user">{item.text}</div>;
    case "agentMessage":
      return <div className="item agent">{item.text}</div>;
    case "reasoning":
      return item.text ? <div className="item reasoning">{item.text}</div> : null;
    case "command":
      return (
        <div className="item tool" data-status={item.status}>
          <div className="tool-head">
            <code>$ {item.command}</code>
            <span className="badge">
              {item.status === "running" ? "running" : item.exitCode === null ? item.status : `exit ${item.exitCode}`}
            </span>
          </div>
          {item.output && <pre>{item.output}</pre>}
        </div>
      );
    case "fileChange":
      return (
        <div className="item tool" data-status={item.status}>
          {item.changes.map((change) => (
            <details key={change.path}>
              <summary>
                <code>{change.path}</code>
                <span className="badge">{change.change}</span>
              </summary>
              <pre>{change.diff}</pre>
            </details>
          ))}
        </div>
      );
    case "other":
      return <div className="item other">{item.type}</div>;
  }
}

function ApprovalView({
  approval,
  onDecide,
}: {
  approval: Approval;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  return (
    <div className="approval" role="alertdialog" aria-label="Approval required">
      <div className="approval-title">
        {approval.kind === "command" ? "Run this command?" : "Apply these file changes?"}
      </div>
      {approval.command && <code>$ {approval.command}</code>}
      {approval.reason && <p>{approval.reason}</p>}
      <div className="approval-actions">
        <button className="primary" onClick={() => onDecide("accept")}>
          Allow
        </button>
        <button onClick={() => onDecide("acceptForSession")}>Allow for session</button>
        <button onClick={() => onDecide("decline")}>Deny</button>
      </div>
    </div>
  );
}

export function App({ daemonUrl }: { daemonUrl: string }) {
  const { connection, session, error, send, interrupt, respondApproval } = useSession(daemonUrl);
  const [draft, setDraft] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const busy = Boolean(session?.activeTurnId);
  const ready = connection === "open" && session !== null;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [session?.items, session?.approvals]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || !ready || busy) return;
    send(text);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const failure = error ?? (session?.lastTurn?.status === "failed" ? (session.lastTurn.error ?? "Turn failed") : null);

  return (
    <div className="app">
      <header>
        <strong>Cycle</strong>
        {session && (
          <span className="meta">
            {session.info.harness} · {session.info.model} · {session.info.cwd}
          </span>
        )}
        <span className="status" data-status={connection}>
          {connection === "open" ? "connected" : connection === "connecting" ? "connecting…" : "disconnected"}
        </span>
      </header>

      <main>
        {session?.items.length === 0 && <div className="empty">Ask the agent to do something in this directory.</div>}
        {session?.items.map((item) => <ItemView key={item.id} item={item} />)}
        {session?.approvals.map((approval) => (
          <ApprovalView
            key={approval.id}
            approval={approval}
            onDecide={(decision) => respondApproval(approval.id, decision)}
          />
        ))}
        {busy && session?.approvals.length === 0 && <div className="working">Working…</div>}
        {session?.lastTurn?.status === "interrupted" && <div className="notice">Interrupted</div>}
        {failure && <div className="notice error">{failure}</div>}
        <div ref={bottom} />
      </main>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={ready ? "Message the agent…" : "Waiting for daemon…"}
          rows={2}
          autoFocus
        />
        {busy ? (
          <button type="button" onClick={interrupt}>
            Stop
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!ready || !draft.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}

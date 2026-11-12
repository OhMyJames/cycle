import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ApprovalDecision,
  type SessionState,
  initialSessionState,
  reduceSession,
} from "@cycle/protocol";
import { CycleClient, type ConnectionStatus } from "./client.ts";

export interface SessionController {
  connection: ConnectionStatus;
  session: SessionState | null;
  /** Failure of a client->daemon call (as opposed to a failed turn). */
  error: string | null;
  send(text: string): void;
  interrupt(): void;
  respondApproval(approvalId: string, decision: ApprovalDecision): void;
}

/** Connects to a daemon, opens one session, and keeps its state live. */
export function useSession(daemonUrl: string): SessionController {
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [session, setSession] = useState<SessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<CycleClient | null>(null);

  useEffect(() => {
    const client = new CycleClient(daemonUrl);
    let sessionId: string | null = null;
    setClient(client);
    setConnection(client.status);
    setSession(null);
    setError(null);
    const offStatus = client.onStatus(setConnection);
    const offEvent = client.onEvent((event) => {
      if (event.sessionId !== sessionId) return;
      setSession((state) => state && reduceSession(state, event));
    });
    client
      .call("session.create", {})
      .then((info) => {
        sessionId = info.id;
        setSession(initialSessionState(info));
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      offStatus();
      offEvent();
      client.close();
    };
  }, [daemonUrl]);

  const sessionId = session?.info.id;
  const report = useCallback((e: Error) => setError(e.message), []);

  return useMemo(
    () => ({
      connection,
      session,
      error,
      send(text) {
        if (!client || !sessionId) return;
        setError(null);
        client.call("session.send", { sessionId, text }).catch(report);
      },
      interrupt() {
        if (!client || !sessionId) return;
        client.call("session.interrupt", { sessionId }).catch(report);
      },
      respondApproval(approvalId, decision) {
        client?.call("approval.respond", { approvalId, decision }).catch(report);
      },
    }),
    [client, connection, session, sessionId, error, report],
  );
}

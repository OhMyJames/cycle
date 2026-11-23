import { useMemo } from "react";
import type { SessionSummary } from "../api.ts";
import { agentLabel } from "../sessions.ts";
import { AgentLogo } from "./agent-logos.tsx";
import { useAppState } from "./store-context.tsx";

/**
 * Which agent a session is of, as its logo before the title: only where it tells sessions apart (`agentLabel`), so an
 * environment with one agent shows none.
 */
export function SessionAgent({
  session,
  quiet = false,
}: {
  session: SessionSummary;
  quiet?: boolean;
}) {
  // The list is read as it is held (the same one until the agents are read again), and the name worked out from it
  // only when it or the session changes: a row is drawn for every session, on every change of anything.
  const agents = useAppState((s) => s.agents[session.environmentId]);
  const label = useMemo(() => agentLabel(agents, session.agent), [agents, session.agent]);
  return label === undefined ? null : (
    <AgentLogo agentId={session.agent} name={label} quiet={quiet} />
  );
}

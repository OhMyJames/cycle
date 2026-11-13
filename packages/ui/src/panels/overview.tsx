import type { SessionInfo } from "@cycle/protocol";
import { useEffect, useState } from "react";
import { PanelHeader } from "../components/panel.tsx";
import { PlanSteps } from "../components/plan.tsx";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { compactNumber, tailPath, tildePath } from "../lib/format.ts";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overview-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="fact">
      <span className="muted">{label}</span>
      <span className="fade-x">{children}</span>
    </div>
  );
}

/** The session at a glance: where it works, its context, its plan, the agent's tools. */
export function OverviewPanel({ info }: { info: SessionInfo }) {
  const app = useApp();
  const home = useStore(app.daemon, (daemon) => daemon?.userHome);
  const { plan, usage, turns, running } = useStore(app.conversation(info.id), (conversation) => ({
    running: conversation.state?.turns.at(-1)?.status === "running",
    plan: conversation.state?.plan ?? null,
    usage: conversation.state?.usage ?? null,
    turns: conversation.state?.turns.length ?? 0,
  }));
  const [servers, setServers] = useState<
    { name: string; status: string; tools: { name: string }[] }[] | null
  >(null);
  useEffect(() => {
    let current = true;
    app.request("mcp.list", {}).then(
      (answer) => current && setServers(answer.servers),
      () => current && setServers([]),
    );
    return () => {
      current = false;
    };
  }, [app]);
  const window = usage?.contextWindow ?? null;
  const used = usage && window ? Math.min(1, usage.last.total / window) : null;
  return (
    <>
      <PanelHeader title="Overview" />
      <div className="panel-body overview fade-y">
        <Section title="Environment">
          <Fact label="Folder">
            <span title={info.cwd}>{tailPath(tildePath(info.cwd, home))}</span>
          </Fact>
          {info.branch ? <Fact label="Branch">{info.branch}</Fact> : null}
          {info.worktree ? (
            <Fact label="Worktree of">{tailPath(tildePath(info.worktree.repo, home))}</Fact>
          ) : null}
          <Fact label="Model">
            {info.model}
            {info.effort ? ` · ${info.effort}` : ""}
          </Fact>
          <Fact label="Turns">{turns}</Fact>
        </Section>
        <Section title="Context">
          {usage ? (
            <>
              {used !== null && window ? (
                <>
                  <div className="meter" data-high={used > 0.8}>
                    <span style={{ width: `${used * 100}%` }} />
                  </div>
                  <div className="caption muted tabular">
                    {compactNumber(usage.last.total)} of {compactNumber(window)} tokens (
                    {Math.round(used * 100)}%)
                  </div>
                </>
              ) : null}
              <Fact label="Input">{usage.total.input.toLocaleString()}</Fact>
              <Fact label="Cached input">{usage.total.cachedInput.toLocaleString()}</Fact>
              <Fact label="Output">{usage.total.output.toLocaleString()}</Fact>
              <Fact label="Reasoning">{usage.total.reasoning.toLocaleString()}</Fact>
              <button
                type="button"
                className="button"
                onClick={() =>
                  void app.attempt(app.request("session.compact", { sessionId: info.id }))
                }
              >
                Compact now
              </button>
            </>
          ) : (
            <div className="note">Known after the next turn.</div>
          )}
        </Section>
        {plan ? (
          <Section title="Plan">
            <PlanSteps plan={plan} live={running} />
          </Section>
        ) : null}
        <Section title="MCP servers">
          {servers === null ? (
            <div className="note">Reading…</div>
          ) : servers.length === 0 ? (
            <div className="note">None configured for codex.</div>
          ) : (
            servers.map((server) => (
              <Fact key={server.name} label={server.name}>
                {server.status === "connected"
                  ? `${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`
                  : server.status}
              </Fact>
            ))
          )}
        </Section>
      </div>
    </>
  );
}

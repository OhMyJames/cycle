import type { Session } from "@cycle/protocol";
import { useEffect, useState } from "react";
import { PanelHeader } from "../components/panel.tsx";
import { PlanSteps } from "../components/plan.tsx";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { environmentLabel } from "../lib/environment.ts";
import { compactNumber } from "../lib/format.ts";
import { modeNamed } from "../lib/modes.ts";
import { worktreeFacts } from "../lib/worktrees.ts";

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
export function OverviewPanel({ info }: { info: Session }) {
  const app = useApp();
  const home = useStore(app.daemon, (daemon) => daemon?.userHome);
  // No row until the owner's environments are known: an unlisted id may only be one not yet listed.
  const environment = useStore(app.sandboxes, (value) =>
    environmentLabel(value.environments, info.environment, value.loaded),
  );
  const where = worktreeFacts(info, home);
  const mode = useStore(app.modes, (modes) => modeNamed(modes, info.harness, info.mode));
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
            <button
              type="button"
              className="fact-link"
              title={`${where.folder.full}\nShow its files`}
              onClick={() => app.setView({ panel: "files", file: null })}
            >
              {where.folder.text}
            </button>
          </Fact>
          {info.branch ? <Fact label="Branch">{info.branch}</Fact> : null}
          {environment ? <Fact label="Environment">{environment}</Fact> : null}
          {where.worktree ? (
            <>
              <Fact label="Worktree">
                <span title={where.worktree.full}>{where.worktree.text}</span>
              </Fact>
              {where.worktree.note ? (
                <div className="caption muted fact-note">{where.worktree.note}</div>
              ) : null}
            </>
          ) : null}
          {where.repository ? (
            <Fact label="Repository">
              <span title={where.repository.full}>{where.repository.text}</span>
            </Fact>
          ) : null}
          {where.worktree ? (
            <button
              type="button"
              className="button small"
              onClick={() => app.setView({ page: "settings", settingsSection: "worktrees" })}
            >
              Worktrees…
            </button>
          ) : null}
          <Fact label="Model">
            {info.model}
            {info.effort ? ` · ${info.effort}` : ""}
          </Fact>
          <Fact label="Mode">{mode?.name ?? info.mode}</Fact>
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
              <button
                type="button"
                className="button small"
                disabled={running}
                title="Sums the conversation up to free the context"
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
        {usage ? (
          <Section title="Used by this session">
            <Fact label="Input">{usage.total.input.toLocaleString()}</Fact>
            <Fact label="Cached input">{usage.total.cachedInput.toLocaleString()}</Fact>
            <Fact label="Output">{usage.total.output.toLocaleString()}</Fact>
            <Fact label="Reasoning">{usage.total.reasoning.toLocaleString()}</Fact>
          </Section>
        ) : null}
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
              <button
                key={server.name}
                type="button"
                className="fact fact-row"
                title="Open the Connector"
                onClick={() => app.setView({ page: "connector" })}
              >
                <span className="server-name">
                  <span className="server-dot" data-status={server.status} />
                  {server.name}
                </span>
                <span className="muted">
                  {server.status === "connected"
                    ? `${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`
                    : server.status}
                </span>
              </button>
            ))
          )}
        </Section>
      </div>
    </>
  );
}

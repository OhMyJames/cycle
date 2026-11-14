import type { McpServerInfo } from "@cycle/protocol";
import { useState } from "react";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { type ServerDraft, serverDraft, serverInput, serverProblem } from "../lib/server-form.ts";
import { FormField, Segmented, useRowKeys } from "./controls.tsx";
import { Icon } from "./icons.tsx";

/** The page that adds an MCP server or changes one. A server keeps its name once made. */
export function ServerEditor({ server, onDone }: { server: McpServerInfo | null; onDone(): void }) {
  const app = useApp();
  const others = useStore(app.mcp, (servers) =>
    (servers ?? []).map((each) => each.name).filter((name) => name !== server?.name),
  );
  const [draft, setDraft] = useState<ServerDraft>(() => serverDraft(server));
  const [saving, setSaving] = useState(false);
  const rows = useRowKeys(draft.env.length);
  const set = (patch: Partial<ServerDraft>) => setDraft((old) => ({ ...old, ...patch }));
  const problem = serverProblem(draft, others);
  const save = () => {
    if (problem || saving) return;
    setSaving(true);
    void app
      .putMcpServer(serverInput(draft))
      .then((done) => done && onDone())
      .finally(() => setSaving(false));
  };
  return (
    <div className="page fade-y">
      <form
        className="page-content"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <header className="page-header">
          <button type="button" className="ghost page-back" onClick={onDone}>
            <Icon name="chevron-left" />
            Connector
          </button>
          <h1>{server ? server.name : "Add an MCP server"}</h1>
        </header>
        <div className="form">
          {server ? null : (
            <FormField label="Name" help="Tools appear under it. It cannot be changed later.">
              <input
                className="field mono"
                value={draft.name}
                autoFocus
                spellCheck={false}
                placeholder="docs"
                onChange={(event) => set({ name: event.currentTarget.value })}
              />
            </FormField>
          )}
          <div className="form-field">
            <span className="form-label">Reached by</span>
            <Segmented<ServerDraft["kind"]>
              label="Reached by"
              value={draft.kind}
              onChange={(kind) => set({ kind })}
              options={[
                { value: "stdio", label: "A command" },
                { value: "http", label: "An address" },
              ]}
            />
          </div>
          {draft.kind === "stdio" ? (
            <>
              <FormField label="Command" help="Started on the agent's machine, once per session.">
                <input
                  className="field mono"
                  value={draft.command}
                  spellCheck={false}
                  placeholder="npx -y @example/mcp-server"
                  onChange={(event) => set({ command: event.currentTarget.value })}
                />
              </FormField>
              <div className="form-field">
                <span className="form-label">Environment</span>
                {draft.env.map((row, index) => (
                  <div key={rows.keys[index]} className="pair-row">
                    <input
                      className="field mono"
                      value={row.name}
                      spellCheck={false}
                      placeholder="NAME"
                      aria-label={`Variable ${index + 1} name`}
                      readOnly={row.kept}
                      onChange={(event) =>
                        set({
                          env: draft.env.with(index, { ...row, name: event.currentTarget.value }),
                        })
                      }
                    />
                    <input
                      className="field mono"
                      type="password"
                      autoComplete="off"
                      value={row.value}
                      placeholder={row.kept ? "Kept as it is" : "value"}
                      aria-label={`Variable ${index + 1} value`}
                      onChange={(event) =>
                        set({
                          env: draft.env.with(index, { ...row, value: event.currentTarget.value }),
                        })
                      }
                    />
                    <button
                      type="button"
                      className="icon-button"
                      title={`Remove variable ${index + 1}`}
                      aria-label={`Remove variable ${index + 1}`}
                      onClick={() => {
                        rows.remove(index);
                        set({ env: draft.env.toSpliced(index, 1) });
                      }}
                    >
                      <Icon name="x" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="ghost add-row"
                  onClick={() => set({ env: [...draft.env, { name: "", value: "", kept: false }] })}
                >
                  <Icon name="plus" />
                  Add variable
                </button>
                <span className="caption muted">
                  Values stay in codex's settings on the agent's machine. Cycle shows their names
                  only.
                </span>
              </div>
            </>
          ) : (
            <>
              <FormField label="Address" help="A streamable HTTP server. Sign in after saving it.">
                <input
                  className="field mono"
                  value={draft.url}
                  spellCheck={false}
                  placeholder="https://mcp.example.com/mcp"
                  onChange={(event) => set({ url: event.currentTarget.value })}
                />
              </FormField>
              <FormField
                label="Token variable"
                help="For a server that takes a token instead of a sign-in: the environment variable that holds it."
              >
                <input
                  className="field mono"
                  value={draft.bearerTokenEnvVar}
                  spellCheck={false}
                  placeholder="None"
                  onChange={(event) => set({ bearerTokenEnvVar: event.currentTarget.value })}
                />
              </FormField>
            </>
          )}
        </div>
        <div className="form-actions">
          <span className="grow caption muted">{problem ?? ""}</span>
          <button type="button" className="button" onClick={onDone}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={problem !== null || saving}>
            {saving ? "Saving…" : server ? "Save" : "Add server"}
          </button>
        </div>
      </form>
    </div>
  );
}

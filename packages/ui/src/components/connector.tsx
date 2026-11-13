import type { McpServerInfo, PluginDetail, PluginInfo, PluginMarketplace } from "@cycle/protocol";
import { useEffect, useState } from "react";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { compactNumber, tildePath } from "../lib/format.ts";
import { statusLabel, transportLabel } from "../lib/server-form.ts";
import { ConfirmDialog, Segmented, Switch } from "./controls.tsx";
import { Icon } from "./icons.tsx";
import { Menu } from "./menu.tsx";
import { ServerEditor } from "./server-editor.tsx";

type Tab = "mcp" | "plugins";

function ServerRow({
  server,
  onEdit,
  onRemove,
}: {
  server: McpServerInfo;
  onEdit(): void;
  onRemove(): void;
}) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const failed = server.enabled && server.status === "failed";
  const needsSignIn = server.enabled && server.auth === "signedOut";
  return (
    <div className="list-item" data-off={!server.enabled}>
      <div className="list-row">
        <button
          type="button"
          className="list-main"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span
            className="list-lead"
            data-tone={
              failed
                ? "error"
                : needsSignIn
                  ? "warning"
                  : server.enabled && server.status === "connected"
                    ? "success"
                    : undefined
            }
          >
            <Icon name={failed ? "alert" : server.enabled ? "plug" : "unplug"} />
          </span>
          <span className="list-text">
            <span className="list-name fade-x">{server.name}</span>
            <span className="caption muted fade-x">
              <span className={failed ? "tone-error" : needsSignIn ? "tone-warning" : undefined}>
                {statusLabel(server)}
              </span>
              {" · "}
              <span className="mono">{transportLabel(server)}</span>
            </span>
          </span>
        </button>
        {needsSignIn ? (
          <button
            type="button"
            className="button"
            onClick={() => void app.loginMcpServer(server.name)}
          >
            Sign in
          </button>
        ) : null}
        <Switch
          label={server.enabled ? `Turn ${server.name} off` : `Turn ${server.name} on`}
          checked={server.enabled}
          onChange={(enabled) => void app.enableMcpServer(server.name, enabled)}
        />
        {server.transport ? (
          <Menu
            className="icon-button small"
            title={`More options for ${server.name}`}
            align="end"
            width={180}
            entries={() => [
              { label: "Edit", icon: "edit", onSelect: onEdit },
              { label: "Remove…", icon: "trash", danger: true, onSelect: onRemove },
            ]}
          >
            <Icon name="more" size={14} />
          </Menu>
        ) : (
          <span className="row-menu-space" />
        )}
      </div>
      {open ? (
        <div className="list-detail">
          {server.error ? <p className="caption tone-error">{server.error}</p> : null}
          {server.transport?.kind === "stdio" && server.transport.env.length ? (
            <p className="caption muted">
              Environment: <span className="mono">{server.transport.env.join(", ")}</span>
            </p>
          ) : null}
          {server.tools.length === 0 ? (
            <p className="caption muted">
              {server.enabled
                ? "No tools listed. A server lists its tools once it has started."
                : "Turn it on to see its tools."}
            </p>
          ) : (
            <>
              <p className="caption muted">
                {server.transport
                  ? "Each tool on goes into every request whole, unless the model searches for its tools. Turn off the ones sessions do not need."
                  : "Each tool goes into every request whole, unless the model searches for its tools. Its plugin decides which are on."}
              </p>
              <ul className="tool-list">
                {server.tools.map((tool) => (
                  <li key={tool.name} className="tool-row" data-off={!tool.enabled}>
                    <span className="tool-line fade-x">
                      <span className="mono">{tool.name}</span>
                      {tool.description ? (
                        <span className="muted"> — {tool.description.split("\n")[0]}</span>
                      ) : null}
                    </span>
                    {tool.tokens !== null ? (
                      <span className="caption muted tool-weight">
                        ~{compactNumber(tool.tokens)}
                      </span>
                    ) : null}
                    {server.transport && server.enabled ? (
                      <Switch
                        label={tool.enabled ? `Turn ${tool.name} off` : `Turn ${tool.name} on`}
                        checked={tool.enabled}
                        onChange={(enabled) =>
                          void app.enableMcpTool(server.name, tool.name, enabled)
                        }
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function McpTab({ onEdit }: { onEdit(server: McpServerInfo | null): void }) {
  const app = useApp();
  const servers = useStore(app.mcp, (value) => value);
  const [removing, setRemoving] = useState<McpServerInfo | null>(null);
  return (
    <section aria-label="MCP servers">
      <div className="section-head">
        <h2>MCP servers</h2>
        <button
          type="button"
          className="button"
          disabled={servers === null}
          onClick={() => onEdit(null)}
        >
          Add server
        </button>
      </div>
      {servers === null ? (
        <p className="note" role="status">
          Reading the servers…
        </p>
      ) : servers.length === 0 ? (
        <div className="empty-card">
          <p>No MCP servers yet</p>
          <p className="caption muted">
            A server gives every session its tools. The codex CLI sees the same ones.
          </p>
        </div>
      ) : (
        <div className="card">
          {servers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              onEdit={() => onEdit(server)}
              onRemove={() => setRemoving(server)}
            />
          ))}
        </div>
      )}
      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          text="Sessions lose its tools, and so does the codex CLI. What it kept in its environment is removed with it."
          action="Remove"
          onConfirm={() => void app.removeMcpServer(removing.name)}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </section>
  );
}

function PluginRow({ plugin, marketplace }: { plugin: PluginInfo; marketplace: string }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  // Read each time it opens, so a failed read is tried again and an install shows what it brought.
  useEffect(() => {
    if (!open) return;
    setDetail(null);
    let current = true;
    void app
      .attempt(app.request("plugins.read", { marketplace, name: plugin.name }))
      .then((answer) => current && answer && setDetail(answer));
    return () => {
      current = false;
    };
  }, [app, open, marketplace, plugin.name, plugin.installed]);
  const during = (work: Promise<unknown>) => {
    setBusy(true);
    void work.finally(() => setBusy(false));
  };
  const brings = detail
    ? [
        detail.skills.length
          ? `Skills: ${detail.skills.map((skill) => skill.name).join(", ")}`
          : "",
        detail.mcpServers.length ? `MCP servers: ${detail.mcpServers.join(", ")}` : "",
        detail.apps.length ? `Apps: ${detail.apps.join(", ")}` : "",
        detail.hooks ? `Hooks: ${detail.hooks}` : "",
      ].filter(Boolean)
    : [];
  return (
    <div className="list-item" data-off={plugin.installed && !plugin.enabled}>
      <div className="list-row">
        <button
          type="button"
          className="list-main"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="list-lead">
            <Icon name="sparkle" />
          </span>
          <span className="list-text">
            <span className="list-name fade-x">
              {plugin.displayName}
              {plugin.version ? <span className="caption muted"> {plugin.version}</span> : null}
            </span>
            <span className="caption muted fade-x">
              {plugin.unavailable ?? (plugin.description || plugin.id)}
            </span>
          </span>
        </button>
        {plugin.installed ? (
          <>
            <Switch
              label={
                plugin.enabled ? `Turn ${plugin.displayName} off` : `Turn ${plugin.displayName} on`
              }
              checked={plugin.enabled}
              onChange={(enabled) => void app.enablePlugin(plugin.id, enabled)}
            />
            <Menu
              className="icon-button small"
              title={`More options for ${plugin.displayName}`}
              align="end"
              width={180}
              entries={() => [
                {
                  label: "Uninstall",
                  icon: "trash",
                  danger: true,
                  onSelect: () => during(app.uninstallPlugin(plugin.id)),
                },
              ]}
            >
              <Icon name="more" size={14} />
            </Menu>
          </>
        ) : (
          <button
            type="button"
            className="button"
            disabled={busy || !plugin.available}
            onClick={() => during(app.installPlugin(marketplace, plugin.name))}
          >
            {busy ? "Installing…" : "Install"}
          </button>
        )}
      </div>
      {open ? (
        <div className="list-detail">
          {detail === null ? (
            <p className="caption muted">Reading what it brings…</p>
          ) : (
            <>
              {detail.description ? <p className="caption">{detail.description}</p> : null}
              {brings.length ? (
                brings.map((line) => (
                  <p key={line} className="caption muted">
                    {line}
                  </p>
                ))
              ) : (
                <p className="caption muted">It lists nothing it brings.</p>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function PluginsTab() {
  const app = useApp();
  const catalog = useStore(app.plugins, (value) => value);
  const home = useStore(app.daemon, (daemon) => daemon?.userHome);
  const [source, setSource] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PluginMarketplace | null>(null);
  const add = () => {
    const text = source.trim();
    if (!text || adding) return;
    setAdding(true);
    void app
      .addMarketplace(text)
      .then((done) => done && setSource(""))
      .finally(() => setAdding(false));
  };
  return (
    <section aria-label="Plugins">
      <div className="section-head">
        <h2>Plugins</h2>
      </div>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          className="field mono"
          value={source}
          spellCheck={false}
          aria-label="Marketplace to add"
          placeholder="owner/repo, a git address, or a folder"
          onChange={(event) => setSource(event.currentTarget.value)}
        />
        <button type="submit" className="button" disabled={adding || source.trim() === ""}>
          {adding ? "Adding…" : "Add marketplace"}
        </button>
      </form>
      {catalog === null ? (
        <p className="note" role="status">
          Reading the plugins…
        </p>
      ) : catalog.marketplaces.length === 0 ? (
        <div className="empty-card">
          <p>No marketplaces yet</p>
          <p className="caption muted">
            A marketplace lists plugins: skills, MCP servers and hooks installed together.
          </p>
        </div>
      ) : (
        catalog.marketplaces.map((marketplace) => (
          <div key={marketplace.name} className="marketplace">
            <div className="section-head sub">
              <h3 className="fade-x">
                {marketplace.displayName}
                {marketplace.path ? (
                  <span className="caption muted mono"> {tildePath(marketplace.path, home)}</span>
                ) : null}
              </h3>
              <Menu
                className="icon-button small"
                title={`More options for ${marketplace.displayName}`}
                align="end"
                width={200}
                entries={() => [
                  {
                    label: "Remove marketplace…",
                    icon: "trash",
                    danger: true,
                    onSelect: () => setRemoving(marketplace),
                  },
                ]}
              >
                <Icon name="more" size={14} />
              </Menu>
            </div>
            {marketplace.plugins.length === 0 ? (
              <p className="note">It lists no plugins.</p>
            ) : (
              <div className="card">
                {marketplace.plugins.map((plugin) => (
                  <PluginRow key={plugin.id} plugin={plugin} marketplace={marketplace.name} />
                ))}
              </div>
            )}
          </div>
        ))
      )}
      {catalog?.errors.map((line) => (
        <p key={line} className="caption tone-error" role="alert">
          {line}
        </p>
      ))}
      {removing ? (
        <ConfirmDialog
          title={`Remove ${removing.displayName}?`}
          text="Its plugins can no longer be installed from here. Plugins already installed stay."
          action="Remove"
          onConfirm={() => void app.removeMarketplace(removing.name)}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </section>
  );
}

/** The Connector: codex's own MCP servers and plugins, which every session and the CLI share. */
export function ConnectorPage() {
  const app = useApp();
  const [tab, setTab] = useState<Tab>("mcp");
  const [editing, setEditing] = useState<{ server: McpServerInfo | null } | null>(null);
  const connected = useStore(app.connection, (status) => status === "open");
  useEffect(() => {
    if (connected) void app.loadConnector();
  }, [app, connected]);
  if (editing) return <ServerEditor server={editing.server} onDone={() => setEditing(null)} />;
  return (
    <div className="page fade-y">
      <div className="page-content">
        <header className="page-header">
          <h1>Connector</h1>
          <p className="page-lead">
            What every session can reach. These are codex's own settings, so the codex CLI uses the
            same servers and plugins.
          </p>
        </header>
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "mcp", label: "MCP servers" },
            { value: "plugins", label: "Plugins" },
          ]}
        />
        {tab === "mcp" ? <McpTab onEdit={(server) => setEditing({ server })} /> : <PluginsTab />}
      </div>
    </div>
  );
}

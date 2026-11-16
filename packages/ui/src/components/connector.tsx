import {
  type McpServerInfo,
  type PluginDetail,
  type PluginInfo,
  type PluginMarketplace,
  harnessLabel,
} from "@cycle/protocol";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { compactNumber, tildePath } from "../lib/format.ts";
import { PLUGINS_FIRST, PLUGINS_MORE, matchPlugins, orderMarketplaces } from "../lib/plugins.ts";
import { statusLabel, transportLabel } from "../lib/server-form.ts";
import { ConfirmDialog, Segmented, Switch } from "./controls.tsx";
import { Icon } from "./icons.tsx";
import { Menu } from "./menu.tsx";
import { HooksTab, SkillsTab } from "./agent-config.tsx";
import { ServerEditor } from "./server-editor.tsx";

type Tab = "mcp" | "plugins" | "skills" | "hooks";

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
        {server.origin === "config" ? (
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
          {!server.enabled || server.tools.length === 0 ? (
            <p className="caption muted">
              {server.enabled
                ? "No tools listed. A server lists its tools once it has started."
                : "Turn it on to see its tools."}
            </p>
          ) : (
            <>
              <p className="caption muted">
                {server.origin !== "plugin"
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
                    {server.origin !== "plugin" && server.enabled ? (
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
            {app.shownAgent() === app.mainHarness()
              ? "A server gives every session its tools. The codex CLI sees the same ones."
              : "A server gives every session its tools."}
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
          text={`Sessions lose its tools${app.shownAgent() === app.mainHarness() ? ", and so does the codex CLI" : ""}. What it kept in its environment is removed with it.`}
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
  const [asking, setAsking] = useState(false);
  // A plugin can bring hooks, which run commands as the owner: where Cycle keeps an agent's hooks,
  // it asks before installing one, since what a plugin brings is known only once it is in.
  const asks = app.capabilities(app.shownAgent()).hooks;
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
            onClick={() =>
              asks ? setAsking(true) : during(app.installPlugin(marketplace, plugin.name))
            }
          >
            {busy ? "Installing…" : "Install"}
          </button>
        )}
        {asking ? (
          <ConfirmDialog
            title={`Install ${plugin.displayName}?`}
            text="A plugin can bring hooks: commands that run as you in every session, whatever its mode. Install only one you trust."
            action="Install"
            onConfirm={() => during(app.installPlugin(marketplace, plugin.name))}
            onClose={() => setAsking(false)}
          />
        ) : null}
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
  const [query, setQuery] = useState("");
  /** How many of each marketplace's plugins are drawn, where the owner asked for more. */
  const [limits, setLimits] = useState<Record<string, number>>({});
  const markets = useMemo(() => orderMarketplaces(catalog?.marketplaces ?? []), [catalog]);
  const searching = query.trim() !== "";
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
      {catalog !== null && catalog.marketplaces.length > 0 ? (
        <input
          type="search"
          className="field"
          value={query}
          spellCheck={false}
          aria-label="Search plugins"
          placeholder="Search plugins"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      ) : null}
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
        markets.map((marketplace) => {
          const { shown, total } = matchPlugins(
            marketplace.plugins,
            query,
            limits[marketplace.name] ?? PLUGINS_FIRST,
          );
          // A search hides the marketplaces it finds nothing in.
          if (searching && total === 0) return null;
          return (
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
                  {shown.map((plugin) => (
                    <PluginRow key={plugin.id} plugin={plugin} marketplace={marketplace.name} />
                  ))}
                  {total > shown.length ? (
                    <button
                      type="button"
                      className="button"
                      onClick={() =>
                        setLimits((all) => ({
                          ...all,
                          [marketplace.name]: shown.length + PLUGINS_MORE,
                        }))
                      }
                    >
                      Show {Math.min(PLUGINS_MORE, total - shown.length)} more of{" "}
                      {total - shown.length}
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          );
        })
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

/**
 * The Connector: each agent's MCP servers and plugins. Codex's are its own settings, which its CLI
 * shares; Claude Code's are what Cycle keeps for it, over the owner's own, which it can turn off.
 */
export function ConnectorPage() {
  const app = useApp();
  const [tab, setTab] = useState<Tab>("mcp");
  const [editing, setEditing] = useState<{ server: McpServerInfo | null } | null>(null);
  const connected = useStore(app.connection, (status) => status === "open");
  const shown = useStore(app.connectorAgent, (value) => value);
  const agents = useStore(app.harnesses, (all) =>
    all.filter((each) => each.capabilities.connector === "edit").map((each) => each.name),
  );
  const agent = shown ?? app.mainHarness();
  const hooks = app.capabilities(agent).hooks;
  const own = agent === app.mainHarness();
  useEffect(() => {
    if (connected) void app.loadConnector();
  }, [app, connected]);
  if (editing) return <ServerEditor server={editing.server} onDone={() => setEditing(null)} />;
  const tabs: { value: Tab; label: string }[] = [
    { value: "mcp", label: "MCP servers" },
    { value: "plugins", label: "Plugins" },
    ...(hooks
      ? [
          { value: "skills" as const, label: "Skills" },
          { value: "hooks" as const, label: "Hooks" },
        ]
      : []),
  ];
  const current = tabs.some((each) => each.value === tab) ? tab : "mcp";
  return (
    <div className="page fade-y">
      <div className="page-content">
        <header className="page-header">
          <h1>Connector</h1>
          <p className="page-lead">
            {own
              ? "What every session can reach. These are codex's own settings, so the codex CLI uses the same servers and plugins."
              : `What every ${harnessLabel(agent)} session can reach. Cycle keeps these itself: the claude command line does not see what is added here, and what you set up there shows here, to turn off.`}
          </p>
        </header>
        {agents.length > 1 ? (
          <Segmented<string>
            label="Whose connector"
            value={agent}
            onChange={(next) => app.showConnector(next)}
            options={agents.map((name) => ({ value: name, label: harnessLabel(name) }))}
          />
        ) : null}
        <Segmented<Tab> label="What to connect" value={current} onChange={setTab} options={tabs} />
        {current === "mcp" ? (
          <McpTab onEdit={(server) => setEditing({ server })} />
        ) : current === "plugins" ? (
          <PluginsTab />
        ) : current === "skills" ? (
          <SkillsTab />
        ) : (
          <HooksTab />
        )}
      </div>
    </div>
  );
}

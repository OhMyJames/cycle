# Agent Note: Cycle keeps Claude Code's configuration and hands it to each process

Status: accepted
Date: 2026-11-16, revised 2026-11-16 as it was built
Basis: The owner chose that Cycle keeps its own Claude Code configuration and gives it to every
process, never writing the owner's `~/.claude` (2026-11-16). Read from `@anthropic-ai/claude-agent-sdk`
0.3.325 (`sdk.d.ts`, and `sdk.mjs` where it builds Claude Code's arguments and its `initialize`
request), and checked on 2026-11-16 against Claude Code 2.1.325 through that SDK and
`mock-claude.ts`, with a temporary `CLAUDE_CONFIG_DIR` holding a user hook, a user MCP server and a
plugin installed with `claude plugin install` from a local marketplace. Each finding below was read
from the process's own `/proc/<pid>/cmdline` and `environ`, its `init` message, `mcpServerStatus()`,
the requests it sent the model, and what its hooks wrote.

## Problem

Codex's MCP servers, plugins and skills live in its `config.toml`, which app-server reads and writes,
so the Connector edits that file and the codex CLI sees the same servers
([note](2026-11-13-the-connector-is-codex-config.md)). Claude Code has no such call. `updateSettings`
takes `outputStyle` and `effortLevel` only; `toggleMcpServer`, `setMcpServers` and
`applyFlagSettings` change one running process. Writing the owner's `~/.claude/settings.json` or
`~/.claude.json` would work, but the owner ruled it out: those files are the owner's CLI's, and an
agent's edits there outlive Cycle.

Some ways of handing Claude Code its configuration put it on the command line, which every command
of every session can list with `ps`. An MCP server's environment values must not go there
([note](2026-11-13-cycle-tools-behind-their-own-key.md), CLAUDE.md red lines).

## What was checked

How each option reaches Claude Code:

| Option                                            | Reaches Claude Code as                        | A value in it is on the command line |
| ------------------------------------------------- | --------------------------------------------- | ------------------------------------ |
| `settings` as an object                           | `--settings <the whole JSON>`                 | yes                                  |
| `settings` as a path                              | `--settings <path>`                           | no                                   |
| `settings` object with the SDK's `sandbox` option | merged, `--settings <JSON>`                   | yes                                  |
| `settings` path with the SDK's `sandbox` option   | refused by the SDK                            | (n/a)                                |
| `mcpServers`                                      | `--mcp-config <the whole JSON, env included>` | **yes**                              |
| `extraArgs: { "mcp-config": <path> }`             | `--mcp-config <path>`                         | no                                   |
| `mcpServers` inside a settings file               | ignored: no server starts                     | (n/a)                                |
| `setMcpServers()` after start                     | a control request on stdin                    | no                                   |
| `plugins`                                         | `--plugin-dir=<path>`                         | only the path                        |
| `plugins` with `pluginDelivery: "initialize"`     | the `initialize` request on stdin             | no                                   |
| `agents`, `hooks` callbacks                       | the `initialize` request on stdin             | no                                   |
| `applyFlagSettings()`                             | a control request on stdin                    | no                                   |

None of them put anything in Claude Code's environment. A `--settings` file edited after start is not
read again (checked with a four-second wait).

What the flag layer can turn off of the owner's (user layer in the temporary home):

| Owner's item                                              | Switch                                                  | Result                                                         |
| --------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| A hook in `settings.json`                                 | `disableAllHooks: true`                                 | off, and a plugin's hooks too                                  |
| One hook of several                                       | none: flag hooks are added beside the owner's           | cannot                                                         |
| Cycle's own hook in the flag file, with `disableAllHooks` |                                                         | off too; only the SDK's in-process `hooks` callbacks still run |
| An MCP server in `.claude.json`                           | `deniedMcpServers: [{ serverName }]`                    | gone from the process                                          |
| One MCP tool                                              | `disallowedTools: ["mcp__<server>__<tool>"]`            | the model no longer gets it; the server stays connected        |
| A plugin installed with `claude plugin install`           | `enabledPlugins: { "<id>": false }`                     | off, with its skills and hooks                                 |
| A plugin the owner turned off                             | `enabledPlugins: { "<id>": true }`                      | on                                                             |
| A skill in the owner's `skills/`                          | `skillOverrides: { "<name>": "off" }`                   | the model no longer sees it                                    |
| A plugin's skill                                          | `skillOverrides` with its name, plain or `plugin:skill` | still seen                                                     |
| Any skill                                                 | the SDK's `skills` list, without it                     | the model no longer sees it                                    |
| Everything of the user layer                              | `settingSources: ["project", "local"]`                  | owner's hooks, MCP servers, plugins and skills all gone        |

At run time, in a running process: `applyFlagSettings` turned off hooks and denied an MCP server
(it went to `failed`) at once; `enabledPlugins: false` then `reloadPlugins()` dropped the plugin and
its hook. **`toggleMcpServer(name, false)` writes `disabledMcpServers` into the owner's
`.claude.json`** (under `projects[<folder>]`), so a later process, and the owner's CLI in that folder,
find the server off.

Plugins: `claude plugin install` has only the `user`, `project` and `local` scopes, each a settings file
of the owner's. Run with `CLAUDE_CONFIG_DIR` set to a folder of Cycle's own, it installs there
(`plugins/cache/<marketplace>/<plugin>/<version>`) and touches nothing of the owner's; that folder,
given as a local plugin, loads with its skills and hooks, and reports itself as `<name>@inline`.

## Decision

**Where.** `CYCLE_HOME/claude.json`, mode 0600 as `providers.json`, since it holds MCP servers'
environment values and headers. It is the truth; nothing else is. It holds:

- `mcpServers`: Cycle's own servers, `stdio` (`command`, `args`, `env`) or `http` (`url`, `headers`),
  each with `enabled` and its tools turned off.
- `owner`: what Cycle turns off of the owner's own, by name: MCP servers, plugin ids, skills,
  `hooks: false` for all of them, and `read: false` to read no user layer at all.
- `hooks`: Cycle's own, in Claude Code's settings shape.
- `plugins`: Cycle's installs, each its id, the folder it was installed to and `enabled`.
- `skills`: the names turned off.
- `agents`: Cycle's own subagents, in the SDK's `AgentDefinition` shape.

A file that is not there is an empty configuration. The page gets the names of a server's
environment variables and headers, never their values; an edit that names one with no value keeps
the stored one, as the codex Connector does.

`CYCLE_HOME/claude/` holds what is made from it: `settings-<hash>.json` (0600), the flag layer each
process is started with, and `plugins/`, the Claude Code home Cycle installs plugins into. Neither is
read back as truth.

**How it gets to Claude Code.** Nothing of it goes on the command line but paths and names:

- The flag layer is a file, given as `settings: <path>`, never as an object. It carries
  `disableAllHooks`, `deniedMcpServers`, `enabledPlugins`, `skillOverrides` and Cycle's `hooks`. Since
  the SDK refuses a path beside its `sandbox` option, which `auto` uses, the harness stops passing
  `sandbox` and writes the mode's `sandbox` block into the same file, as the SDK would have merged it
  (`failIfUnavailable` included). One file for each distinct content, named by its hash, so processes
  in different modes never share or race on one.
- Cycle's MCP servers go with `setMcpServers` once the process has started, together with Cycle's
  tools server, which already goes this way. Their values reach the server's process only.
- Cycle's plugins go as `plugins: [{ type: "local", path }]` with `pluginDelivery: "initialize"`.
- Skills turned off go as `skillOverrides: { <name>: "off" }` in the file, which hides an owner's
  skill from the model, and as `disallowedTools: Skill(<name>)`, which stops one a plugin brings
  being run, since `skillOverrides` does not reach those. The SDK's `skills` list would need every
  skill's name before the process that lists them has started. Names are not secrets.
- One MCP tool turned off goes as `disallowedTools`, names only.
- `agents` go with the `initialize` request. `shortcut: Cycle keeps no subagents of its own yet;
  upgrade when the owner asks for one in Cycle.`
- `mcpServers` and `--mcp-config` are not used. `toggleMcpServer` is not used, since it writes the
  owner's `.claude.json`.

**The owner's own `~/.claude`.** Cycle's layer sits on top of it: `settingSources` stays
`["user", "project", "local"]` unless the owner turns reading the user layer off. Cycle reads the
owner's items to list them only through Claude Code (`mcpServerStatus`, the `init` message's plugins
and skills, `getHooksListing`), never by parsing its files, and writes none of them. In Cycle the owner
can turn off, of their own: any MCP server, any MCP tool, any plugin, any skill from their `skills/`,
and all their hooks at once. One hook of theirs cannot be turned off alone. Turning all hooks off
turns off Cycle's own too, as Claude Code has one switch for both; the page says so. Not reading the
user layer turns off all of the owner's settings, hooks, servers, plugins and skills, and keeps
Cycle's.

**Sandboxes.** A sandboxed session keeps having none of the owner's settings and, for now, none of
Cycle's: hooks, plugins and `stdio` servers name programs and folders of this machine, which the
sandbox does not have. `shortcut: sandboxed sessions get no Claude configuration of Cycle's; upgrade
when the owner asks for an MCP server in a sandbox`. That upgrade would give `http` servers only,
through `setMcpServers` on Claude Code's own pipe, which `sbx exec -i` carries, never as an argument
of `sbx` or a file in the sandbox.

**When a change takes effect.** A new process reads the whole configuration. In a running one:

- Cycle's MCP servers: `setMcpServers` with the new set, at once.
- The owner's MCP servers and hooks turned off or on, and plugins of the owner's turned off or on:
  `applyFlagSettings` with the whole flag layer, then `reloadPlugins`, which waits while a turn runs.
- Everything else (Cycle's hooks and plugins, skills, MCP tools, reading the user layer) takes
  effect when the process starts again. A process is started again with its next prompt when what
  only a start takes has changed, unless a task of its own still runs in the background, which a
  new start would stop; then it waits for a prompt after the task, or for a new session.

**Hooks.** A hook runs any command as the owner, outside Claude Code's own sandbox, in every Claude
session, whatever its mode. The page shows the command and asks before it saves a new or changed one,
and before it installs any plugin, since Claude Code says what a plugin brings only once it is in.

**Plugins.** Cycle installs with `claude plugin install <plugin> --marketplace <source>`, run with
`CLAUDE_CONFIG_DIR` set to `CYCLE_HOME/claude/plugins`, and keeps the folder it was installed to.
A marketplace that declares a command to run is shown to the owner before Cycle passes `-y`. Cycle
downloads nothing itself.

## Alternatives considered

- **Writing the owner's `~/.claude`.** The codex way: one truth, seen by the CLI. Rejected by the
  owner: the files are the CLI's, and a change made from a phone would land on the owner's desk.
- **The `settings` object and `mcpServers` options.** The SDK's plain way. Rejected: both put the whole
  JSON on the command line, environment values included.
- **`--mcp-config <path>`, the servers in a file.** Off the command line, but the values would sit in
  one more file the agent's commands can read. `setMcpServers` keeps them in Cycle's file alone, and
  is already how Cycle's tools server is given.
- **Everything with `applyFlagSettings` after start.** No file at all, but `SessionStart` hooks and
  plugins would already have run or loaded with the owner's layer alone.
- **`toggleMcpServer` for the owner's servers.** Rejected: it writes the owner's `.claude.json`.
- **Cycle's hooks as the SDK's in-process `hooks` callbacks.** They would survive `disableAllHooks`,
  but would run in the daemon, not where Claude Code runs, and Cycle would be its own hook runner.
- **Downloading marketplaces and plugins in the daemon.** Rejected: Claude Code's own install already
  resolves marketplaces, versions and declared commands, and can be pointed at a home of Cycle's.

## Consequences

- What is added in Cycle is not in the terminal's `claude`, and the other way round only the owner's
  own items show, as theirs. This is the reverse of the codex Connector, and the page should not
  present the two as one.
- A Cycle server named as one of the owner's turned off would be turned off too: `deniedMcpServers`
  goes by name and blocks "across all scopes" (`sdk.d.ts`; not checked). The store refuses a name the
  owner already uses.
- `claude.json` and the files made from it are readable by the agent's commands, as `providers.json`
  is: one owner, one user. Values never reach a command line, an environment of Claude Code's, a log,
  or the page.
- A process started before a change is not stopped for it: what cannot reach it over its pipe waits
  for its next prompt.
- The wire: `McpServerInfo.origin` says where a server is kept (`config`, `owner`, `plugin`), for
  codex too. `skills.enable`, `hooks.read` and `hooks.set` take an agent's name; codex refuses them.
  `AgentCapabilities.hooks` says which agent has them.
- The harness takes over the merge the SDK does of its `sandbox` option. A new SDK that changes that
  merge must be checked against it.
- The configuration lives in the `CYCLE_HOME` of the machine the daemon runs on. With a daemon on a
  server (goal 2), it is the server's, paths and plugin folders included; the page edits it the same
  way.
- Cycle's plugin home lists Claude Code's own directory of plugins, some thousands, fetched by its
  `plugin` command.
- Checked in `apps/daemon/test/integration/claude-config.test.ts` against the real Claude Code: a
  server added in Cycle is used in a new session and its values are in no command's `ps` or `env`;
  an owner's server turned off is off in Cycle alone; Cycle's hook runs beside the owner's, and the
  owner's switch, sent to a running process, stops both. The owner's files are unchanged after each.
- Not checked: `applyFlagSettings` adding a hook to a running process (a hook waits for the next
  start instead); whether not reading the user layer keeps a subscription sign-in (the checks used
  an API key).

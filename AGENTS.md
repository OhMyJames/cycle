# cycle

A self-use agent client: one owner, one daemon, many sessions at once, with agents that can run commands.
It is the successor of [old-cycle](https://github.com/OhMyJames/old-cycle), rebuilt on `codex app-server`.
Bun, TypeScript 7, React, Electron.

## The gate

`bun run check` must pass before any commit. The pre-commit hook runs it with `--changed`, which limits
only the unit tests to those the change affects. Do not bypass it with `--no-verify`, `@ts-ignore` or a
lint-disable comment; fix the cause or change the rule on purpose.

It runs, in order: the lockfile, then boundaries, format, typecheck and lint together, then the unit
tests alone so their time limits measure the tests.

## Red lines

Each of these has cost, or could cost, something that cannot be undone. Stop and ask instead.

- The daemon binds to loopback, requires a connection token, and checks `Host` and `Origin`, because
  agents can run commands. Never loosen any of the three. Why:
  [decision note](.agents/notes/2026-11-12-the-daemon-serves-its-own-page.md).
- Never point a test at the real `CYCLE_HOME` (`~/.cycle-codex`), the real `CODEX_HOME` (`~/.codex`) or
  Claude Code's real home (`~/.claude`, which `CLAUDE_CONFIG_DIR` moves). Tests make their own under a
  temporary folder. `~/.cycle` belongs to old-cycle: never write there.
- `session.delete` removes a conversation for good, whichever tool started it. Clients confirm first.
- `fullAccess` mode runs with no sandbox and never asks. It is never a default, and nothing turns it on
  for the owner.
- No token, key or account secret may reach a page's storage beyond the connection token, or a log.
  An MCP server's environment values count: the page is given their names only.
  A provider's key goes from the page to the daemon once, and no wire method gives it back.
  A sandbox environment's variable values count too: the page is given their names, and `sbx` is
  given a value in a file only the owner can read, removed once read, never as an argument. A sandbox's sign-in is handed
  to `sbx` over its input and kept nowhere in Cycle.
- `/Applications/Cycle.app` is old-cycle's and may be in use. The installer and the updater write only
  `Cycle Codex.app`, and only over an app whose identifier is `dev.cycle.codex`.
- An update restarts the app, which stops running turns. It is downloaded unasked and installed only
  when the owner clicks. The owner's GitHub token stays in the main process, in request headers to
  `api.github.com` only.
- The gateway holds the reach of the owner's provider keys. It binds to loopback, checks `Host`, and
  answers only its bearer. Never loosen any of the three. Why:
  [decision note](.agents/notes/2026-11-13-providers-go-through-a-gateway-of-pi-ai.md).
- Cycle's tools for agents are a server of the same kind: loopback, `Host`, its own bearer, which is
  never the connection token. Never loosen any of the three, and its tools only read. Why:
  [decision note](.agents/notes/2026-11-13-cycle-tools-behind-their-own-key.md). The bearer never goes
  into an agent process's arguments or environment, which the commands it runs can read: codex reads
  it from a variable kept from its commands, and Claude Code is handed it over its own pipe.

## Testing

Agents generate a lot of tests, so the suite has hard limits. The check enforces all of them.

- Tests live in a `test/` directory beside `src/`, never beside the code they cover. A package with
  tests needs `test/tsconfig.json`.
- `test/` holds unit tests. They may not touch processes, network, disk or timers, and each has 200ms.
  Code takes what it needs as ports (`Delay`, `TextFile`, `Exec`, `Harness`), so tests pass fakes:
  see `apps/daemon/test/fake-harness.ts`.
- `test/integration/` holds everything slower. `bun run test:integration` runs it; the gate does not.
  It runs the real `codex app-server` and the real Claude Code against scripted models
  (`mock-model.ts`, `mock-claude.ts`), with no account, and a stand-in for `sbx` (`fake-sbx.sh`).
- The whole unit suite has a 30s budget. `test.only`, `.skip` and `.todo` are not allowed. A test file
  may not exceed 400 lines.
- Test behavior through a package's public surface, and delete a test when the behavior it covers goes.

`bun run demo` runs the whole app against the scripted model in a throwaway project. Use it to see a
change in the real page, and drive it with Playwright when the change is in the page.

## Runtime data

Cycle keeps its data in `CYCLE_HOME`, which defaults to `~/.cycle-codex` and must be an absolute path:
`daemon.json` (where the running daemon is, and its token, mode 0600), `settings.json` (what new
sessions start with, and the owner's projects), `sessions.json` (what only Cycle knows of each session:
pin, unread, mode, model, worktree, sandbox, the schedule that started it), `providers.json` (the owner's model
providers and their keys, mode 0600), `provider-models.json` (codex's catalog of
those providers' models, which says how much each can read; written as the second codex child starts),
`sandboxes.json` (the owner's sandbox environments, variable values included, and what each sandbox
Cycle made was made with, mode 0600), `usage.json` (tokens per local day, numbers only),
`schedules.json` (prompts the daemon runs on a timing, with each one's latest runs;
[decision note](.agents/notes/2026-11-13-schedules-in-the-daemon.md)), `daemon.log` (what the packaged
app's daemon printed, since its last start), `updates/` (the app's own update, downloaded and unpacked
until the owner installs it, `update.log`, what each check and install did, and `install.log`, what
the last swap said;
[decision note](.agents/notes/2026-11-13-updates-from-github-releases.md)) and `worktrees/`.
Conversations themselves are the agent's that ran them: codex's in `CODEX_HOME`, Claude Code's in its
own home. Cycle keeps no copy.
Why: [decision note](.agents/notes/2026-11-12-codex-keeps-the-conversations.md). MCP servers and plugins
are codex's too, in its `config.toml`: Cycle keeps no list of its own.

## Architecture

```
apps/desktop (Electron)      apps/daemon (Bun)                  harness/codex            codex app-server
 main: starts the daemon  →   SessionHub: frames, queue     →    wire ↔ model         →   threads, turns, items
 page: packages/ui        ←   Git, Terminals, Files, usage  ←    its child processes  ←   exec, pty, fs, search
            └──────────── packages/protocol: model, wire methods, the shared reducer ────────────┘

                              Harnesses: a session stays with       harness/claude        Claude Code
                              the agent its model is of          →   SDK ↔ model       →   one process a session

 a second codex child, for the owner's model providers  →  packages/gateway: Responses API ↔ pi-ai  →  the provider
```

The allowed dependencies live in `RULES` in `scripts/lib/boundaries.ts`, and the check enforces them.

- `packages/protocol` is the harness-agnostic model (`Item`, `Turn`, `SessionEvent`), the client-daemon
  wire (`Methods`, `EventFrame`, `DaemonEvent`), the `Harness` interface, and `reduceSession`, which the
  daemon and the page both fold events with. It is platform-neutral: no runtime modules.
- A `Harness` is four parts: `Agent` (sessions, turns, models), `Connector`, `Account` and `Machine`.
  Codex gives all four and is the main one. Another agent beside it need only be an `Agent`, and
  `Harnesses` (`apps/daemon/src/harnesses.ts`) joins them: a model says which agent a new session
  starts on, the session stays there, and files, commands, terminals, the Connector and the account
  are the main agent's. An agent that cannot start is left out and the daemon runs without it. Why:
  [decision note](.agents/notes/2026-11-14-claude-code-beside-codex.md).
- `harness/claude` is the only code that knows Claude Code, through the Claude Agent SDK.
  `translate.ts` is the pure mapping; `claude-harness.ts` runs one Claude Code process for each session
  in use, started with the session's mode, model and effort and closed after five idle minutes, and
  reads stored sessions with the SDK's own calls. A turn is known by its prompt's id, live and stored.
  Claude Code reads the owner's own settings, as its CLI does.
- A session can run its agent in a Docker sandbox (`sbx`) on this machine: `harness/claude/src/sandbox.ts`.
  A folder's sandbox is made when first asked for, and it sees the folder at the same
  path, so only Claude Code moves into it, started with `sbx exec`; files, git and terminals stay this
  machine's. Of the owner's Claude Code home only the folder's conversations are shared into it, so
  they are stored and read here. The sandbox has its own sign-in (`sbx secret set anthropic`), no
  settings of the owner's, and no reach to Cycle's tools. Codex sessions and worktrees do not run in
  one. Why: [decision note](.agents/notes/2026-11-14-a-local-sandbox-holds-the-agent-only.md).
- A sandbox is made with an environment of the owner's (`apps/daemon/src/sandboxes.ts`, Settings,
  Sandboxes): CPUs, memory, variables, hosts to allow and a setup script. A new session chooses one,
  and a folder has a sandbox for each environment it is worked in. The daemon keeps the environments
  and the sandboxes keep to them: `SbxSandboxes` makes a sandbox again, the next time it is used
  with no session running in it, once anything changed that only its making sets; opens and closes
  hosts on it as it is; and saves a sandbox that has run the setup script (`sbx template save`), so
  the next folder's starts from that. Sign-ins are `sbx`'s own secrets, for every sandbox. Why:
  [decision note](.agents/notes/2026-11-14-sandbox-environments.md).
- `harness/codex` is the only code that knows codex. `translate.ts` is the pure mapping; `codex-harness.ts`
  drives `codex app-server` children (`process.ts`), starts one again if it dies, and brings a session
  back into it the next time it is used. Codex runs one model provider per process and keeps a thread
  with the provider it began on, so sessions on the owner's providers live in a second child, started
  when first needed. Codex caps a model it does not know at 272k tokens, so that child starts with a
  catalog of the owner's models (`catalog.ts`), and starts again, when idle, once they change. The
  catalog turns tool search on, so the owner's MCP tools wait behind it there too, instead of each going
  whole into every request.
- `packages/gateway` is the only code that knows pi-ai. It is a Responses API endpoint on loopback that
  the second child takes for its model provider: `responses.ts` is the pure mapping to and from pi-ai's
  conversation, `catalog.ts` the services and models pi-ai knows. Codex's tool search, a kind of its
  own in the Responses API, reaches the model as a function, and the tools it finds join the list for
  the rest of the conversation. A provider's model is
  `<provider id>/<model id>` everywhere. The ChatGPT subscription is codex's own sign-in, not pi-ai's.
- The daemon reaches the project only through the harness: git, files, search and terminals all run as
  codex `command/exec` and `fs/*` calls, so the daemon follows the agent wherever it runs. Why:
  [decision note](.agents/notes/2026-11-12-the-harness-is-the-machine.md).
- `SessionHub` (`apps/daemon/src/sessions.ts`) owns session state. It folds harness events, batches
  streamed text into one frame per 16ms, numbers frames per session, and keeps the last 512 so a client
  that was away asks for what it missed instead of everything. Why:
  [decision note](.agents/notes/2026-11-12-numbered-frames.md).
- A prompt sent during a turn is queued in the daemon and sent when the turn completes, or put into the
  running turn with `delivery: "steer"`. A stopped turn gives its queue back to the page.
- The daemon serves the built page itself, and the desktop app loads it from there, so there is one
  origin. A browser can use the same link.
- `packages/ui` keeps state in stores by owner (`CycleApp`), read through `useStore` with a selector.
  A streamed chunk redraws one conversation's last turn: frames are applied once per animation frame,
  `reduceSession` keeps every other turn's identity, and `parseMarkdown` parses only the last block.
- The Connector is codex's own configuration, read and written through the harness (`config/read`,
  `config/batchWrite`, `mcpServerStatus/list`, `mcpServer/oauth/login`, `plugin/*`, `marketplace/*`), so
  a server added in Cycle works in the codex CLI and the other way round. A tool turned off is in
  its server's `disabled_tools`, and subagents off are `features.multi_agent = false`, since both go
  into every request. Codex lists only the tools it offers, so one turned off is known by name from
  the configuration. A server's environment values never leave the harness: the page gets the names. Why:
  [decision note](.agents/notes/2026-11-13-the-connector-is-codex-config.md).
- The daemon serves an MCP server of its own, `cycle` (`apps/daemon/src/tools.ts`), to every session's
  agent: the owner's sessions as a list, and one session's conversation, which is what a mention of a
  session in a prompt (`[@title](cycle://session/<id>)`) points to. It changes nothing. It is a server
  apart, on loopback behind its own key, which codex gets at start and the agent's commands do not. Why:
  [decision note](.agents/notes/2026-11-13-cycle-tools-behind-their-own-key.md).
- `Scheduler` (`apps/daemon/src/schedules.ts`) starts each schedule's prompt in a new session when it is
  due, as the composer would. It waits on no timer of its own: the daemon calls `tick` every 15s, and a
  tick compares the clock with what already ran, so a daemon that was stopped catches up on the latest
  missed occurrence only. Schedules run only while the daemon does.
- `apps/desktop` is the Electron shell: it starts the daemon, loads its page, and gives the page a small
  bridge (`window.cycle`): a folder chooser, notifications, opening links. `bun run desktop:package`
  assembles a self-contained app from Electron's own dist, with the daemon compiled by Bun and codex's
  platform binary inside; `bun run desktop:install` puts it in `/Applications/Cycle Codex.app`. Claude
  Code is not carried: a packaged app uses the owner's own `claude` from their `PATH`. A
  packaged app starts its daemon with the owner's login shell environment, since Finder gives none.
- The packaged macOS app updates itself from the GitHub releases of `OhMyJames/cycle`
  (`apps/desktop/src/update`): `plan.ts` and `updater.ts` are the decisions, `system.ts` what they do
  to the network and the disk. The main process looks for a newer release when its page is there,
  when the owner comes back to the app and every four hours, with the owner's GitHub token from their
  shell or `gh` when it has one, downloads it to
  `CYCLE_HOME/updates`, and checks it against the release's manifest (`src/shared/release.ts`). It
  replaces the app only when the owner clicks in Settings, About. A `v<version>` tag makes the release:
  `.github/workflows/release.yml`. Why:
  [decision note](.agents/notes/2026-11-13-updates-from-github-releases.md).

## Writing code

The expected load is one owner and one daemon running many sessions at once. Judge scale against that.

- Before writing, read the code the change touches and list every place it must reach: callers, tests,
  fixtures, configuration and exports. That is the scope; extra features are not.
- Take the first option that fully works: nothing at all, what the codebase already has, the platform
  or the standard library, an installed dependency, and only then new code. Check what codex app-server
  already offers before building it in the daemon.
- Work left for later is one comment, `shortcut: <the limit>; upgrade when <the trigger>`. The check
  refuses `TODO`, `FIXME`, `XXX`, `HACK` and a shortcut without its trigger.
- A reply on finished work ends with what was skipped or not checked, and any risk the owner must know.

## Conventions

- Dependencies are pinned to exact versions. Packages are imported by name, never by a relative path
  across packages or a deep path into one.
- Each package is typechecked under its own `lib` and `types`, which decide the platform APIs it sees.
- The design system is [.agents/designs/design-system.md](.agents/designs/design-system.md). Where the
  experience should differ from it, change it first, then every screen it covers.
- Icons are Cycle's own, in `packages/ui/src/components/icons.tsx`. No icon library.
- Components are Cycle's own too. A new interaction may be built on ui-sdk, a beta: how, and where
  Cycle's rules come before its skill's, is in [packages/ui/AGENTS.md](packages/ui/AGENTS.md).
- The interface is in US English. A choice list never shows a bare "Default": it names the choice and
  marks it, as "Auto (default)".
- Decision notes live in `.agents/notes/`, one file per decision, named `YYYY-MM-DD-what-was-decided.md`,
  with Status, Date, Basis, Problem, Decision, Alternatives considered and Consequences. Write one only
  for a storage or wire format, a security boundary, or a rejected approach likely to be proposed again.

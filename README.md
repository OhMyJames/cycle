# cycle

A desktop client for coding agents, built on [codex app-server](https://developers.openai.com/codex).
One owner, one daemon, many sessions at once. It is the successor of
[old-cycle](https://github.com/OhMyJames/old-cycle): the same design language and working habits, on a
smaller and faster base.

## Try it

```bash
bun install
```

```bash
bun run demo
```

The demo runs the whole app against a scripted stand-in for the model, in a throwaway project: no
account, no network. Open the link it prints. Ask it to "add a greeting" to see tools at work, or
mention "approval" to see it ask first.

With a real account: sign in with ChatGPT in Settings, add a model provider of your own there, or set
`OPENAI_API_KEY` first.

```bash
bun run dev
```

```bash
bun run web
```

`dev` opens the desktop app. `web` runs the daemon and prints a link for a browser.

## What it does

- **Sessions**: a list grouped by what needs you, what runs, pins and days; search; rename, pin, fork,
  archive, delete; unread marks; notifications when a session you are not watching stops or asks.
  Sessions started in the codex CLI appear too.
- **New session**: pick a folder, model, reasoning effort and permission mode; optionally a git
  worktree on a new branch.
- **Models**: your ChatGPT plan's models by signing in from Settings, and model providers of your own:
  Anthropic, Google, OpenRouter, DeepSeek and the other services [pi-ai](https://github.com/earendil-works/pi)
  knows, with your key, or any OpenAI- or Anthropic-compatible endpoint. You choose which models to
  use. A session stays with Codex's own models or with your providers', as codex requires.
- **Conversation**: streaming markdown with highlighted code and tables; commands, edits and tool calls
  folded into one line per stretch of work; reasoning; plans; approvals and questions inline; retry,
  copy, fork from any turn.
- **Composer**: `@` to find files, `/` for commands and skills, images by paste, drop or attach, drafts
  per session, prompt history. While a turn runs, Enter queues and ⌘Enter sends into the turn.
- **Panels**: Changes (diffs against a worktree's base or HEAD, commit), Files (tree, search, viewer),
  Terminal (real shells that outlive the panel), Overview (context, plan, MCP servers).
- **Command palette** (⌘K), settings, light and dark themes, usage per day.

## Architecture

```
apps/desktop (Electron)      apps/daemon (Bun)                  harness/codex            codex app-server
 main: starts the daemon  →   SessionHub: frames, queue     →    wire ↔ model         →   threads, turns, items
 page: packages/ui        ←   Git, Terminals, Files, usage  ←    its child processes  ←   exec, pty, fs, search
            └──────────── packages/protocol: model, wire methods, the shared reducer ────────────┘

 a second codex child, for the owner's model providers  →  packages/gateway: Responses API ↔ pi-ai  →  the provider
```

| Directory           | What it is                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `packages/protocol` | The model, the client-daemon wire, the `Harness` interface, the shared reducer               |
| `harness/codex`     | Drives `codex app-server` and translates it. The only code that knows codex                  |
| `packages/gateway`  | Answers codex for the owner's model providers, through pi-ai. The only code that knows pi-ai |
| `apps/daemon`       | Local daemon: session state, queueing, git, terminals, files, usage, serves the page         |
| `packages/ui`       | The page: stores, conversation, composer, panels                                             |
| `apps/desktop`      | Electron shell: starts the daemon, loads its page, a small native bridge                     |

[AGENTS.md](AGENTS.md) has the rules and the reasons; decisions are in [.agents/notes](.agents/notes).

## Compared with old-cycle

Measured on this branch with `bun run demo` in headless Chromium; old-cycle was read, not run, so its
column is what its code does, not a timing.

|                           | old-cycle                                       | cycle                                                 |
| ------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| Source                    | about 70,000 lines                              | about 12,000 lines                                    |
| Reconnect or switch back  | replays the session from its start              | only the frames missed (numbered frames, 512 kept)    |
| Daemon memory per session | every update since it opened, never trimmed     | folded state; idle sessions let go past 32            |
| Streamed reply            | whole thread selected and walked on every flush | one turn redrawn; markdown parses only the last block |
| A 116,000-character reply | not measured                                    | drawn in 0.5s; three tasks over 50ms, longest 133ms   |
| Typing in a long session  | not measured                                    | no frame over 17ms                                    |
| Opening a long session    | not measured                                    | 190ms to paint                                        |
| Prompt during a turn      | queued in the page                              | queued in the daemon, or steered into the turn        |
| Git, files, terminals     | the daemon's own processes                      | codex app-server's `exec`, `fs` and pty               |
| Browser as a client       | needs the separate server                       | the daemon serves the page                            |
| Command palette, pins     | no                                              | yes                                                   |
| Unit tests                | 30s budget                                      | 187 tests in 0.1s, same rules                         |

Not here yet, and in old-cycle: schedules, the per-project bot, the Connector (adding MCP servers,
signing in to them, plugins), the Browser panel and the agent's browser tools, the agent's terminal
tools, remote access from a phone, SSH to another Mac, packaging and auto-update, mermaid diagrams, the
per-turn context chart, and idle compaction. MCP servers are shown but not managed.

## Commands

| Command                    | What it does                                                    |
| -------------------------- | --------------------------------------------------------------- |
| `bun run check`            | The gate: lockfile, boundaries, format, types, lint, unit tests |
| `bun run test:integration` | The real codex app-server against a scripted model              |
| `bun run demo`             | The whole app with the scripted model                           |
| `bun run dev`              | The desktop app                                                 |
| `bun run web`              | The daemon and a link for a browser                             |

| Variable             | What it does                                                        |
| -------------------- | ------------------------------------------------------------------- |
| `CYCLE_HOME`         | Where Cycle keeps its data. Default `~/.cycle-codex`                |
| `CYCLE_DAEMON_PORT`  | The daemon's port. `0` picks a free one                             |
| `CYCLE_CODEX_BIN`    | The `codex` executable. Default: the `@openai/codex` dependency     |
| `CYCLE_CODEX_CONFIG` | JSON of `codex -c key=value` overrides, such as `{"model":"gpt-5"}` |
| `CYCLE_PAGE_URL`     | Makes the desktop app show a daemon that is already running         |
| `CYCLE_DEBUG=1`      | Prints codex app-server's log                                       |

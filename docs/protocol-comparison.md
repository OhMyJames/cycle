# Cycle's protocol beside three others

What Cycle's own protocol (`packages/protocol`) shares with the Claude Agent SDK, `codex app-server`
and the Agent Client Protocol (ACP), and what only some of them have. Read it with
[the glossary](glossary.md) and [the harness map](harness-interface.md).

This is an inventory, not a design. The last section lists what it suggests; none of it is decided.

## How it was made

Four readers, one for each source, each told to quote real names only.

- **Cycle**: `packages/protocol/src/*` as it is today.
- **Claude SDK**: the type definitions of `@anthropic-ai/claude-agent-sdk` 0.3.325. Nothing was run.
- **codex**: only what Cycle's harness calls or handles. The repo has no generated schema of the
  app-server, so this is Cycle's use of it, not all of it. A few names come from strings in the
  binary and are marked `(bin)`: they exist, their parameters are not known.
- **ACP**: the live spec, stable version 1. Version 2 is a draft and is noted where it differs.
  Source: <https://agentclientprotocol.com/protocol/overview>.

Marks: `✓` has its own name for it. `~` has it in another form (the cell says how). `—` not found in
what was read, which is weaker than "does not exist".

## Sessions

| Capability              | Cycle            | Claude SDK                                | codex                   | ACP v1                       | Kind   |
| ----------------------- | ---------------- | ----------------------------------------- | ----------------------- | ---------------------------- | ------ |
| create                  | `createSession`  | `query()`, option `sessionId`             | `thread/start`          | `session/new`                | core   |
| resume / load           | `loadSession`    | option `resume`                           | `thread/resume`         | `session/load`, `/resume`    | core   |
| list                    | `listSessions`   | `listSessions`                            | `thread/list`           | `session/list` (optional)    | core   |
| delete                  | `deleteSession`  | `deleteSession`                           | `thread/delete`         | `session/delete` (optional)  | core   |
| fork                    | `forkSession`    | `forkSession(upToMessageId)`              | `thread/fork`           | — (draft proposal only)      | 3 of 4 |
| rename                  | `renameSession`  | `renameSession`                           | `thread/name/set`       | — (agent sets its own title) | 3 of 4 |
| archive                 | `archiveSession` | `archiveSession`                          | `thread/archive`        | — (draft proposal only)      | 3 of 4 |
| tag                     | `tagSession`     | `tagSession`                              | —                       | —                            | Claude |
| compact                 | `compactSession` | — (no method; only events and hooks)      | `thread/compact/start`  | ~ updates only               | codex  |
| rewind the conversation | `rewindSession`  | ~ `resumeSessionAt`, fork up to a message | `thread/revert`         | —                            | 2 of 4 |
| rewind the files        | `rewindFiles`    | `rewindFiles` (needs checkpointing)       | — (Cycle sets it false) | —                            | Claude |

## A turn

| Capability                    | Cycle                        | Claude SDK                                           | codex                     | ACP v1                       | Kind   |
| ----------------------------- | ---------------------------- | ---------------------------------------------------- | ------------------------- | ---------------------------- | ------ |
| send a prompt                 | `send`                       | `query` input / `streamInput`                        | `turn/start`              | `session/prompt`             | core   |
| stop it                       | `interrupt`                  | `interrupt()`                                        | `turn/interrupt`          | `session/cancel`             | core   |
| add input mid-turn            | `steer`, daemon queue        | ~ `priority` now/next/later (undocumented)           | `turn/steer`              | — (v2 draft: yes)            | 3 of 4 |
| prompt content                | text, images, pdf, text docs | text, image, document                                | text, image, local image  | text, image, audio, resource | core   |
| review code                   | `review`                     | —                                                    | `review/start`            | —                            | codex  |
| change mode/model/effort live | `configure`                  | `setPermissionMode`, `setModel`, `applyFlagSettings` | per turn, on `turn/start` | `session/set_config_option`  | core   |

## What streams back

| Capability                 | Cycle                           | Claude SDK                                   | codex                                     | ACP v1                                       | Kind                     |
| -------------------------- | ------------------------------- | -------------------------------------------- | ----------------------------------------- | -------------------------------------------- | ------------------------ |
| message and reasoning text | `agentMessage`, `reasoning`     | `stream_event`, thinking                     | `item/agentMessage/delta` etc.            | `agent_message_chunk`, `agent_thought_chunk` | core                     |
| a command ran              | `command` item                  | ~ a `Bash` tool use                          | `commandExecution` item                   | ~ `tool_call` kind `execute`                 | core, shaped differently |
| a file changed             | `fileChange` item               | ~ an `Edit` or `Write` tool use              | `fileChange` item                         | ~ `tool_call` kind `edit`, `diff` content    | core, shaped differently |
| an MCP tool was called     | `toolCall`                      | tool use                                     | `mcpToolCall`                             | `tool_call`                                  | core                     |
| the plan                   | `plan`, `plan.updated`          | plan mode, `ExitPlanMode`                    | `turn/plan/updated`                       | `plan`                                       | core                     |
| helper agents and tasks    | `task`, `agentActivity`         | `task_*` messages                            | `collabAgentToolCall`, `subAgentActivity` | —                                            | 3 of 4                   |
| tokens and context         | `usage.updated`, `ContextUsage` | `result.usage`, `getContextUsage`            | `thread/tokenUsage/updated`               | `usage_update`                               | core                     |
| plan limits (5h, 7d)       | `limits.changed`                | `rate_limit_event`, `usage()` (experimental) | `account/rateLimits/*`                    | —                                            | 3 of 4                   |
| compaction happened        | `compaction` item               | `compact_boundary`                           | `contextCompaction` item                  | `compaction_update`                          | core                     |
| notices, retries, errors   | `notice`                        | `api_retry`, `result` subtypes               | `error`, `warning`                        | `notice`                                     | core                     |
| what to send next          | `suggestion.changed`            | `prompt_suggestion`                          | —                                         | —                                            | Claude                   |
| the turn's diff            | `diff.updated`                  | —                                            | `turn/diff/updated`                       | —                                            | codex                    |

## Asking the owner

| Capability                        | Cycle                                     | Claude SDK                                                      | codex                                     | ACP v1                                | Kind                         |
| --------------------------------- | ----------------------------------------- | --------------------------------------------------------------- | ----------------------------------------- | ------------------------------------- | ---------------------------- |
| ask before a tool                 | `approval.requested`                      | `canUseTool`                                                    | `item/*/requestApproval`                  | `session/request_permission`          | core                         |
| the answer                        | accept, acceptForSession, decline, cancel | allow or deny, plus rule updates                                | accept, acceptForSession, decline, cancel | allow/reject, once/always             | core, other words            |
| a question with options           | `question.requested`                      | `AskUserQuestion` through `canUseTool`                          | `item/tool/requestUserInput`              | —                                     | 3 of 4                       |
| an MCP server asks (form or link) | `question.requested`                      | `onElicitation`                                                 | `mcpServer/elicitation/request`           | `elicitation/create`                  | core                         |
| permission modes                  | per agent, `listModes`                    | 6: default, acceptEdits, plan, auto, dontAsk, bypassPermissions | approval policy + sandbox policy + plan   | modes, becoming a config option in v2 | core idea, different content |
| the mode that never asks          | `dangerous` flag                          | `bypassPermissions` + a start flag                              | never + full access                       | —                                     | 3 of 4                       |

## Models

| Capability                | Cycle                  | Claude SDK                                   | codex                            | ACP v1                                  | Kind  |
| ------------------------- | ---------------------- | -------------------------------------------- | -------------------------------- | --------------------------------------- | ----- |
| list models               | `listModels`           | `supportedModels()`                          | `model/list`                     | config option, category `model`         | core  |
| reasoning effort          | a string, `efforts[]`  | option `effort`; live by `applyFlagSettings` | per turn, `effort`               | config option, category `thought_level` | core  |
| the owner's own providers | gateway, `providers.*` | — (env and gateway settings)                 | one `model_provider` per process | — (draft proposal)                      | Cycle |

## What an agent is given

| Capability               | Cycle                                  | Claude SDK                                        | codex                                      | ACP v1                                     | Kind                        |
| ------------------------ | -------------------------------------- | ------------------------------------------------- | ------------------------------------------ | ------------------------------------------ | --------------------------- |
| MCP servers              | Connector, global                      | option `mcpServers`, `setMcpServers`, per process | `config.toml`, `config/batchWrite`, global | `mcpServers` on `session/new`, per session | core, but the scope differs |
| MCP status, reconnect    | `listMcpServers`, `reconnectMcpServer` | `mcpServerStatus`, `reconnectMcpServer`           | `mcpServerStatus/list`                     | —                                          | 3 of 4                      |
| MCP sign-in              | `loginMcpServer`                       | — (only a `needs-auth` status)                    | `mcpServer/oauth/login`                    | —                                          | codex                       |
| plugins, marketplaces    | `listPlugins` etc.                     | option `plugins`, `reloadPlugins`                 | `plugin/*`, `marketplace/*`                | —                                          | 2 of 4                      |
| skills                   | `listSkills`, `enableSkill`            | `skills`, `reloadSkills`                          | `skills/list` (turning off not supported)  | —                                          | 2 of 4                      |
| slash commands           | `commands.list`                        | `supportedCommands()`                             | —                                          | `available_commands_update`                | 3 of 4                      |
| hooks                    | 9 events                               | 33 events, callbacks                              | — (`hooks/list` (bin))                     | —                                          | Claude                      |
| helper-agent definitions | `listSubagents`                        | option `agents`, `supportedAgents()`              | `features.multi_agent` switch only         | —                                          | Claude                      |

## Settings, account, machine

| Capability                          | Cycle                                | Claude SDK                                                    | codex                                     | ACP v1                                    | Kind          |
| ----------------------------------- | ------------------------------------ | ------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- | ------------- |
| settings layers                     | four (glossary)                      | `settingSources`: user, project, local, plus a flag layer     | `config.toml` in `CODEX_HOME`             | none                                      | per agent     |
| change settings live                | `setHooks`, `setFeatures`, Connector | `applyFlagSettings`, `updateSettings`                         | `config/batchWrite` + reload              | config options                            | per agent     |
| what only a restart sets            | `processSpec`, `startKey`            | `cwd`, `env`, `hooks`, `agents`, `sandbox`, `settingSources`… | `-c` overrides, `model_provider`, catalog | —                                         | Claude, codex |
| sign in, sign out                   | `login`, `logout`                    | — (its own CLI does it)                                       | `account/login/*`, `logout`               | `authenticate`, `logout`                  | 3 of 4        |
| account info                        | `readAccount`                        | `accountInfo()`                                               | `account/read`                            | —                                         | 3 of 4        |
| run a command, read files, terminal | `Machine`                            | — (only through the model's own tools)                        | `command/exec`, `fs/*`, pty               | client's `fs/*`, `terminal/*`, gone in v2 | codex         |

## ACP: version 1 and the version 2 draft

The tables above use version 1, the stable one. Version 2 is a draft (announced 2026-07-20, schemas
tagged `schema-v2.0.0-alpha.N`); a connection chooses its version with `protocolVersion`, and the
authors advise supporting both and not turning v2 on by default before it settles. Sources:
[announcement](https://agentclientprotocol.com/announcements/acp-v2-draft),
[migration guide](https://agentclientprotocol.com/protocol/v2/migration),
[prompt proposal](https://agentclientprotocol.com/rfds/v2/prompt).

**Why it exists.** Some changes that would let the protocol express more session states could not be
made without breaking v1. The prompt proposal names what v1 could not say: a queued message (does it
start a turn or join one?), work an agent starts or continues with no prompt (a background subagent
after its turn), replaying a running session (the end of a turn has no replay), and matching a
submission to a message when several clients share a session.

| Part                 | v1                                                | v2 draft                                                                                |
| -------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `session/prompt`     | answers when the turn ends, with `stopReason`     | answers when the message is inserted, with `messageId`                                  |
| end of a turn        | the prompt's answer                               | a `state_update`: `running`, `idle` (with a stop reason), `requires_action`             |
| a prompt mid-turn    | not defined                                       | must not be refused: inserted now or queued, in order                                   |
| `session/update`     | during a turn                                     | at any time                                                                             |
| a failure            | an error on the prompt                            | the prompt still succeeds; `idle` with `stopReason: "error"`                            |
| updates              | chunks, whole items                               | patches by stable id: omit keeps, `null` clears, value replaces, chunk appends          |
| modes                | `session/set_mode`, `modes`                       | gone: a config option of category `mode`                                                |
| `fs/*`, `terminal/*` | the client's, optional                            | removed ("inconsistently implemented outside of a few IDEs")                            |
| load and resume      | `session/load` replays, `session/resume` does not | `session/resume` with `replayFrom`: a snapshot, or a replay ending in `replay_complete` |
| tool calls           | `tool_call`, then updates                         | the first `tool_call_update` creates it                                                 |
| permission asks      | carry a tool call                                 | `title`, `description`, `subject` (a tool call or a command)                            |
| diffs                | `path`, `oldText`, `newText`                      | `changes` (add, delete, modify, move, copy) and an optional git patch                   |
| helper agents        | none                                              | `subagent_update`, `session_message`, state of the child's session                      |
| extensibility        | custom `_` names for methods                      | open enums: unknown values use `_`; booleans become `{}` markers                        |

Not settled in the sources: how a v2 `state_update` maps onto Cycle's `SessionActivity`
(`idle|running|requires_action`, with `loaded` and `failed` beside it), and which parts of the draft will change before it stabilizes.

## Only Cycle

Not in any of the three: numbered frames and replay (`EventFrame`, `session.open after`), the daemon's
prompt queue, schedules, worktrees, git and file views, sandbox environments, pin, unread, the page's
`Settings`, the connection token and its checks.

## What this suggests

These are readings of the tables, to be argued with, not decisions.

1. **The shared core is small and clear.** Create, resume, list, delete; send, stop; streamed text,
   reasoning, tool calls, plan, usage; ask and answer; list models and modes; MCP servers. All four
   have these. This is what `Agent` should be, and nothing else needs to be in it.
2. **Cycle's shapes are codex's.** Its item kinds (`command`, `fileChange`, `toolCall`) are codex's
   `commandExecution`, `fileChange`, `mcpToolCall`; its approval answers are word for word codex's.
   The Claude SDK and ACP see a generic tool call with a name or a `kind`. Claude is mapped into
   codex's shape. That is why `harness/claude/src/translate.ts` is so large, and a third agent would
   meet the same wall.
3. **ACP puts mode, model and effort in one idea.** A _config option_: an id, a category (`mode`,
   `model`, `thought_level`), a list of values, a current one. The agent declares them; the client
   sets one by id. Cycle spells the same three things in `ModeInfo`, `ModelInfo`, `TurnOptions` and
   `ConfigureOptions`, four lists to keep equal. This is the closest answer in these sources to
   "session options are written four times".
4. **A restart rule is the SDK's, not Cycle's.** Most of Claude Code's settings can be set only as its
   process starts. `processSpec` and `startKey` exist because of that. It should stay inside
   `harness/claude` and not shape the protocol.
5. **Machine is codex's alone, and says so.** The SDK has none, ACP gives it to the client and drops it
   in v2. Keeping it as a part of a harness is a choice only codex makes easy.
6. **The Connector's scope differs.** codex and Cycle: one global configuration. The SDK: per process.
   ACP: per session. A shared `Connector` has to say which.
7. **Optional session features are many.** Fork, rename, archive, tag, rewind, compact, review: each
   is held by two or three of four. They fit capability flags, as today; the flags and the optional
   methods should then be one thing (see the harness map, item 4).
8. **Hooks are Claude's.** Cycle shows 9 of the SDK's 33 events. No other source has hooks.

## What this did not check

- codex is only as far as Cycle uses it. Its other methods may cover more.
- ACP version 2 is a draft and moves. Capability key names in its session-setup page were
  inconsistent and were not checked against the schema.
- For the SDK, nothing was run. Whether sending `/compact` as a prompt works was not confirmed, and
  the semantics of `priority` are not documented in the types.
- The "shaped differently" marks come from names, not from reading how Cycle's `translate.ts` maps them.
- No code was changed.

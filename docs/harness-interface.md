# The harness interface: a reading map

A guide to read beside `packages/protocol/src/harness.ts` (314 lines). It says what is in the file
and where the words of [the glossary](glossary.md) do not yet fit it. Every line number is that
file's. Nothing here is a plan; it describes the file as it is.

## The shape

```
Harness  (one per agent; line 288)
 ├─ Agent      sessions, turns, models, modes        line 151
 ├─ Connector  MCP servers, plugins, and more        line 230
 ├─ Account    sign-in with the agent's own service  line 262
 └─ Machine    files, commands, terminals            line 275

Agents  (what the daemon holds; line 295)
   every agent's Agent part, joined, plus
   connector(name?) / account(name?)   chosen by the agent's name, the main one's by default
   Machine                             the main agent's alone
```

Codex gives all four. Claude Code gives an `Agent`, a Connector it may edit when its capabilities say
`connector: edit` (`AgentReads`, line 224; routed in `apps/daemon/src/harnesses.ts`), and `readAccount`
only: sign-in and sign-out are refused. What an agent leaves out is refused, never done by codex in
its place.

## What each part holds

**Agent** (lines 151-218)

| Group    | Methods                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| life     | `start`, `dispose`, `onEvent`                                                                                                                        |
| sessions | `createSession`, `listSessions`, `loadSession`, `forkSession`, `renameSession`, `archiveSession`, `deleteSession`, `compactSession`, `rewindSession` |
| a turn   | `send`, `review`, `steer`, `interrupt`, `respondApproval`, `answerQuestion`, `configure`                                                             |
| choices  | `listModels`, `listModes`                                                                                                                            |
| optional | `tagSession`, `stopTask`, `rewindFiles`, `listCommands`, `readContext`                                                                               |

**Connector** (lines 230-259)

| Group         | Methods                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| MCP servers   | `listMcpServers`, `putMcpServer`, `removeMcpServer`, `enableMcpServer`, `enableMcpTool`, `loginMcpServer`, `reconnectMcpServer`? |
| plugins       | `listPlugins`, `readPlugin`, `installPlugin`, `uninstallPlugin`, `enablePlugin`, `addMarketplace`, `removeMarketplace`           |
| skills        | `listSkills`, `enableSkill`                                                                                                      |
| hooks         | `readHooks`, `setHooks`                                                                                                          |
| helper agents | `listSubagents`?                                                                                                                 |
| features      | `readFeatures`, `setFeatures`                                                                                                    |

A `?` is a method the type marks optional. `enableSkill`, `readHooks` and `setHooks` are not marked,
but the file says they come "with the `hooks` capability".

**Account** (262-268): `readAccount`, `login`, `cancelLogin`, `logout`.
**Machine** (275-281): `exec`, `readDirectory`, `readFile`, `searchFiles`, `openTerminal`.

## Where the file and the glossary differ

Read these against the glossary. Each one is a place the words are not yet one meaning.

1. **"sandbox" was three fields in one file.** _Done_ (step 09): `TurnOptions.environment` is the
   environment's _id_, the one field that says where a session runs, and the container's _name_
   (`HarnessSession.sandbox`, `TurnOptions.sandbox`, `CreateSessionOptions.sandboxed`) is gone from
   the interface: the harness derives it. What is left is `sandboxCwd`, a path inside the container,
   and `ModelInfo.sandbox`, whether a model can run in one (step 17).
2. **Session options are written four times.** `TurnOptions` (50), `ConfigureOptions` (61),
   `CreateSessionOptions` (67) and the fields of `HarnessSession` (29) each list some of model,
   effort, mode, sandbox and directories, and not the same ones. A new per-session option has to be
   added to each that applies. _Started_ (step 18, first pull request): `Sessions.options()` gives them as
   one list, beside these fields; they are written once when the last pull request removes them.
3. **The Connector holds more than the glossary's Connector.** It has skills (231, 254), hooks
   (256, 258), helper agents (241) and features (251-252) beside MCP servers and plugins. By the
   glossary only the first two belong.
4. **What an agent can do is said twice: a flag and a method.** `AgentCapabilities`
   (`model.ts:538-561`) has eleven fields (nine are flags; `attachments` is a list and `connector` is `edit` or `read`). Seven methods here are marked optional (`tagSession`,
   `stopTask`, `rewindFiles`, `listCommands`, `readContext`, `listSubagents`,
   `reconnectMcpServer`). Five of those have a flag of their own (`tags`, `rewindFiles`,
   `commands`, `subagents`, `mcpReconnect`); `stopTask` and `readContext` have none. The `hooks`
   and `features` flags gate methods the type does not mark optional. Nothing in this file ties a
   flag to its method.
   _Today_ (step 17): `Sessions.declaration` (`AgentDeclaration`) says the same by operation id, beside
   `capabilities`, and a test of each harness says a method is there exactly when its id is declared.
   Nothing reads it yet; the two go to one in the steps that follow.
5. **`HookSettings` is the type of `readHooks` and `setHooks`** (256, 258), and carries the process
   limits too (see the glossary). The name says hooks; the content says more.
6. **`HarnessEvent` is two sets on one stream.** `AgentSessionEvent` is what an agent says of a
   session (a `SessionEvent`, and `session.changed`, `mode.changed`, `commands.changed`,
   `suggestion.changed`); `AgentEvent` is what it says of itself (`mcp.changed`, `account.changed`,
   `limits.changed`, `agent.exited`). The port stays one stream, `onEvent`, and the daemon's
   `handle` splits on `"sessionId" in event`.
7. **`Agent` is both the program's name and this interface** (line 151). The glossary names the
   interface `Sessions`.
8. **The `Machine` is the main agent's alone.** An agent beside it has none: its files, commands and
   terminals are the main agent's (`Agents` extends `Machine`, 295-298).

## Questions to read with

- Which two of the four option lists in (2) could be one record?
- Is a skill, a hook or a helper agent something an agent _is given_ (Connector) or something an
  agent _does_ (behavior)? The glossary says the second. Then which part holds it?
- Does an event name its session, or the harness, or neither? Would two unions be clearer?
- Where must a flag and its optional method be kept equal today, and what checks it?

## Not checked

This map is from this one file. It does not say how `model.ts` defines the types named here, nor
how the daemon or the two harnesses use them.

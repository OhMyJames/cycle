# Agent Note: Helper agents and background work are tasks, and a turn says who began it

Status: accepted
Date: 2026-11-16
Basis: `@anthropic-ai/claude-agent-sdk` 0.3.325's `sdk.d.ts`, and the stream of the real Claude Code
2.1.325 against the scripted model (`mock-claude.ts`): a helper agent, a command in the background,
a stopped task, and a stored session read back with `getSubagentMessages`.

## Problem

The protocol was written for codex: a turn is one prompt of the owner's and a flat list of items.
Claude Code nests. A helper agent (the `Agent` tool) does work of its own, which the SDK sends with
`parent_tool_use_id`; Claude Code 2.1.325 runs every helper in the background unless the call says
otherwise, so that work goes on after the turn that started it ended. A command can run in the
background too. When such a task ends, Claude Code begins a turn by itself to take up its news, with
no prompt of the owner's. Cycle dropped all of it: what helpers did, the turns they caused (their
messages came while no turn ran), and any way to stop one task without stopping the turn.

## Decision

- **A `task` item.** Work the agent handed off is an item of the turn that started it: what it is
  (`agent`, `command`, `workflow`, `other`), its description, the helper's kind, the prompt, a
  `TaskStatus` of its own (`pending`, `running`, `paused`, `completed`, `failed`, `stopped`), whether
  it is in the background, its usage, the latest summary and an error. Its id is the id of the tool
  call that started it, when that call is a helper's; a command in the background is a task beside
  its call, `task:<id>`.
- **Nesting by `parentId`.** Every item may name the task it was done in. It stays in the flat list of
  its task's turn, so `reduceSession`, frames and the 16ms batching are unchanged: an item is put in
  by id, and a delta finds it by id. A view groups a turn's items by `parentId`.
- **A task outlives its turn.** The fold that ends a turn's running items at `turn.completed` leaves
  tasks and their items alone; a task that ends ends what it left running. News of a task that comes
  after its turn changes that turn, and only that turn gets a new identity: a streamed chunk still
  redraws one turn.
- **The session's tasks in the background**, `tasks.updated`, replacing the list each time, as Claude
  Code's `background_tasks_changed` does. It belongs to no turn. `session.stopTask` stops one; Claude
  Code is started with `perTaskStopAffordance`, so stopping a turn leaves those tasks running.
- **`Turn.origin`**: the owner (said by leaving it out), a schedule, a task's news, another session,
  or the agent for a reason it does not say. A turn the agent begins by itself starts when its first
  message comes while no turn runs; the daemon then queues the owner's prompts behind it as behind
  any turn. The daemon marks a turn its scheduler asked for.
- **Codex keeps `agentCall` and `agentActivity`.** A codex helper is a thread of its own that a call
  reaches (spawn, send, wait, close, to several at once), not work inside this turn. Folding it into
  `task` would lose the receivers and the kind of call; its items are not in this session's stream to
  nest.

## Alternatives considered

- **Tasks as a nested `items` array inside the task item.** Rejected: every delta and every item would
  need a path to its place, and the reducer, the coalescing of deltas and the page's per-turn layout
  cache would all change. A flat list with `parentId` keeps all three.
- **A task's items in a turn of their own, or in the turn running when they come.** Rejected: the work
  would be cut from the task the owner sees started it, and a turn of the agent's own would seem to do
  work it never asked for.
- **Loading a helper's work only when the owner opens its task.** Not yet: a stored session reads every
  helper's conversation as it opens (`getSubagentMessages`), and a task's work is mounted only when
  it is opened. This becomes worth it when sessions with many helpers open slowly.
- **`agentProgressSummaries`.** Left off. It forks each helper's conversation every ~30 seconds for a
  model-written line, which costs requests against the owner's limits for every helper at once.
  `task_progress` already says what a helper does now ("Running ls") for nothing.

## Consequences

- A Claude Code process with a task in the background is not idle: it is not closed after five idle
  minutes, since that would stop the task. A prompt with another mode, model or effort is refused
  while one runs, saying why, rather than starting Claude Code again: what a mode lets run unasked is
  set as the process starts, so it is not changed in place. An archive or a crash stops its tasks,
  and they are shown stopped.
- A turn the agent began by itself is known by its first whole message, the one id it shares with
  storage: the news that began it never comes on the stream. What streamed before that message waits
  for it. Stored, the news is where the turn begins, so going back to it cuts before the news.
- News that came while a turn ran is part of that turn in storage. It is told apart from news that
  began a turn by how the turn before it ended: an interruption, or a stop of the agent's that is not
  a call for tools.
- If the owner's prompt goes in just as the agent begins a turn by itself, Claude Code runs the agent's
  first: its end is not taken as the end of the owner's turn, but its work shows in the owner's turn.

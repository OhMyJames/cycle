# Agent Note: Options are one declared list, read apart from the declaration

Status: proposed. The owner reviews the stored format below before the pull request that writes it
(`refactor/options-store`) starts; nothing is written to a stored file before then.
Date: 2026-11-18
Basis: the owner's decision of 2026-11-17 that an agent's options are one declared list
([operations](../../docs/operations.md), "The declaration"; [entities](../../docs/entities.md), "Option"),
ACP's config option as the model of it, and the code of main at `d015cf0`. Step 18 of the migration to
[the entities](../../docs/entities.md). Follows
[an agent declares what it can do by operation](2026-11-18-an-agent-declares-what-it-can-do-by-operation.md).

This replaces part of [a session's mode is one its agent offers](2026-11-16-session-modes-are-the-agent-s-own.md):
the first paragraph of its Decision (`Agent.listModes`, `ModeInfo`, wire `modes.list`) and its bullet
"`settings.json` keeps the mode new sessions start in for each agent (`Settings.modes`)". What stays of it,
and is kept here: stored values are read by what they meant then (`legacy:`), a mode is kept with its agent,
an agent's own word never puts a session in a mode that never asks, and a value the agent does not offer is
its default.

## Problem

What a session chooses of its agent is three fixed fields, `mode`, `model` and `effort`, and each is written
in six places: the agent contract (`TurnOptions`, `ConfigureOptions`, `AgentSession`), the wire
(`session.create`, `session.update`, `Session`, `Settings`, `ScheduleInput`), `sessions.json`,
`settings.json`, `schedules.json` and the page's draft. They are declared by two methods with no common shape
(`listModes()`, synchronous and fixed; `listModels()`, asynchronous and changing) and drawn four ways: the
composer's model picker and mode menu, Settings' two controls and the schedule editor's own two. A fourth
choice an agent offers would need a field in each place.

Two of the three are not what they look like. The effort is not an option of its own: it is `efforts` and
`defaultEffort` of each model, so what a session may choose depends on the model it has. And the model is the
one whose value picks the agent: a session stays with the agent its model names.

## Decision

**One type, in `packages/protocol/src/option.ts`.** An `Option` has an `id`, a `category` (`mode`, `model`,
`effort`, or an agent's own), a `name`, a `description` and `values`. A value has an `id`, a `name`, a
`description`, and `default`, `dangerous`, `plan`, `replaces`, `provider` and `under`. Decisions about it:

1. **The category is `effort`**, not ACP's `thought_level`: [operations](../../docs/operations.md) says
   `effort`, and so does the page. `docs/entities.md` is corrected.
2. **`under` carries a model's efforts.** The page needs them before a session exists (the draft), so a flat
   list that is resent after each change, as ACP's is, is not enough: a model value holds
   `under: [{ id: "effort", category: "effort", values }]`, with the model's default effort `default: true`.
   That one change of a value changes another option's values is answered by the daemon's reply to
   `session.update`, which will be the whole `Session.options`.
3. **There is no `applies`.** [operations](../../docs/operations.md) rule 4 asks an option to say when a change
   takes effect. Nothing reads it today and step 17 left `machine` out for the same reason: it is added with
   its first reader. What is known for it: codex takes all three with the next turn; Claude Code takes them
   now, mid-turn, except a mode a process's start decides (its command sandbox,
   `allowDangerouslySkipPermissions`), which waits for the next process.
4. **`images` is dropped and `sandbox` leaves the value.** `ModelInfo.images` has no reader in the page or the
   daemon: `git grep` finds only a prompt's attached images and the provider form's own `ProviderModel.images`,
   which stay. `ModelInfo.sandbox` is a fact of the agent ("some model of it can"), read to offer a
   container; step 10 gives the declaration `environments` and the page reads it there. Until then nothing
   reads options, and `ModelInfo` keeps both.
5. **`harness` is not on a value**: an option belongs to the agent whose list holds it.
6. **`replaces` stays on `mode` values** as migration data (`legacyMode`, `resolveMode`), with a `shortcut:`
   comment: read while a daemon from before 2026-11-16 may have written the file; upgrade when two releases
   have shipped.
7. **`defineOption` is the one constructor.** It fills what a value did not say and **throws** when a
   `dangerous` value is the default, or an option has two defaults. Both agents' lists go through it, so the
   red line that the mode that never asks is never a default is a test of the type, not of each list.

**Options are read apart from the declaration**, not inside `AgentDeclaration` as
[operations](../../docs/operations.md) drew it. A model list is asynchronous, changes with the owner's
providers and account, and can fail; the declaration is a synchronous field. The agent contract gets
`Sessions.options(): Promise<Option[]>`, which replaces `listModels` and `listModes` once nothing reads them
(`refactor/options-remove`). The daemon's `Agents.options()` answers one list for each agent, the main one
first; the main agent's failure is an error, another agent's is logged and its options left out, as
`Harnesses.listModels` does. Only the main agent's models are a default of a new session today
(`Harnesses.listModels` clears `isDefault` on the others); in the list each agent keeps its own `default`,
and `daemon.info` says which agent is the main one.

**The wire**, added in this note's first pull request and the next, and removed in the last:

|                                                                           | Today                                    | Added                                                                                                                                    | Removed at the end |
| ------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `options.list`                                                            | none                                     | `{} -> { agents: { agent, options }[] }`                                                                                                 |                    |
| event `options.changed`                                                   | none                                     | `{ agent, options }`, sent where `models.changed` is                                                                                     |                    |
| `models.list`, `modes.list`, `models.changed`                             | `{ models }`, `{ modes }`, `{ models }`  | kept beside                                                                                                                              | removed            |
| `session.create`                                                          | `model?, effort?, mode?`                 | `options?: Record<string, string>`                                                                                                       | the three          |
| `session.update`                                                          | `model?, effort?: string \| null, mode?` | `options?: Record<string, string \| null>`                                                                                               | the three          |
| `Session`                                                                 | `model, effort, mode`                    | `options: Record<string, string \| null>`: `model` and `mode` always, `effort` when the model has one, `null` when it is the model's own | the three          |
| `Settings`                                                                | `model, effort, modes`                   | `options: Record<agent, Record<id, string>>` for every option but model and effort                                                       | `modes`            |
| `ScheduleInput`, `Schedule`                                               | `model, effort, mode, modeHarness?`      | `options?: Record<string, string>`; `modeHarness` keeps its name                                                                         | the three          |
| harness event                                                             | `mode.changed { sessionId, mode }`       | `option.changed { sessionId, option, value }`                                                                                            | `mode.changed`     |
| `TurnOptions`, `ConfigureOptions`, `CreateSessionOptions`, `AgentSession` | `model, effort, mode`                    | `options?: Record<string, string \| null>`                                                                                               | the three          |

A page and its daemon are one pair, so the daemon accepts and sends both forms until the page moves, and no
alias outlives the removal. The field is `agent`, the glossary's word, on what is new; `modeHarness` keeps its
name, since a stored key is not renamed in the change that renames code.

**The stored format, which the owner reviews.** Every file keeps reading what older daemons wrote; a key is
never renamed in the same change as the code that renames it: the new key is written, the old ones are read
and never written again and never deleted (as `sandbox` was for `environment`). So an "After" below is a record
the new daemon makes; a record that already has old keys keeps them, beside `options`, which wins when both
are there. **A**, a map of option id to value, is proposed.

`sessions.json`, one session. Before, a session of today and one from before 2026-11-16:

```json
{
  "s1": { "agentMode": "acceptEdits", "model": "claude-sonnet-5-5", "effort": null },
  "s0": { "mode": "auto" }
}
```

After, a session the new daemon made (`s2`), and `s1` and `s0` as the new daemon leaves them once the owner
changed the mode of each to `plan`:

```json
{
  "s2": { "options": { "mode": "acceptEdits", "model": "claude-sonnet-5-5", "effort": null } },
  "s1": {
    "agentMode": "acceptEdits",
    "model": "claude-sonnet-5-5",
    "effort": null,
    "options": { "mode": "plan", "model": "claude-sonnet-5-5", "effort": null }
  },
  "s0": { "mode": "auto", "options": { "mode": "plan" } }
}
```

Read: `options.mode` over `agentMode` over the legacy `mode` (still marked `legacy:`); `options.model` over
`model`; `options.effort` over `effort`, where `null` is a value (the model's own) and absence is "ask the
agent". A record is not rewritten by being read: the next change of it writes `options`, from what was read and what
changed, and leaves the old keys where they are (`s1` and `s0` above, whose old `agentMode` and `mode` are now
stale). A key is written only for what the owner chose or the agent moved: `model` and
`effort` only when chosen, `mode` always at create, as today. A fork copies `options` as it copies the three
today, which leaves out an effort of `null` (pinned: the copy then asks the agent).

`settings.json`. Before:

```json
{
  "model": "gpt-5.5",
  "effort": "high",
  "modes": { "codex": "auto", "claude": "acceptEdits" },
  "mode": "auto",
  "worktree": false,
  "projects": []
}
```

After: `model` and `effort` stay top-level, since they are the owner's one usual model (the composer writes
them with each choice) and a model picks the agent, so they are not one agent's option. `modes` becomes
`options` by agent, for every other option, and the new daemon stops writing `modes`:

```json
{
  "model": "gpt-5.5",
  "effort": "high",
  "options": { "codex": { "mode": "auto" }, "claude": { "mode": "acceptEdits" } },
  "modes": { "codex": "auto", "claude": "acceptEdits" },
  "mode": "auto",
  "worktree": false,
  "projects": []
}
```

(`modes` and `mode` are as the file from before has them.) Read: `options[agent].mode` over `modes[agent]`
over the legacy `mode`, then the agent's default. `settings.set` checks each pair against the agent's options
and refuses an unknown mode as today ("<agent> has no mode named X.").

`schedules.json`, one schedule. Before:

```json
{
  "id": "...",
  "model": "gpt-5.5",
  "effort": null,
  "mode": "auto",
  "agentMode": "auto",
  "modeHarness": "codex"
}
```

After:

```json
{ "id": "...", "options": { "model": "gpt-5.5", "mode": "auto" }, "modeHarness": "codex" }
```

`model`, `effort`, `mode` and `agentMode` are read when `options` is absent and are not written: a schedule
the new daemon makes has none, and one it changes keeps the old keys it had, stale beside `options`. A schedule's
`null` means "follow what new sessions start with", which here is an absent key; a schedule cannot say "the
model's own effort", as it cannot today.

**What a rollback costs.** A daemon from before this change reads the old keys and no `options`, so it reads
what the record held before the new daemon last changed it, or nothing for a record the new daemon made.

- A session the new daemon made, and a schedule: its mode reads as its agent's default, and its model and
  effort overrides are not seen (the agent keeps its own record of both: `meta.model ?? session.model`). A
  schedule's model and effort read as absent, which is "follow what new sessions start with".
- A session or schedule that had old keys and was changed since: it reads **what the old keys last said**,
  not what the owner chose last. That can be an earlier choice, **including a mode that never asks** if the
  owner had picked one before and moved off it since. `settings.json` is the same: `modes` is no longer
  written, so a rolled-back daemon starts new sessions in the mode last written there, which the owner may
  have chosen and left (the Settings menu offers a mode that never asks today). `model` and `effort` stay
  where they were and lose nothing.
- Nothing is lost for a record the new daemon did not change.

So a rollback loses a choice, and can bring an earlier one back, but it does not invent one: no default is a
mode that never asks. **The owner decides**: keep the old keys stale, as proposed (the rule above, and what
the plan says of every stored file), or have the new daemon **remove** a record's old keys when it writes
`options` into it, so that a rollback reads the agent's default and never an earlier choice. The cost of
removing is that an older daemon then reads less than it could, and the rule above becomes "never written
again" only. Not checked: whether an older page tolerates the absent keys on a schedule the wire carries;
and two daemons on one `CYCLE_HOME` writing both forms at once.

**The rules the list keeps**, each pinned by a test before this change (`option-pins.test.ts` in the
protocol, daemon, codex and Claude packages and the page): a mode is one agent's, so the same id can be two
modes and a stored mode is read with its agent; a mode the owner names that the agent does not offer is
refused and a stored one is read as the default; a model and an effort are not validated, and a new option
is strict (an unknown value is refused, since there is nothing to preserve); a model change keeps the family
(an agent's own, or the owner's provider's); a session's agent is the one its model names, the main agent's
when none; an effort of `null` is the model's own and absence is "ask the agent"; a plan, once approved, is
carried out in a mode that is neither dangerous nor a plan.

**The dangerous rule is of the type**: `defineOption` throws on a dangerous default, and `option.changed` into
a dangerous value is refused with today's notice for any option, not only a mode. `settings.set` is not
changed, and accepts a dangerous mode as a default when the owner picks it, as it does today (pinned in
`apps/daemon/test/integration/option-settings.test.ts`). That may not be what the red line, "`fullAccess` is
never a default and nothing turns it on for the owner", means. It is not decided here: it is a red-line
question and not a refactor, and the owner decides it apart.

**The page** (a later pull request, alone) draws any option with one menu, `OptionMenu`: the default marked
"<name> (default)", a dangerous value last, apart, in the warning color and taken by a press, a provider
grouping the rows. The model picker keeps its effort slider. Settings and the schedule editor choose the
model and the mode only, as today.

## Alternatives considered

- **B: keep `model`, `effort`, `agentMode` and change only the wire.** No stored byte changes, and a rolled
  back daemon reads everything. But a fourth option would need a key in three files and in six places of
  code, which is the cost this step exists to remove, and the stored shape would stay unlike the declared one.
- **A, and also write the old three keys for two releases.** A rollback loses nothing. It makes two writers of
  one thing, which can disagree, and `sandbox` and `environment` were done without it.
- **A flat list of options, with `models: string[]` on each effort value.** No nesting, but the efforts of one
  model are then not a view of one list, and the page needs them before a session exists.
- **`thought_level`** as the category, as ACP names it: the page and the operations page say effort.
- **Options inside `AgentDeclaration`.** The models would arrive with `daemon.info`, which would wait for
  Claude Code's model list, and an `options.changed` event would patch `daemon.info`'s copy.
- **Keep `ModeInfo` and `ModelInfo` beside the list.** Two sources of one fact, which is how the three fields
  came to be written in six places.

## Consequences

- A fourth option an agent offers needs a line in its harness and nothing else: no field on the wire, in a
  stored file, in `TurnOptions` or on a screen.
- The first pull request adds the type, `Sessions.options()` for both agents, `Agents.options()`,
  `options.list` and `options.changed`, beside the old methods; nothing reads them but a test, and no stored
  file is written differently. The stored format above is written by the next pull request, after the owner
  has read it.
- A daemon rolled back after the stored change loses or reverts the choices described above, and may read an
  earlier choice of a mode that never asks; the owner decides whether old keys are kept stale or removed.
- `ModelInfo.sandbox` waits for step 10's `environments`; until then the old fields stay and are removed with
  `ModeInfo` and `ModelInfo` in the last pull request. `optionsFromLegacy`, which builds the list from them,
  goes with them.
- Claude Code's models are read once and kept while the daemon runs, as `listModels` does today, so
  `options.list` is as complete as `models.list` is, no more.

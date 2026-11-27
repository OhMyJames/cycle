# Agent Note: Loop treats level-1 work items as 1-PR business units and level-2 Task Graphs as Loop-owned execution nodes

Status: accepted
Date: 2026-11-26
Basis: 2026-11-26 user architecture discussion on Loop Kanban fragmentation and Epic ownership; Design ticket CYC-507 (infra.CYC, Initiative 3); observed `infra.CYC` hierarchy (`CYC-280`+ containing 18 Epics and 178 child leaves) and current code in `cloud/loop/src/select.ts`, `cloud/loop/src/flows/dev/deliver.ts`, `cloud/loop/src/prompts/dev.ts`, and `cloud/loop/src/ports/tracker.ts`.

## Problem

Current Loop execution couples `1 leaf work item = 1 Dev session = 1 PR` (`cloud/loop/src/select.ts`, `cloud/loop/src/flows/dev/deliver.ts`) while treating level-1 Epics as passive containers that Loop never claims or closes. In `infra.CYC` (`CYC-280` onward), this produced 18 Epics with 178 child leaves—including 20–29-subtask buckets such as `CYC-380`, `CYC-381`, `CYC-470`, and `CYC-154`. Meanwhile, even for `完整流程` tickets that already have a multi-step `Plan` document, `cloud/loop/src/prompts/dev.ts` feeds the whole `Plan` into a single Dev session as plain text.

Two failures followed directly:

1. Level-1 work items had no owner or lifecycle automation and stayed stale even after all subtasks finished (`CYC-380` reached 29/29 Done while still in `Todo`).
2. Level-2 work items fragmented along implementation layers (for example splitting a single user-visible capability into separate API and UI tickets) just to fit one session and one PR, flooding the Kanban board and multiplying human approval and review overhead.

## Decision

Separate **business delivery units** (human-facing) from **execution graph nodes** (Loop-owned). **This decision sets the target architectural boundary; it is not yet implemented** (detailed schema, API, UI, and migration are tracked in `CYC-507`).

1. **Level-1 Work Item = business unit = 1 PR**:
   - Level-1 belongs to business/product: it carries business types (`Feature`, `Bug`, `Research`, `Design`), user-visible value, and end-to-end acceptance criteria.
   - Each Level-1 dev work item maps 1:1 to a single git branch/worktree and a single complete PR (`Closes CYC-<num>`), so Loop owns Level-1's full lifecycle from `Todo` to `Done`.
   - Multi-week programs or long-lived product areas that exceed one reviewable PR belong under an `Initiative` and split into multiple independently shippable Level-1 business items, rather than living as forever-open Epic buckets.
2. **Level-2 Task Node = Loop's standard execution node (Execution Graph)**:
   - Level-2 belongs exclusively to Loop: it has no business type and uses one standardized execution-node schema (`id`, `title`, `goal`, `dependsOn`, `filesHint`, `verify`, plus runtime state `status`, `sessionId`, `commitSha`, `rounds`, `summary`).
   - Breaking a Level-1 item into a Task Graph happens in the `Design` (locking cross-layer contracts) and `Plan` (producing the executable DAG) stages. For `完整流程` items, `Plan` is the human-approved Graph; for smaller items, Loop adapts automatically (1 node for trivial items, or 2–4 nodes planned by a read-only planner without blocking humans).
   - Within a Level-1 work item, write-capable Task Nodes execute sequentially in topological order on the same branch/worktree—each in a fresh Dev session fed with the full Level-1 Spec/Design, Graph status, and prior nodes' real `git diff`—followed by node-local `verify` and a checkpoint commit. After all nodes pass, Loop runs full Level-1 end-to-end verification and independent whole-item QA before opening one PR.
3. **Storage & UI boundary**:
   - `itsaplan` (behind `cloud/loop/src/ports/tracker.ts`, replaceable with Linear or GitHub Issues) is the **Level-1 business database only**. Loop writes at most one-way read-only milestone summaries/comments back to `itsaplan` and never maintains bidirectional sync of Level-2 nodes.
   - Loop Server's SQLite (`loop.db`) is the **single source of truth for Level-2 Execution Graphs**, served to Cycle desktop exclusively through the `loop/` API so the Cycle Kanban board focuses on Level-1 items while `TicketDrawer` renders and controls the underlying Task Graph.

## Alternatives considered

- **Store Level-2 Task Nodes as `Task` sub-issues in `itsaplan`**: rejected. High-frequency DAG mutations, dependency edges, retries, and commit bindings do not fit a remote issue tracker's schema, would re-pollute the business board, would multiply tracker outbox/reconciliation failure modes (`CYC-480`, `CYC-495`–`497`), and would couple Loop's execution model to `itsaplan` instead of keeping `Tracker` pluggable.
- **Default to one stacked/incremental PR per Level-2 node**: rejected as the default. Merging partial layers (e.g., unused API fields before UI) risks half-baked `main`, multiplies CI queue latency, and adds multi-branch rebase complexity. Oversized changes that genuinely need multiple PRs should be modeled as separate Level-1 business items under one `Initiative`.
- **Keep current Epic + leaf fragmentation and only add automatic Epic status sync**: rejected as the target architecture. It only fixes stale Epic columns and does not eliminate board fragmentation or human approval overhead.
- **Parallel write-capable worker agents inside one Level-1 item**: rejected for code edits. Concurrent writers make conflicting implicit design/type decisions and cause semantic merge conflicts even without textual git conflicts; read-only steps may run independently, while code writes inside one Level-1 item stay single-threaded along the Graph's topological order.

## Consequences

- **Benefits**: Eliminates ownerless Epics and implementation-slice ticket noise; turns `Plan` from passive prompt prose into a deterministic, crash-recoverable execution graph; keeps `main` free of half-implemented slices; keeps Cycle's Loop UI and execution engine independent of any specific external tracker.
- **Costs & limits**: Requires designing and building Graph tables in `loop.db`, Graph-aware flow execution in `cloud/loop`, Loop API extensions in `@cycle/protocol`, and a Graph view in `TicketDrawer` (`CYC-507`). Because `loop.db` is the execution truth, multi-user or multi-device visibility of live Graphs depends on sharing a Loop Server instance (`CYC-404`).
- **Transition**: Existing transition tickets (such as `CYC-502` and `CYC-503` for displaying current `itsaplan` parent-child hierarchy) remain valid while legacy Epics are active and are not blocked by this note.
- **Unverified**: Schema details, `Plan` document parsing vs. native Graph editing in `TicketDrawer`, dynamic failure/replanning bounds, and migration of `cycle-workflow` rules are not yet designed or verified and remain open in `CYC-507`.

## Related

- [2026-11-26-loop-api-is-the-only-way-in](2026-11-26-loop-api-is-the-only-way-in.md) — establishes that Cycle desktop reads and writes Loop state exclusively via the Loop server's `loop/` API.
- [2026-11-25-auto-loop-runs-unattended-with-a-narrow-boundary](2026-11-25-auto-loop-runs-unattended-with-a-narrow-boundary.md) — deterministic verification allowlist and code-enforced boundaries that Level-2 Task Nodes continue to obey.
- [2026-11-25-loop-server-is-its-own-process](2026-11-25-loop-server-is-its-own-process.md) — Loop server architecture that hosts `loop.db` and serves multiple Projects.

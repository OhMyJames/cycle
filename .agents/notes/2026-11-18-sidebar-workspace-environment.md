# Agent Note: A workspace is a cwd in one environment; the sidebar shows one workspace; unread and sort order come from the daemon

Status: accepted
Date: 2026-11-18
Basis: Owner's requests of 2026-11-18 in the sidebar refactor session: reuse old-cycle's one-project sidebar, define a client-side `environment` (local, remote, later cloud) in place of `host`, aggregate several connected daemons, and a remote workspace carries an icon with a tooltip naming its environment. Reading: old-cycle's [2026-11-08 sidebar note](https://github.com/OhMyJames/old-cycle/blob/main/.agents/notes/2026-11-08-sidebar-one-project.md) and `packages/ui/src/sessions/session-list.ts`; Claude Code desktop docs (code.claude.com/docs/en/desktop, /cloud-environments) and Codex docs (learn.chatgpt.com/docs/environments), read 2026-11-18.

## Problem

The sidebar is one flat list sorted by `cycle/lastSeq`, with a host selector on top. `lastSeq` counts records per session, so it orders by conversation length, not recency, and cannot be compared between sessions or daemons. There is no unread or background status, and "host" mixes where a daemon runs with how it is reached. The sidebar needs a model for several daemons at once.

## Decision

- **Environment is a client concept**, not a protocol one: `{id, name, kind: local | remote (later cloud), transport}`. `remote` does not mean SSH; SSH is one `transport`. The daemon cannot tell local from remote. Sessions are identified in the client as `(environmentId, sessionId)`. Several daemons are connected at once and their sessions are aggregated.
- **A workspace is `(environmentId, cwd)`.** A remote cwd is a different workspace from the same path locally; a session cannot change environment. Remote workspaces carry an icon whose tooltip and accessible name give the environment.
- **The sidebar shows one workspace at a time** (old-cycle's decision), with environment shown only as grouping inside the workspace switcher, not as top-level navigation.
- **Order by `updatedAt`**, a top-level field of ACP `SessionInfo` filled by the daemon from the last non-`meta` record's `ts`. `lastSeq` stays for replay only. A change of `updatedAt` alone does not send `_cycle/session_list_changed`.
- **Unread is kept by the daemon**: the index stores `readSeq` (set by `_cycle/session/mark_read`, never decreasing) and `attentionSeq` (last turn end or approval request); the list exposes `cycle/unread`. `cycle/background` counts running background sub-agents, in memory only. Both are added in protocol 0.2 and degrade to "absent" for older daemons.
- Status: the owner reviewed the protocol and `docs/desktop.md` drafts on 2026-11-18 and asked to proceed. The daemon side (protocol 0.2) is implemented. On the client side, every host connected from main, one aggregated list ordered by `updatedAt` (with the missing-field fallback), greyed rows for a host that is away, the one-workspace sidebar with its switcher and remote icon, one mark per row and `markRead` are implemented, and the client now says `environment` throughout, including the words the person reads (2026-11-18, the owner: keep "environment", drop "host"; the word may appear, but nothing asks the person to choose among environments while there is one). `settings.json` is `{ environments: [...] }`; the older `{ hosts: [...] }` is read as remote environments over SSH with the same ids, and is written in the new shape only when settings are saved; entries this version cannot read are kept as they were.

## Alternatives considered

- **Group the sidebar by environment, or make it first-level navigation.** Claude Code groups by folder and Codex by project; neither groups by environment, which they treat as where a new session runs. A remote cwd is already its own workspace, so grouping by environment would add a level that carries no extra choice.
- **Project = git main checkout** (old-cycle). It needs git placement in the list, and v1 has no worktrees. A workspace is a cwd until that changes.
- **Client-side unread** (a local set of read ids). Simpler, but a second client or a reinstall disagrees, and it cannot be shared when several clients attach to one daemon.
- **Unread as `lastSeq > readSeq`.** `meta` records, titles and usage updates also advance `lastSeq` and would produce false unread; hence a separate `attentionSeq`.
- **Keep sorting by `lastSeq`.** Rejected for the reasons in Problem.
- **Switching a session between environments** (Claude Code can open a cloud session from local; it cannot for SSH). Not needed in v1.

## Consequences

- Older remote daemons lag the app. Clients must treat `updatedAt`, `cycle/unread`, `cycle/background` as optional; sessions without `updatedAt` sort after dated ones, by `lastSeq` among themselves.
- An index written before these fields has neither `readSeq` nor `attentionSeq`; both count as 0, so no old session turns unread.
- Remote and cloud environments will differ in capability; the interface reads the daemon's declared capabilities, not the environment's kind.
- A disconnected environment keeps its last list, greyed (owner's decision, 2026-11-18), for as long as the app runs. How a remote folder is chosen is unverified (no daemon method exists); it is in `docs/desktop.md` under 待定. The Claude and Codex documentation was read on 2026-11-18 and may change; Codex's remote-connection page was not read.

## Related

- [old-cycle sidebar note](https://github.com/OhMyJames/old-cycle/blob/main/.agents/notes/2026-11-08-sidebar-one-project.md)
- [protocol.md §6](../../docs/protocol.md), [desktop.md](../../docs/desktop.md)
- Naming partly replaced by [2026-11-24-work-in-and-environments](2026-11-24-work-in-and-environments.md): what this note calls an environment is now "Work in" (code: location), and "environment" names a setup recipe. The rest of this note is unchanged.

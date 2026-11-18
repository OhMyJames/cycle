# Agent Note: A session records its environment; the container's name is the harness's alone

Status: accepted
Date: 2026-11-18
Basis: [the glossary](../../docs/glossary.md) (Environment, "sandbox means five things", the glossary's count before this step; it is three now), [the
entities](../../docs/entities.md) (the Session and Environment cards), the notes of 2026-11-14
([sandbox environments](2026-11-14-sandbox-environments.md) and [a local sandbox holds the agent
only](2026-11-14-a-local-sandbox-holds-the-agent-only.md)), and the checks of this step:
`sandboxName` hashes the folder's path and the environment's id and is not reversible, while
`sandboxes.json` `made[name].environment` names the id. Step 09 of the migration to the entities.

## Problem

A session carries the container's name (`cycle-<folder>-<hash>`) on the wire, in `sessions.json` and from
the daemon to the harness, though a name says nothing the owner chose and only the harness needs it. The
owner's choice, the environment, travels once, as `session.create.sandbox`, and is forgotten once the
sandbox is made: the page cannot say which environment a session is in, and a second backend (the
command sandbox, step 10) would have no container name to carry.

## Decision

- **The field.** `environment`: `Session.environment` is an environment's id or null (none chosen, the
  agent runs on this machine); `session.create.environment` and `TurnOptions.environment` are the id; and
  `sessions.json` keeps `environment`. It is an id, never a name and never a container's. An id whose
  environment was removed stays on the session, and the page says "Removed environment".
- **Cycle keeps it alone.** The agent's record says nothing of it, and the harness reports no
  environment. A session whose `sessions.json` entry is gone shows none, though its harness still finds
  its container through the sandbox's home and runs it there.
- **The harness derives the name.** A turn is told the environment, and the harness names the container
  `sandboxName(folder, environment)`. A name already known to it, found in a sandbox's own home, is the
  truth and wins over a derived one. Told and derived are one for every session this daemon made, since
  the harness names a sandbox from the same folder and id.
- **The old key is read, never written, never deleted.** The key `sandbox` (a name) stays readable, as
  `mode` is next to `agentMode`. It is read only to recover the id, and is removed from the code when two
  releases have shipped. A session made or copied now has `environment` alone, so a daemon rolled back
  over such a record sees no container: it finds the session through the sandbox's home when the
  conversation is there. It is never deleted from a file.
- **Recovering the id from an old record is checked by construction.** The name is not reversible, so the
  daemon tries candidates and keeps the one that makes the stored name for the session's folder: the
  environment the made-book entry names (`made[name].environment`, written for every sandbox Cycle made
  since environments), then each of the owner's environments. An entry saying `""` is not a candidate. A
  name from before environments (the folder's alone) matches none. The answer is written once as
  `environment`, so it survives the environment being removed, which deletes its made-book entries.
- **A session whose environment cannot be recovered is refused, not run elsewhere.** A record with a
  container's name and no environment that makes it (the environment was removed, or the name is older
  than environments) shows no environment, keeps its `sandbox` as it was, and logs one line with ids
  only. A turn on it is refused ("Its sandbox's environment is gone. Choose an environment for the
  session."): the daemon gives its harness neither the name nor an environment, so nothing of its
  conversation is moved and it never starts on this machine, outside the container it was made for.
  The same holds for a compaction, for putting files back, for a review and for a copy of it: a copy
  would carry no record of the container, and its next turn would run outside it, so none is made.
  A session opened before the daemon knows its folder (a page that asks for it before it has listed)
  cannot have its name tried against a folder yet. It is read with no place, which moves nothing and
  starts nothing, and once its folder is known the daemon tries again: when an environment makes the
  name, the session is loaded a second time told that environment, so that its conversation is moved
  into the container and what the agent is later asked (a compaction) starts there; when none does,
  it stays as it was and its turns are refused. The daemon never gives a harness a container's name.
- **What stays.** `sandboxCwd` (the path the agent says, mapped back to a file on this machine) and
  `ModelInfo.sandbox` (what an agent can do, step 17) keep their names. `SandboxEnvironment` and the
  `sandboxes.*` methods are renamed in steps 10 and 22.
- This replaces, in the 2026-11-14 notes, "the session keeps its name, in `sessions.json` (`sandbox`) and
  on `SessionInfo`. Every turn is given the name again".

## Alternatives considered

- Keep the name and add the id beside it. Rejected: two things to keep equal, and the name leaks the
  folder's basename to the page.
- A stored name only, the id found from the made book on each read. Rejected: the entry is gone when an
  environment is removed.
- Put the id into the container's name. Rejected: a name is a hash of the folder and the id because `sbx`
  names are one flat space, and old names cannot be rewritten while their sandboxes exist.
- The agent reports the environment. Rejected: it would have to learn a choice Cycle owns, and agents other
  than Claude Code have none.
- Rename the key `sandbox` in place. Rejected: an older daemon would read an id as a name and ask `sbx`
  for a sandbox of that name.
- Let an unrecovered session run in its container made again with nothing chosen, or on this machine.
  Rejected: a session recorded in a container must never start outside it unasked.

## Consequences

- A session whose `sessions.json` entry is lost no longer shows its environment.
- An old record whose environment was removed before this runs, or whose name is older than environments,
  has none, and its next turn is refused. No wire method yet sets a session's environment, so the owner's
  way on is a new session.
- A session made after this has no `sandbox` key, so a rolled-back daemon does not know its container;
  it finds the session through the sandbox's home, as for a record lost.
- A copy of a session whose container's environment is gone is refused until the owner has a way to
  choose one for it.
- `SessionMeta.sandbox` is read for two releases. `ModelInfo.sandbox` and `sandboxCwd` still say
  "sandbox": steps 17 and later.

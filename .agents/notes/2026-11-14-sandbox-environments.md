# Agent Note: A sandbox is made with an environment the owner keeps

Status: accepted
Date: 2026-11-14
Basis: the `sbx` CLI reference (docs.docker.com/reference/cli/sbx): `create --cpus --memory --env-file -t
--pull`, `exec`, `rm --force`, `template save|ls|rm`, `policy allow|rm network --sandbox`,
`secret set|ls`. Checked against a stand-in for `sbx` and the real Claude Code, not a running `sbx`.

## Problem

A sandbox made with nothing chosen takes every CPU and half the memory of the machine, reaches only
what Docker allows every sandbox, and has none of the tools a project needs. The owner wants to
say these once, by name, and choose among them for a session, as a cloud environment is chosen.

## Decision

`CYCLE_HOME/sandboxes.json` holds the environments (`id`, `name`, `cpus`, `memoryGb`, `hosts`,
`variables` with their values, `setup`) and, by sandbox name, what each sandbox Cycle made was made
with (`environment`, `version`, `hosts`). A home with no file has one environment, `standard`, with
nothing chosen. `session.create` takes an environment's id; a sandbox's name is the folder's and a
hash of its path and that id, so a folder has one sandbox for each environment.

- What only making sets (CPUs, memory, variables, the setup script) is hashed into `version`. A
  sandbox whose version is not its environment's is removed and made again the next time it is
  used, unless a session is running in it.
- Hosts are opened and closed on the sandbox as it is, by the difference from what was opened.
- The setup script runs once with `bash -lc` in a new sandbox, in the folder, as the sandbox's own
  user. A sandbox that ran it is saved as `cycle-env-<id>:<hash of the script>`, and the next
  folder's sandbox of that environment starts from the saved one instead of running the script.
- A variable's value never reaches the page (it is given names, and sends null to keep a value) and
  is never an argument: `sbx create --env-file` reads it from a file only the owner can read, which
  is removed once `sbx` is done. It is not put in the environment `sbx` itself runs with, where a
  `PATH` or a `HOME` meant for the sandbox would change what `sbx` does on this machine.
- The setup script's output is not said on with a variable's value in it, and making a sandbox and
  its setup script each have a time limit, so one that waits for an answer fails instead of holding
  the folder's sessions.
- A sign-in is one of `sbx`'s own secrets, for every sandbox: the page sends it once, the daemon
  writes it to `sbx secret set <service>` on its input, and Cycle keeps none of it. What `sbx` says
  when that fails is not passed on, since it could repeat its input.
- Only the three variables the SDK sets for a driven Claude Code go in with `sbx exec`. The daemon's
  own `CLAUDE_CODE_*` variables stay out: it may itself have been started from a Claude Code.

## Alternatives considered

- Settings applied to a running sandbox. Rejected: `sbx` sets CPUs, memory and variables only as a
  sandbox is made.
- A template built ahead, from a Dockerfile or a kit. Rejected for now: a script the owner can read
  and a snapshot of its result need nothing but `sbx` itself.
- Secrets for each environment. Rejected: Cycle would have to keep them to give them to each new
  sandbox, and `sbx` already keeps one for all.
- The version kept in the sandbox's name. Rejected: a session keeps its sandbox by name.

## Consequences

- Making a sandbox again loses what was in it outside the folder and its conversations.
- A sandbox with a session running in it keeps its old environment until the session's process ends
  (five idle minutes) and it is next used.
- Removing an environment removes its sandboxes and its saved sandbox, but for one in use. A session
  left in a removed sandbox has it made again with nothing chosen.
- Deleting `sandboxes.json` loses the environments, and every sandbox is taken for one made with
  nothing chosen, so it is made again if its environment says otherwise.
- The first session in an environment with a setup script waits for the script and the save.

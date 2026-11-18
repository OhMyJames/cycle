# Agent Note: each agent declares what it can do, and has its own Connector and Account

Status: accepted
Partly replaced by [an agent declares what it can do by operation](2026-11-18-an-agent-declares-what-it-can-do-by-operation.md)
Date: 2026-11-16
Basis: Plan for full Claude Agent SDK coverage, session 3 (2026-11-16). Checked against
`@anthropic-ai/claude-agent-sdk` 0.3.325 (Claude Code 2.1.325), run under Bun against a scripted
Messages API.

## Problem

The protocol took the Connector and the Account to be one each, codex's, and every agent to do what
codex does. Claude Code can do more in places (put files back, list its commands, read PDFs, reach
other folders, say its context in parts) and less in others (Cycle cannot sign it in or change its
configuration yet). The page could not tell which session could do what, and `account.*`, `mcp.*`,
`skills.list` and `plugins.*` could only mean codex.

## Decision

- **Capabilities.** Every `Agent` has `capabilities: AgentCapabilities`: the attachments a prompt
  may carry, whether it puts files back, lists commands, reaches other folders, whether its
  connector can be changed or only read, whether it signs in through Cycle, and whether it has
  codex's `features.*` switches. Only what the page or the daemon acts on is listed. `daemon.info`
  gives them as `harnesses`, the main agent first, and the page shows a session what its agent can.
- **Optional methods, by capability.** `rewindFiles`, `listCommands` and `readContext` are optional
  on `Agent`; the capabilities say which an agent has. What every agent does stays required.
- **Agents, as the daemon sees them.** The daemon depends on `Agents` (`packages/protocol`), which
  `Harnesses` implements: a session's work goes to the agent that keeps it, and
  `connector(harness?)` and `account(harness?)` give an agent's own, the main one's when no name is
  given. The wire methods take an optional `harness` for the same.
- **Another agent only reads.** An agent besides the main one may offer `listSkills`,
  `listMcpServers` and `readAccount` (`AgentReads`). Whatever else is asked of its Connector or
  Account is refused with `NotSupported` ("… is not supported for claude in Cycle yet."), never
  sent to the main agent in its place. The daemon refuses documents of a kind the session's agent
  does not take, and folders beyond its own for an agent that cannot reach them.
- **Accounts.** `AccountInfo` says whose it is (`harness`), and its limits are a list of windows,
  each with a name, how much is used, when it resets and whether it is exceeded or paid as overage.
  Codex's two windows map into it. Claude Code's come from its `rate_limit_event`s as they arrive.
  Of a credential only where it is read from is given (`source`, as `ANTHROPIC_API_KEY`), never a
  value; a sandbox's sign-in is not the owner's and is never read for the account.
- **Usage.** `TokenCount` gains `cacheWrite`; `Usage` gains `costUsd`, Claude Code's own estimate,
  null for codex. `usage.json` gains `cacheWrite` per day, a number: a day kept before reads as 0.
  No cost is kept there.

## Alternatives considered

- Sending another agent's Connector calls to the main one, as before. Rejected: the owner would
  change codex's configuration believing it was Claude Code's.
- Making each of `Connector`'s methods optional on `Agent`. Rejected: an interface cannot extend both
  that and `Connector` with differing optionality, and the daemon would test for each method at
  every call. One `connector(harness)` answers a whole Connector, refusals included.
- A capability for every method, review and compact included. Not done: every agent does those.
- Keeping each day's cost in `usage.json`. Not done: an estimate that only one agent gives, and no
  page shows it yet.

## Consequences

- Session 4 fills Claude Code's Connector in: what is refused now becomes its writes, behind
  `connector("claude")`, with no change to the wire.
- Claude Code's account is what its latest process said as it started, or a running one says when
  asked. A sign-in made in its command line shows with the next process.
- Its commands are each folder's: a project brings its own. A folder's list is what the last process
  there said; one no process ran in is asked of one started there, once.
- Its MCP servers are asked of a running process on this machine, once none is still connecting.
  With none running, the last answer is given for five minutes; then a process is started for it,
  which starts the owner's stdio servers too, so it is not asked with every look at the page.
- A queued prompt's documents stay in the daemon, named in the session's state: up to 8 MB each
  would otherwise go out with every change to the queue and stay in the frames kept for a client
  that was away. The page that queued them gives them back when a turn stops; another page names
  what it cannot give back.
- What a session cost adds up over its processes. Claude Code 2.1.325 was seen to carry a resumed
  conversation's cost on; a process that begins at nothing is told by a first total below what
  was spent before.
- Its limits are known only once a turn has run since the daemon started.
- A session's context in parts needs its process: with none, the daemon answers the total the last
  request read, as it does for codex. Claude Code's `summary` breakdown has no row for the
  conversation itself; `full` would count it, with a request of its own each time.

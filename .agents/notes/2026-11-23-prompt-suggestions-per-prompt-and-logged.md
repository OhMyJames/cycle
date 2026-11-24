# Agent Note: Prompt suggestions are asked for on each prompt and kept in the history

Status: accepted
Date: 2026-11-23
Basis: CYCL-225 (开启 Claude 的下一轮输入建议，在 composer 里显示，按 → / Tab 采用), docs/protocol.md §8 "下一轮输入建议"

## Problem

Claude's SDK can guess the person's next message after each turn (`promptSuggestions`). It had to reach the composer through L1, and a Settings switch had to stop the agent from making suggestions, not just hide them. Two things needed a durable shape: how the client's wish reaches the agent, and whether a suggestion is history.

## Decision

- The wish rides on `session/prompt` as `_meta["cycle/promptSuggestions"]` (boolean). The desktop main process adds it from `preferences.json` to every prompt. The daemon keeps the last value per session in memory and gives it to the agent with every prompt it sends, queued ones included. An agent that receives no `true` makes none: old clients and old daemons never cost a suggestion.
- The Claude adapter always starts the query with `promptSuggestions: true` and switches the flag setting `promptSuggestionEnabled` (`false` / `null`, so the person's own settings.json can still say no) when the wish changes. It also drops a suggestion that arrives once a new turn has begun or when the wish is off.
- `_cycle/prompt_suggestion {suggestion}` is a logged, replayed `session/update`, like `_cycle/goal_update`. The daemon drops it when the session is no longer idle or nobody wanted it. The client treats it as valid until the next `user_message`, `running` or `requires_action`.

## Alternatives considered

- A boolean in Claude's `configSchema` (agent defaults or session config): it would make an app-wide switch per agent and per session, and the Settings page would have to name Claude. Rejected.
- A daemon-wide setting method: a new L1 method and stored state for one boolean that only the sender of a prompt cares about. Rejected.
- Hiding suggestions only in the page: the issue asks that turning it off stops asking for them.
- Not logging suggestions (an unsequenced notification like `_cycle/plan_usage_changed`): a reconnect or reopening the session would lose the last turn's suggestion, and the daemon would need a second forwarding path. Logging costs one small record per turn. It does not count as worth reading (§6), so it does not mark a session unread.

## Consequences

- After a daemon restart the remembered wish is gone until the next prompt says it again. A queued prompt sent at restart goes without it, so that turn gets no suggestion.
- The flag-setting path (`applyFlagSettings({promptSuggestionEnabled})`) and the SDK's suppression rules have only been checked with the fake query, not against a real model.
- Suggestions are the agent's words in the history and are not redacted, like `agent_message`.

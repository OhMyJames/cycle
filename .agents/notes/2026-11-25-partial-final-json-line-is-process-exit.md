# Agent Note: A partial final JSON line means the child exited

Status: accepted
Date: 2026-11-25
Basis: The owner reported repeated `JSON Parse error: Unterminated string` failures after interrupting long `bun run check` and `git commit` commands (2026-11-25). A line-rpc regression reproduced the same error when a child exited after writing half a JSON line.

## Problem

Node's `readline` emits bytes after the last newline as a final line at EOF. If an app-server is stopped while writing a large notification, that final line is incomplete JSON. Parsing it produced an `Unterminated string` error and closed the adapter with that parse error, hiding the child process's real exit or cancellation reason.

## Decision

`LineJsonRpcProcess` defers a JSON parse failure for one event-loop turn. If the child has closed or exited by then, its own close event supplies the reason and the incomplete tail is ignored. A malformed line from a child that remains alive still closes the connection immediately after that turn.

## Alternatives considered

Closing on every final incomplete line preserved strict NDJSON syntax but replaced actionable process-exit reasons with parser errors during cancellation. Ignoring all malformed lines would hide protocol corruption from live processes and could leave requests waiting.

## Consequences

Cancellation and process exits no longer surface a misleading JSON parser error for a half-written final frame. The lost tail has no complete message to deliver, so no event is fabricated. A live process sending malformed JSON remains a fatal protocol error. `packages/line-rpc/test/line-rpc.test.ts` covers both the partial-final-line and live-garbage cases.

## Related

- [line-rpc](../../packages/line-rpc/src/index.ts)
- [DeepSeek catalog tuning and code-mode A/B](2026-11-25-deepseek-codex-catalog-and-code-mode.md)

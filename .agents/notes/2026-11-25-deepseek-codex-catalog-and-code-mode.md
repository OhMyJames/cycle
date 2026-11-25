# Agent Note: DeepSeek Codex sessions use catalog tuning but stay on direct tools

Status: accepted
Date: 2026-11-25
Basis: The owner asked to reduce Codex + DeepSeek context replay, set a 500K compact limit, align the official DeepSeek Codex catalog, and run a `code_mode` A/B before considering `code_mode_only` (2026-11-25).

## Problem

A DeepSeek Codex session issued hundreds of shell commands across hundreds of model requests. Each tool result sent the growing conversation back to the model, so input replay dominated the token count. The provider catalog also used direct tools only, despite Codex supporting mixed code mode.

## Decision

DeepSeek provider models in `harness/codex/src/providers.ts` get a 500K automatic compaction limit, capped at 95% of a smaller model's window. They also get freeform `apply_patch`, verbosity support with `high` as the default (Codex 0.171.0 has only `low`, `medium`, and `high`), and the official `supports_parallel_tool_calls: true` field. Other provider models keep direct tools. Reasoning content is still sent back because DeepSeek requires prior-turn reasoning when tools are present. Mixed `code_mode` was implemented for the A/B and then removed after it lost on requests and input, so neither mixed nor `code_mode_only` is used.

## Alternatives considered

Direct tools beat mixed `code_mode`: across three real DeepSeek trials, direct averaged 4 requests, 7 tools, and 34822 input tokens; code mode averaged 5 requests, 5 tools, and 54735 input tokens. Both completed 3/3 tasks. `code_mode_only` was not tried because the mixed mode it must improve on already lost. A literal 500-token compact limit was rejected because the initial Codex prompt is already larger. Setting verbosity to `max` was unavailable because it is not a Codex 0.171.0 enum value.

## Consequences

DeepSeek compaction starts at 500K instead of the 95% window limit. Codex 0.171.0 accepts the catalog fields, but `debug models` reads `supports_parallel_tool_calls` back as null, so whether that field affects this pinned version remains unverified. The three-trial A/B found fewer tool calls but more model requests and input under mixed code mode. Lowering tool-call count did not lower replay cost, so direct tools remain. `apps/daemon/scripts/codex-deepseek-ab.ts` reproduces both arms through Cycle's gateway.

## Related

- [The owner's own model providers reach Codex through a loopback gateway](2026-11-24-codex-own-models-through-a-pi-ai-gateway.md)
- [Codex adapter](../../docs/adapters/codex.md)

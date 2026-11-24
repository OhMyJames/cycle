# Agent Note: The owner's own model providers reach Codex through a loopback gateway built on pi-ai

Status: accepted
Date: 2026-11-24
Basis: The owner asked to bring old-cycle's pi-ai providers back for the Codex agent (2026-11-24, CYC-300). Old decision: `clawdot/cycle` `.agents/notes/2026-11-13-providers-go-through-a-gateway-of-pi-ai.md`. Re-checked here against codex 0.171.0 and `@earendil-works/pi-ai` 1.5.2: a real codex app-server finished a turn through the gateway against a scripted OpenAI-compatible endpoint, and the daemon compiled with `bun build --compile` ran the gateway.

## Problem

Codex speaks one protocol to a model, the OpenAI Responses API. Anthropic, Google, OpenRouter and most compatible endpoints speak others. A Codex thread stays with the model provider it began on, so one session cannot move between Codex's own models and another provider's. The owner's provider keys are a new secret the daemon must hold and the agent must not reach.

## Decision

- `packages/model-gateway` answers the Responses API on `127.0.0.1`, asks the provider with pi-ai, and answers codex in its events. It is the only code that knows pi-ai. The daemon starts it on the first session that has something to serve and stops it at close. It answers only the bearer token made at each daemon start.
- The owner's providers are kept in `<dataDir>/providers.json` (0600), key included. No protocol answer returns a key (`hasKey` only). A key stays with the address it was given for: saving another address without a key drops it.
- A model of a provider's is `<provider id>/<model id>` everywhere. A provider's id is made once and never changes.
- **A session is on Codex's own models or the owner's, by the model it begins with.** The daemon tells the adapter that model in `_meta["cycle/model"]` on `session/new` and `session/resume`. The adapter then starts the thread with the gateway as its model provider through the thread's `config` (never `config.toml`), puts the gateway token in the app-server's environment only, and lists in the session's menu only models of that kind. A model of the other kind is refused.
- Codex's own ChatGPT sign-in is unchanged and stays Codex's.

## Alternatives considered

- A second `codex app-server` process per daemon, routed by thread, as old-cycle did. Not needed here: one session already has its own adapter and app-server, so the session's kind is simply chosen when that process starts.
- pi-ai's `openai-codex` provider for the ChatGPT subscription, as old-cycle rejected: it would put OAuth tokens in Cycle's storage.
- Codex's `model_providers` pointed straight at each provider: Codex speaks only Responses.
- Switching a thread's provider mid-session, or restarting it: Codex refuses a turn of a thread on another provider, and a restart would lose the conversation.

## Consequences

- A session cannot move between Codex's own models and a provider's; it can move among that provider's models. The blank page offers both.
- The daemon's model choices for the blank page add the owner's models live and keep them out of the options cache, so a removed provider does not linger.
- `shell_environment_policy.exclude` names the token in a provider session. This replaces an `exclude` of the owner's own config for that thread.
- The agent's commands run as the owner and can read `providers.json`, as they can read `daemon.json`. The file's mode keeps out other users, not the agent. This is the old-cycle limit, unchanged.
- The thread's context window is that of the model it began with (`model_context_window`); another model of the same provider in the same session uses it too.
- Codex offers no `apply_patch` for a model it does not know, and its web search and image generation are OpenAI's: a provider's model edits files through shell commands.
- A tool call's provider-specific signature (Gemini `thoughtSignature`) is remembered in memory only and is lost when the daemon restarts.
- Verified: gateway tests, a real codex turn through the gateway, the token kept from commands, the model menu of a provider session. Not verified: any real provider, and the packaged desktop app.

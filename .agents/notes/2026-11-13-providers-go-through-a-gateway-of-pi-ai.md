# Agent Note: The owner's model providers reach codex through a gateway built on pi-ai

Status: accepted
Date: 2026-11-13
Basis: The owner asked for model providers of their own and for the ChatGPT subscription, with pi-ai
as the protocol layer (2026-11-13). Checked against codex 0.167.2 and `@earendil-works/pi-ai` 1.5.2.

## Problem

Codex speaks one protocol to a model, the OpenAI Responses API. Anthropic, Google, OpenRouter and most
OpenAI-compatible endpoints speak others. pi-ai speaks all of them, but it is a model client, not an
agent: the sessions, tools, sandbox and approvals are codex's, and Cycle keeps none of its own.

Two facts about codex shaped the answer. Both were measured, not read:

- A thread stays with the model provider it began on. `turn/start` on a thread of another provider is
  refused: "This chat uses cycle, but your current provider is mock".
- One `codex app-server` process runs one provider, the `model_provider` of its config. `thread/start`
  accepts `modelProvider` and records it, and the next turn is refused all the same.

## Decision

- **The gateway** (`packages/gateway`) is a Responses API endpoint on loopback. It turns each request
  codex makes into pi-ai's conversation, asks the provider the model belongs to, and turns the answer
  back into the events codex reads. It is the only code that knows pi-ai.
- **A second codex process** runs with `model_provider = "cycle"` pointed at the gateway. The harness
  starts it the first time a session on a provider's model is used, and routes each session to the
  process of the provider its thread records. Files, commands, terminals and the account stay with
  the first process.
- **A model of a provider's is `<provider id>/<model id>`** everywhere: in the model menu, in
  `sessions.json`, on the codex thread, and in the request the gateway takes apart. A provider's id is
  made once and never changes.
- **`CYCLE_HOME/providers.json`** (mode 0600) holds the providers: `id`, `name`, `kind` (a service
  pi-ai knows, or `custom`), `api` and `baseUrl` for a custom endpoint, `apiKey`, and the chosen
  `models`. A key goes from the page to the daemon once. No wire method returns it: the page sees
  `hasKey`.
- **The gateway answers only its bearer**, 32 random bytes made at each start and given to the codex
  process in its environment (`CYCLE_PROVIDER_TOKEN`), never in its arguments. It binds to
  `127.0.0.1` and checks `Host`, as the daemon does.
- **The ChatGPT subscription is codex's own sign-in**, `account/login/start`, started from Settings.
  The tokens stay in `CODEX_HOME`, where codex keeps and refreshes them. Cycle never holds them.
- **Reasoning returns to its provider intact.** A thinking block goes to codex as a reasoning item
  whose `encrypted_content` is the block itself, marked `cycle:`, so a signed block is sent back as it
  came. Reasoning another provider encrypted carries no mark and is left out.

## Alternatives considered

- pi-ai's `openai-codex` provider for the ChatGPT subscription. Rejected: it would put OAuth tokens in
  Cycle's storage and send codex's own models through two translations. Codex already signs in.
- Codex's `model_providers` pointed straight at each provider. Rejected: codex speaks only the
  Responses API, so Anthropic, Google and Chat Completions endpoints could not be reached.
- Every model through the gateway, codex's own included, to have one process and free switching.
  Rejected: codex's own path would lose its sign-in, encrypted reasoning and server-side compaction.
- A second harness on pi-ai's agent loop. Rejected: a second implementation of tools, sandbox and
  approvals, and the daemon would no longer reach the machine through one harness.
- `model_catalog_json`, to tell codex each model's window and name. Rejected for now: every entry must
  carry codex's whole base instructions, and it is read only at start. The window goes with
  `thread/start` instead, and the warning about fallback metadata is not shown for these sessions.

## Consequences

- A session cannot move between codex's own models and a provider's. It can move among providers'
  models. The model menu offers only what a session can use, and the daemon refuses the rest.
- With fallback metadata codex offers no `apply_patch` tool: a provider's model edits files through
  shell commands. The gateway already carries free-text tools, should codex offer one.
- Codex's web search and image generation are tools of OpenAI's servers. They are left out of what a
  provider's model is offered.
- A provider's refusal before any answer (a bad key, an unknown model) is an HTTP error, which codex
  reports once. A failure mid-answer is `response.failed`, which codex retries. A conversation too
  long for the model is reported as `context_length_exceeded`, so codex compacts and asks again.
- The agent's commands run as the owner, so they can read `providers.json` as they can read
  `daemon.json`. The gateway's token is no boundary against the agent, only against other pages and
  processes that are not the owner's.
- A tool call's provider-specific signature (Gemini's `thoughtSignature`) has no field in the
  Responses API and is not sent back. pi-ai repairs a history without it.
- Not verified: any real provider. The path is tested against scripted OpenAI and Anthropic endpoints
  and the real codex, not against a live service.

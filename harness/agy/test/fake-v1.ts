import { AgyRpcError, type AgyServerHandlers, type AgyTransport } from "../src/server.ts";
import type { V1InitializeResult, V1SessionResponse } from "../src/v1.ts";

export type FakeRequestHandler = (
  method: string,
  params: unknown,
  agent: FakeV1Agent,
) => Promise<unknown> | unknown;

export class FakeV1Agent implements AgyTransport {
  readonly requests: Array<{ method: string; params: unknown }> = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  readonly #handlers: AgyServerHandlers;
  #closed = false;
  #requestHandler: FakeRequestHandler;

  constructor(handlers: AgyServerHandlers, requestHandler: FakeRequestHandler) {
    this.#handlers = handlers;
    this.#requestHandler = requestHandler;
  }

  get closed() {
    return this.#closed;
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (this.#closed) throw new Error("fake agy closed");
    this.requests.push({ method, params });
    return (await this.#requestHandler(method, params, this)) as T;
  }

  notify(method: string, params: unknown) {
    if (this.#closed) return;
    this.notifications.push({ method, params });
  }

  emitUpdate(sessionId: string, update: Record<string, unknown>) {
    this.#handlers.onNotification("session/update", { sessionId, update });
  }

  askClient<T = unknown>(method: string, params: unknown): Promise<T> {
    return this.#handlers.onRequest(method, params) as Promise<T>;
  }

  crash(message = "agy acp exited (1)") {
    this.close(new Error(message));
  }

  close(reason = new Error("fake agy closed")) {
    if (this.#closed) return;
    this.#closed = true;
    this.#handlers.onExit(reason);
  }
}

export const defaultInitResult = (version = "1.5.15"): V1InitializeResult => ({
  protocolVersion: 1,
  agentInfo: { name: "Antigravity ACP Server", version },
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
    mcpCapabilities: { http: true },
    _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
  },
});

export const defaultSessionResponse = (sessionId = "agy-sess-1"): V1SessionResponse => ({
  sessionId,
  models: {
    currentModelId: "gemini-4-neon-high",
    availableModels: [
      { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
      { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
      { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
      { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
      { modelId: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" },
      { modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
      { modelId: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
      { modelId: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
    ],
  },
  modes: {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default", description: "Ask before edits and commands." },
      { id: "accept-edits", name: "Accept edits", description: "Approve workspace edits." },
      { id: "auto", name: "Auto", description: "Approve safe actions." },
      { id: "plan", name: "Plan", description: "Plan before editing." },
    ],
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "gemini-4-neon",
      options: [
        { value: "gemini-4-neon", name: "Gemini 4 Neon" },
        { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
        { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
      ],
    },
    {
      id: "thought_level",
      name: "Thinking Level",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra" },
      ],
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "default",
      options: [
        { value: "default", name: "Default", description: "Ask before edits and commands." },
        { value: "accept-edits", name: "Accept edits", description: "Approve workspace edits." },
        { value: "auto", name: "Auto", description: "Approve safe actions." },
        { value: "plan", name: "Plan", description: "Plan before editing." },
      ],
    },
  ],
});

export { AgyRpcError };

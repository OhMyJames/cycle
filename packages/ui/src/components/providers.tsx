import {
  CUSTOM_PROVIDER_KIND,
  type ModelProvider,
  type ModelProviderDraft,
  type ProviderApi,
  type ProviderKind,
  type ProviderModel,
} from "@cycle/protocol";
import { useEffect, useState } from "react";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { compactNumber } from "../lib/format.ts";
import { Icon } from "./icons.tsx";

const API_LABELS: Record<ProviderApi, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};

const ADDRESS_HINTS: Record<ProviderApi, string> = {
  "openai-completions": "https://api.example.com/v1",
  "openai-responses": "https://api.example.com/v1",
  "anthropic-messages": "https://api.example.com",
};

const NEW_MODEL: ProviderModel = {
  id: "",
  name: "",
  reasoning: false,
  images: false,
  contextWindow: 128_000,
  maxTokens: 16_384,
};

/** What the form holds while a provider is added or changed. */
interface Form {
  id: string | null;
  name: string;
  kind: string;
  api: ProviderApi;
  baseUrl: string;
  apiKey: string;
  hasKey: boolean;
  models: ProviderModel[];
}

function formFor(provider: ModelProvider | null): Form {
  return {
    id: provider?.id ?? null,
    name: provider?.name ?? "",
    kind: provider?.kind ?? CUSTOM_PROVIDER_KIND,
    api: provider?.api ?? "openai-completions",
    baseUrl: provider?.baseUrl ?? "",
    apiKey: "",
    hasKey: provider?.hasKey ?? false,
    models: provider?.models ?? [{ ...NEW_MODEL }],
  };
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="form-row">
      <span className="form-label">{label}</span>
      {children}
    </label>
  );
}

function wholeNumber(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** The models of an endpoint the owner describes: nobody else knows what it serves. */
function CustomModels({
  models,
  onChange,
}: {
  models: ProviderModel[];
  onChange(models: ProviderModel[]): void;
}) {
  const patch = (index: number, change: Partial<ProviderModel>) =>
    onChange(models.map((model, at) => (at === index ? { ...model, ...change } : model)));
  return (
    <div className="model-rows">
      {models.map((model, index) => (
        <div key={index} className="model-row">
          <div className="row">
            <input
              className="field mono"
              placeholder="Model id, as the endpoint knows it"
              aria-label="Model id"
              value={model.id}
              spellCheck={false}
              onChange={(event) => patch(index, { id: event.currentTarget.value, name: "" })}
            />
            <button
              type="button"
              className="icon-button"
              title="Remove this model"
              aria-label="Remove this model"
              disabled={models.length === 1}
              onClick={() => onChange(models.filter((_, at) => at !== index))}
            >
              <Icon name="x" />
            </button>
          </div>
          <div className="row model-traits">
            <label className="row">
              <span className="caption muted">Context</span>
              <input
                className="field tabular short"
                inputMode="numeric"
                aria-label="Context window, in tokens"
                value={model.contextWindow || ""}
                onChange={(event) =>
                  patch(index, { contextWindow: wholeNumber(event.currentTarget.value, 0) })
                }
              />
            </label>
            <label className="row">
              <span className="caption muted">Max output</span>
              <input
                className="field tabular short"
                inputMode="numeric"
                aria-label="Most tokens in one answer"
                value={model.maxTokens || ""}
                onChange={(event) =>
                  patch(index, { maxTokens: wholeNumber(event.currentTarget.value, 0) })
                }
              />
            </label>
            <label className="row check">
              <input
                type="checkbox"
                checked={model.reasoning}
                onChange={(event) => patch(index, { reasoning: event.currentTarget.checked })}
              />
              Thinks
            </label>
            <label className="row check">
              <input
                type="checkbox"
                checked={model.images}
                onChange={(event) => patch(index, { images: event.currentTarget.checked })}
              />
              Reads images
            </label>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="button"
        onClick={() => onChange([...models, { ...NEW_MODEL }])}
      >
        <Icon name="plus" /> Add a model
      </button>
    </div>
  );
}

/** The models a known service serves: the owner ticks the ones to use. */
function CatalogModels({
  kind,
  chosen,
  onChange,
}: {
  kind: string;
  chosen: ProviderModel[];
  onChange(models: ProviderModel[]): void;
}) {
  const app = useApp();
  const [catalog, setCatalog] = useState<ProviderModel[] | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let current = true;
    setCatalog(null);
    app.request("providers.catalog", { kind }).then(
      ({ models }) => current && setCatalog(models),
      () => current && setCatalog([]),
    );
    return () => {
      current = false;
    };
  }, [app, kind]);
  if (catalog === null) return <div className="note">Reading the models…</div>;
  const picked = new Set(chosen.map((model) => model.id));
  const needle = query.trim().toLowerCase();
  const shown = catalog.filter(
    (model) =>
      !needle ||
      model.id.toLowerCase().includes(needle) ||
      model.name.toLowerCase().includes(needle),
  );
  return (
    <div className="model-rows">
      <div className="row">
        <input
          className="field"
          placeholder={`Filter ${catalog.length} models`}
          aria-label="Filter models"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <span className="caption muted tabular nowrap">{picked.size} chosen</span>
      </div>
      <div className="model-list" role="group" aria-label="Models to use">
        {shown.map((model) => (
          <label key={model.id} className="model-option">
            <input
              type="checkbox"
              checked={picked.has(model.id)}
              onChange={(event) =>
                onChange(
                  event.currentTarget.checked
                    ? [...chosen, model]
                    : chosen.filter((other) => other.id !== model.id),
                )
              }
            />
            <span className="grow fade-x">{model.name}</span>
            <span className="caption muted tabular nowrap">
              {compactNumber(model.contextWindow)}
              {model.reasoning ? " · thinks" : ""}
              {model.images ? " · images" : ""}
            </span>
          </label>
        ))}
        {shown.length === 0 ? <div className="note">No model matches.</div> : null}
      </div>
    </div>
  );
}

function ProviderForm({
  provider,
  kinds,
  onDone,
}: {
  provider: ModelProvider | null;
  kinds: ProviderKind[];
  onDone(): void;
}) {
  const app = useApp();
  const [form, setForm] = useState(() => formFor(provider));
  const [saving, setSaving] = useState(false);
  const custom = form.kind === CUSTOM_PROVIDER_KIND;
  const set = (change: Partial<Form>) => setForm((value) => ({ ...value, ...change }));
  const kindName = kinds.find((kind) => kind.id === form.kind)?.name;
  const ready =
    form.models.some((model) => model.id.trim()) && (!custom || form.baseUrl.trim().length > 0);

  const save = async () => {
    setSaving(true);
    const draft: ModelProviderDraft = {
      ...(form.id ? { id: form.id } : {}),
      name: form.name,
      kind: form.kind,
      api: custom ? form.api : null,
      baseUrl: form.baseUrl.trim() || null,
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      models: form.models.filter((model) => model.id.trim()),
    };
    const saved = await app.attempt(app.request("providers.save", draft));
    setSaving(false);
    if (saved) onDone();
  };

  return (
    <form
      className="card provider-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !saving) void save();
      }}
    >
      <Labeled label="Service">
        <select
          className="field"
          value={form.kind}
          // What a provider is for names its models everywhere, so it is chosen once.
          disabled={form.id !== null}
          onChange={(event) => set({ kind: event.currentTarget.value, models: [], baseUrl: "" })}
        >
          <option value={CUSTOM_PROVIDER_KIND}>Custom endpoint</option>
          {kinds.map((kind) => (
            <option key={kind.id} value={kind.id}>
              {kind.name}
            </option>
          ))}
        </select>
      </Labeled>
      <Labeled label="Name">
        <input
          className="field"
          placeholder={custom ? "My endpoint" : (kindName ?? "")}
          value={form.name}
          onChange={(event) => set({ name: event.currentTarget.value })}
        />
      </Labeled>
      {custom ? (
        <Labeled label="Protocol">
          <select
            className="field"
            value={form.api}
            onChange={(event) => set({ api: event.currentTarget.value as ProviderApi })}
          >
            {Object.entries(API_LABELS).map(([api, label]) => (
              <option key={api} value={api}>
                {label}
              </option>
            ))}
          </select>
        </Labeled>
      ) : null}
      <Labeled label="Address">
        <input
          className="field mono"
          placeholder={
            custom ? ADDRESS_HINTS[form.api] : "The service's own, unless you use a proxy"
          }
          value={form.baseUrl}
          spellCheck={false}
          onChange={(event) => set({ baseUrl: event.currentTarget.value })}
        />
      </Labeled>
      <Labeled label="API key">
        <input
          className="field mono"
          type="password"
          autoComplete="off"
          placeholder={
            form.hasKey
              ? "Saved. Type a new one to replace it."
              : custom
                ? "Leave empty if the endpoint needs none"
                : "Kept by the daemon, never shown again"
          }
          value={form.apiKey}
          onChange={(event) => set({ apiKey: event.currentTarget.value })}
        />
      </Labeled>
      <div className="form-row top">
        <span className="form-label">Models</span>
        {custom ? (
          <CustomModels
            models={form.models.length ? form.models : [{ ...NEW_MODEL }]}
            onChange={(models) => set({ models })}
          />
        ) : (
          <CatalogModels
            kind={form.kind}
            chosen={form.models}
            onChange={(models) => set({ models })}
          />
        )}
      </div>
      <div className="row form-actions">
        <button type="button" className="button" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="button primary" disabled={!ready || saving}>
          {form.id ? "Save" : "Add provider"}
        </button>
      </div>
    </form>
  );
}

function ProviderRow({ provider, onEdit }: { provider: ModelProvider; onEdit(): void }) {
  const app = useApp();
  const [removing, setRemoving] = useState(false);
  const names = provider.models.map((model) => model.name || model.id);
  return (
    <div className="setting">
      <div className="grow">
        <div className="row">
          <span className="fade-x">{provider.name}</span>
          {provider.hasKey ? null : <span className="chip">No key</span>}
        </div>
        <div className="caption muted fade-x">
          {names.slice(0, 3).join(", ")}
          {names.length > 3 ? ` and ${names.length - 3} more` : ""}
        </div>
      </div>
      {removing ? (
        <>
          <button type="button" className="button" onClick={() => setRemoving(false)}>
            Keep
          </button>
          <button
            type="button"
            className="button danger"
            onClick={() => void app.attempt(app.request("providers.delete", { id: provider.id }))}
          >
            Remove it
          </button>
        </>
      ) : (
        <>
          <button type="button" className="button" onClick={onEdit}>
            Edit
          </button>
          <button
            type="button"
            className="icon-button"
            title="Remove this provider"
            aria-label={`Remove ${provider.name}`}
            onClick={() => setRemoving(true)}
          >
            <Icon name="trash" />
          </button>
        </>
      )}
    </div>
  );
}

/** The owner's own model providers: which services, which keys, which models. */
export function ProvidersSection() {
  const app = useApp();
  const providers = useStore(app.providers, (value) => value);
  const [kinds, setKinds] = useState<ProviderKind[]>([]);
  /** The provider being changed, `{ id: null }` for one being added, or null. */
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  useEffect(() => {
    app.request("providers.kinds", {}).then(
      (answer) => setKinds(answer.kinds),
      () => {},
    );
  }, [app]);
  const edited = providers.find((provider) => provider.id === editing?.id) ?? null;
  return (
    <>
      <h2>Model providers</h2>
      {providers.length || !editing ? (
        <div className="card">
          {providers.map((provider) =>
            provider.id === editing?.id ? null : (
              <ProviderRow
                key={provider.id}
                provider={provider}
                onEdit={() => setEditing({ id: provider.id })}
              />
            ),
          )}
          {editing === null ? (
            <div className="setting">
              <div className="grow caption muted">
                {providers.length
                  ? "Their models appear in the model menu, under each provider's name."
                  : "Use models from Anthropic, Google, OpenRouter and others with your own key, or any OpenAI- or Anthropic-compatible endpoint."}
              </div>
              <button type="button" className="button" onClick={() => setEditing({ id: null })}>
                <Icon name="plus" /> Add provider
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {editing !== null ? (
        <ProviderForm
          key={editing.id ?? ""}
          provider={edited}
          kinds={kinds}
          onDone={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

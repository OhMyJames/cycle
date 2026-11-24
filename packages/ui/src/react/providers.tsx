// The owner's own model providers (docs/protocol.md §10 "自带模型"), on the page of the agent that runs on them: what a
// location's daemon keeps, one location at a time, as the harness page chooses it. A key is only ever written here: the
// daemon says there is one (`hasKey`), and no field of this page is filled from one.
import { Button } from "@ui-sdk/react/button";
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CUSTOM_PROVIDER_KIND,
  type LocationConfig,
  PROVIDER_APIS,
  type ProviderApi,
  type ProviderDraft,
  type ProviderInfo,
  type ProviderKind,
  type ProviderModel,
  type ProviderProblem,
} from "../api.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { CheckIcon, CloseIcon, MoreIcon, PlusIcon } from "./icons.tsx";
import { PageGroup, PageRow, PageRows } from "./page-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

type Problem = { problem: ProviderProblem; message?: string | undefined };

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

/** An address as the daemon compares it: no space around it, no slashes at its end. */
export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? "").trim().replace(/\/+$/, "") === (b ?? "").trim().replace(/\/+$/, "");

const useProblemText = (location: LocationConfig) => {
  const { t } = useI18n();
  return (p: Problem) =>
    t(`providers.problem.${p.problem}`, { location: location.name, reason: p.message ?? "" });
};

/** The model providers of one location, as a group of the agent's page. Read when it is shown; kept up by events. */
export function ProvidersGroup({ location }: { location: LocationConfig }) {
  const { t } = useI18n();
  const store = useAppStore();
  const problemText = useProblemText(location);
  const locationId = location.id;
  const read = useAppState((s) => s.providers[locationId]);
  const list = read?.read?.providers;
  const kinds = read?.read?.kinds ?? [];
  /** The form, opened over the page: for a new provider, or one that is there. */
  const [editing, setEditing] = useState<ProviderInfo | "new" | undefined>(undefined);
  const [removing, setRemoving] = useState<ProviderInfo | undefined>(undefined);

  useEffect(() => {
    void store.loadProviders(locationId);
  }, [store, locationId]);

  const add = (
    <Button data-variant="outline" onClick={() => setEditing("new")}>
      {t("providers.add")}
    </Button>
  );
  return (
    <PageGroup
      title={t("providers.title")}
      lead={t("providers.lead", { location: location.name })}
      action={list !== undefined && list.length > 0 ? add : undefined}
    >
      {read?.error !== undefined ? (
        <StateBlock
          size="inline"
          align="start"
          tone="error"
          title={t("providers.unreadable")}
          reason={read.error}
          action={{
            label: t("providers.retry"),
            onAction: () => void store.loadProviders(locationId),
          }}
        />
      ) : null}
      {list === undefined ? (
        read?.error === undefined ? (
          <StateBlock size="inline" align="start" tone="loading" title={t("providers.loading")} />
        ) : null
      ) : list.length === 0 ? (
        <StateBlock
          size="inline"
          align="start"
          tone="empty"
          title={t("providers.empty")}
          body={t("providers.emptyBody")}
          action={{ label: t("providers.add"), onAction: () => setEditing("new") }}
        />
      ) : (
        <PageRows>
          {list.map((provider) => {
            const kindName =
              provider.kind === CUSTOM_PROVIDER_KIND
                ? t("providers.form.kind.custom")
                : (kinds.find((k) => k.id === provider.kind)?.name ?? provider.kind);
            return (
              <PageRow
                key={provider.id}
                label={provider.name}
                description={
                  <>
                    <span data-slot="connector-status">{kindName}</span>
                    <span data-slot="connector-status">
                      {t("providers.models", { count: provider.models.length })}
                    </span>
                    <span data-slot="connector-status" data-key={provider.hasKey}>
                      {t(provider.hasKey ? "providers.key.saved" : "providers.key.none")}
                    </span>
                    {provider.baseUrl !== null ? (
                      <code data-slot="connector-where" title={provider.baseUrl}>
                        {provider.baseUrl}
                      </code>
                    ) : null}
                  </>
                }
              >
                <Menu
                  onAction={(value) => {
                    if (value === "edit") setEditing(provider);
                    else if (value === "remove") setRemoving(provider);
                  }}
                >
                  <Tip label={t("providers.actions", { name: provider.name })}>
                    <MenuTrigger data-variant="ghost">
                      <MoreIcon />
                    </MenuTrigger>
                  </Tip>
                  <MenuContent align="end">
                    <MenuItem value="edit">{t("providers.edit")}</MenuItem>
                    <MenuItem value="remove" data-destructive>
                      {t("providers.remove")}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </PageRow>
            );
          })}
        </PageRows>
      )}
      {editing !== undefined ? (
        <ProviderFormDialog
          location={location}
          kinds={kinds}
          editing={editing === "new" ? undefined : editing}
          onDone={() => setEditing(undefined)}
        />
      ) : null}
      {removing !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRemoving(undefined)}
          title={t("providers.removeTitle", { name: removing.name })}
          description={t("providers.removeDescription", { location: location.name })}
          confirmLabel={t("providers.removeConfirm")}
          destructive
          onConfirm={async () => {
            const answer = await store.removeProvider(locationId, removing.id);
            if ("problem" in answer) return problemText(answer);
            return undefined;
          }}
        />
      ) : null}
    </PageGroup>
  );
}

type Row = { key: number; model: ProviderModel };
type KeyMode = "keep" | "replace" | "remove";
type Catalog =
  | { state: "loading" }
  | { state: "ready"; models: ProviderModel[] }
  | { state: "error"; message: string | undefined };

const emptyModel = (): ProviderModel => ({
  id: "",
  name: "",
  reasoning: false,
  images: false,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS,
});

/** One provider's fields, in a dialog over the page: mounted when it opens, so it starts from what is being edited. */
function ProviderFormDialog(props: {
  location: LocationConfig;
  kinds: ProviderKind[];
  editing: ProviderInfo | undefined;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const problemText = useProblemText(props.location);
  const before = props.editing;
  const [kind, setKind] = useState(before?.kind ?? props.kinds[0]?.id ?? CUSTOM_PROVIDER_KIND);
  const custom = kind === CUSTOM_PROVIDER_KIND;
  const [name, setName] = useState(before?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(before?.baseUrl ?? "");
  const [api, setApi] = useState<ProviderApi>(before?.api ?? "openai-completions");
  const [keyMode, setKeyMode] = useState<KeyMode>(before?.hasKey === true ? "keep" : "replace");
  const [key, setKey] = useState("");
  /** The known service's models that are ticked, by id. */
  const [chosen, setChosen] = useState<ReadonlyMap<string, ProviderModel>>(
    new Map(
      before !== undefined && before.kind !== CUSTOM_PROVIDER_KIND
        ? before.models.map((m) => [m.id, m])
        : [],
    ),
  );
  const [counter, setCounter] = useState(1);
  const [rows, setRows] = useState<Row[]>(
    before !== undefined && before.kind === CUSTOM_PROVIDER_KIND
      ? before.models.map((model, key) => ({ key: -key - 1, model }))
      : [{ key: 0, model: emptyModel() }],
  );
  const [catalog, setCatalog] = useState<Catalog>({ state: "loading" });
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const locationId = props.location.id;
  /** Which asking of the catalog is the latest: an answer to an earlier one (another service, a retry) is dropped. */
  const asked = useRef(0);
  const fetchCatalog = useCallback(() => {
    const mine = ++asked.current;
    setCatalog({ state: "loading" });
    void store.providerCatalog(locationId, kind).then((answer) => {
      if (asked.current !== mine) return;
      setCatalog(
        "models" in answer
          ? { state: "ready", models: answer.models }
          : { state: "error", message: answer.message },
      );
    });
  }, [store, locationId, kind]);
  useEffect(() => {
    if (kind !== CUSTOM_PROVIDER_KIND) fetchCatalog();
    return () => {
      asked.current++;
    };
  }, [kind, fetchCatalog]);

  // The models a known service lists, and any the provider has that the list no longer shows: they stay ticked.
  const offered: ProviderModel[] =
    catalog.state === "ready"
      ? [
          ...catalog.models,
          ...[...chosen.values()].filter((m) => !catalog.models.some((c) => c.id === m.id)),
        ]
      : [...chosen.values()];

  const models = (): ProviderModel[] =>
    custom
      ? rows
          .filter((r) => r.model.id.trim() !== "")
          .map(({ model }) => ({
            ...model,
            id: model.id.trim(),
            name: model.name.trim() || model.id.trim(),
            contextWindow: model.contextWindow > 0 ? model.contextWindow : DEFAULT_CONTEXT_WINDOW,
            maxTokens: model.maxTokens > 0 ? model.maxTokens : DEFAULT_MAX_TOKENS,
          }))
      : offered.filter((m) => chosen.has(m.id));

  const picked = models();
  const addressChanged = before !== undefined && !sameAddress(baseUrl, before.baseUrl);
  const ready = (!custom || baseUrl.trim() !== "") && picked.length > 0;

  const draft = (): ProviderDraft => ({
    ...(before !== undefined ? { id: before.id } : {}),
    name: name.trim(),
    kind,
    api: custom ? api : null,
    baseUrl: baseUrl.trim() === "" ? null : baseUrl.trim(),
    // Only written when the person said so: a key not given is kept by the daemon, and never read back to be sent again.
    ...(keyMode === "remove"
      ? { apiKey: "" }
      : keyMode === "replace" && key.trim() !== ""
        ? { apiKey: key.trim() }
        : {}),
    models: picked,
  });

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const answer = await store.saveProvider(locationId, draft());
      if ("provider" in answer) props.onDone();
      else setProblem(answer);
    } finally {
      setBusy(false);
    }
  };

  const patchRow = (rowKey: number, change: Partial<ProviderModel>) =>
    setRows((list) =>
      list.map((r) => (r.key === rowKey ? { ...r, model: { ...r.model, ...change } } : r)),
    );

  const toggle = (model: ProviderModel) =>
    setChosen((was) => {
      const next = new Map(was);
      if (next.has(model.id)) next.delete(model.id);
      else next.set(model.id, model);
      return next;
    });

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onDone()}>
      <DialogBackdrop />
      <DialogContent data-kind="provider-form">
        <DialogTitle>
          {before === undefined
            ? t("providers.form.addTitle")
            : t("providers.form.editTitle", { name: before.name })}
        </DialogTitle>
        <form
          data-slot="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {before === undefined ? (
            <Field name="kind">
              <FieldLabel>{t("providers.form.kind")}</FieldLabel>
              <Select
                items={[
                  ...props.kinds.map((k) => ({ value: k.id, label: k.name })),
                  { value: CUSTOM_PROVIDER_KIND, label: t("providers.form.kind.custom") },
                ]}
                value={kind}
                onValueChange={(next) => {
                  if (typeof next !== "string" || next === kind) return;
                  setKind(next);
                  setChosen(new Map());
                }}
              >
                <SelectTrigger autoFocus>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {props.kinds.map((k) => (
                    <SelectItem key={k.id} value={k.id}>
                      {k.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_PROVIDER_KIND}>
                    {t("providers.form.kind.custom")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field name="name">
            <FieldLabel>{t("providers.form.name")}</FieldLabel>
            <Input
              autoFocus={before !== undefined}
              value={name}
              placeholder={props.kinds.find((k) => k.id === kind)?.name ?? ""}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <FieldDescription>{t("providers.form.nameHint")}</FieldDescription>
          </Field>
          {custom ? (
            <Field name="api">
              <FieldLabel>{t("providers.form.api")}</FieldLabel>
              <Select
                items={PROVIDER_APIS.map((a) => ({ value: a, label: t(`providers.api.${a}`) }))}
                value={api}
                onValueChange={(next) => {
                  if (typeof next === "string") setApi(next as ProviderApi);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDER_APIS.map((a) => (
                    <SelectItem key={a} value={a}>
                      {t(`providers.api.${a}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field name="baseUrl">
            <FieldLabel>{t("providers.form.address")}</FieldLabel>
            <Input
              value={baseUrl}
              placeholder="https://"
              spellCheck={false}
              onChange={(e) => setBaseUrl(e.currentTarget.value)}
            />
            {custom ? null : <FieldDescription>{t("providers.form.addressHint")}</FieldDescription>}
          </Field>
          <Field name="apiKey">
            <FieldLabel>{t("providers.form.apiKey")}</FieldLabel>
            {keyMode === "keep" ? (
              <div data-slot="row">
                <span data-slot="secret-name">{t("providers.form.keySaved")}</span>
                <Button type="button" data-variant="ghost" onClick={() => setKeyMode("replace")}>
                  {t("providers.form.keyReplace")}
                </Button>
                <Button type="button" data-variant="ghost" onClick={() => setKeyMode("remove")}>
                  {t("providers.form.keyRemove")}
                </Button>
              </div>
            ) : keyMode === "remove" ? (
              <div data-slot="row">
                <span data-slot="secret-name" data-removed>
                  {t("providers.form.keyRemoving")}
                </span>
                <Button type="button" data-variant="ghost" onClick={() => setKeyMode("keep")}>
                  {t("providers.form.keyKeep")}
                </Button>
              </div>
            ) : (
              <div data-slot="row">
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(e) => setKey(e.currentTarget.value)}
                />
                {before?.hasKey === true ? (
                  <Button
                    type="button"
                    data-variant="ghost"
                    onClick={() => {
                      setKey("");
                      setKeyMode("keep");
                    }}
                  >
                    {t("providers.form.keyKeep")}
                  </Button>
                ) : null}
              </div>
            )}
            <FieldDescription>
              {t("providers.form.apiKeyHint", { location: props.location.name })}
            </FieldDescription>
            {addressChanged && before?.hasKey === true && keyMode === "keep" ? (
              <FieldDescription role="status">{t("providers.form.keyAddress")}</FieldDescription>
            ) : null}
          </Field>
          <fieldset data-slot="provider-models">
            <legend>{t("providers.form.models")}</legend>
            {custom ? (
              <>
                {rows.map((row) => (
                  <div key={row.key} data-slot="provider-model-row">
                    <div data-slot="row">
                      <Input
                        aria-label={t("providers.form.modelId")}
                        placeholder={t("providers.form.modelId")}
                        spellCheck={false}
                        value={row.model.id}
                        onChange={(e) => patchRow(row.key, { id: e.currentTarget.value })}
                      />
                      <Input
                        aria-label={t("providers.form.modelName")}
                        placeholder={t("providers.form.modelName")}
                        value={row.model.name}
                        onChange={(e) => patchRow(row.key, { name: e.currentTarget.value })}
                      />
                      <Tip label={t("providers.form.modelRemove")}>
                        <Button
                          type="button"
                          data-variant="ghost"
                          disabled={rows.length === 1}
                          onClick={() => setRows((list) => list.filter((r) => r.key !== row.key))}
                        >
                          <CloseIcon />
                        </Button>
                      </Tip>
                    </div>
                    <div data-slot="row">
                      <label data-slot="form-option">
                        <input
                          type="checkbox"
                          checked={row.model.reasoning}
                          onChange={(e) =>
                            patchRow(row.key, { reasoning: e.currentTarget.checked })
                          }
                        />
                        <span data-slot="form-mark" data-several aria-hidden="true">
                          <CheckIcon size={12} />
                        </span>
                        <span data-slot="option-name">{t("providers.form.reasoning")}</span>
                      </label>
                      <label data-slot="form-option">
                        <input
                          type="checkbox"
                          checked={row.model.images}
                          onChange={(e) => patchRow(row.key, { images: e.currentTarget.checked })}
                        />
                        <span data-slot="form-mark" data-several aria-hidden="true">
                          <CheckIcon size={12} />
                        </span>
                        <span data-slot="option-name">{t("providers.form.images")}</span>
                      </label>
                      <Input
                        inputMode="numeric"
                        aria-label={t("providers.form.context")}
                        placeholder={t("providers.form.context")}
                        value={row.model.contextWindow > 0 ? String(row.model.contextWindow) : ""}
                        onChange={(e) =>
                          patchRow(row.key, {
                            contextWindow: Number.parseInt(e.currentTarget.value, 10) || 0,
                          })
                        }
                      />
                    </div>
                  </div>
                ))}
                <div data-slot="row">
                  <Button
                    type="button"
                    data-variant="ghost"
                    onClick={() => {
                      setRows((list) => [...list, { key: counter, model: emptyModel() }]);
                      setCounter((n) => n + 1);
                    }}
                  >
                    <PlusIcon />
                    {t("providers.form.modelAdd")}
                  </Button>
                </div>
              </>
            ) : catalog.state === "loading" && offered.length === 0 ? (
              <p data-slot="hint" role="status">
                {t("providers.form.modelsLoading")}
              </p>
            ) : (
              <>
                {catalog.state === "error" ? (
                  <div data-slot="row">
                    <p data-slot="hint" role="alert">
                      {t("providers.form.modelsUnreadable")}
                      {catalog.message !== "" ? (
                        <code data-slot="reason">{catalog.message}</code>
                      ) : null}
                    </p>
                    <Button type="button" data-variant="ghost" onClick={() => fetchCatalog()}>
                      {t("providers.retry")}
                    </Button>
                  </div>
                ) : null}
                {catalog.state === "ready" && offered.length === 0 ? (
                  <p data-slot="hint">{t("providers.form.modelsEmpty")}</p>
                ) : null}
                <div data-slot="form-options">
                  {offered.map((model) => (
                    <label key={model.id} data-slot="form-option">
                      <input
                        type="checkbox"
                        checked={chosen.has(model.id)}
                        onChange={() => toggle(model)}
                      />
                      <span data-slot="form-mark" data-several aria-hidden="true">
                        <CheckIcon size={12} />
                      </span>
                      <span data-slot="option">
                        <span data-slot="option-name">{model.name || model.id}</span>
                        {model.name !== "" && model.name !== model.id ? (
                          <span data-slot="option-description">{model.id}</span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </fieldset>
          {problem !== undefined ? (
            <p data-slot="hint" role="alert">
              {problemText(problem)}
            </p>
          ) : null}
          <div data-slot="row" data-dialog-footer="">
            <DialogClose disabled={busy}>{t("dialog.cancel")}</DialogClose>
            <Button data-variant="solid" type="submit" disabled={!ready || busy}>
              {t(before === undefined ? "providers.form.create" : "providers.form.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// The vault (docs/protocol.md §6 "环境"), on its page of Settings: the keys of a location's `secrets.env`, which an
// environment's secrets name. One location at a time. A value is only ever written here: the daemon says which keys
// have one, and no field of this page is filled from one, so it is never shown.
import { Button } from "@ui-sdk/react/button";
import { Dialog, DialogBackdrop, DialogContent, DialogTitle } from "@ui-sdk/react/dialog";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { type RefObject, useEffect, useMemo, useState } from "react";
import type { LocationConfig, LocationStatus, VaultProblem } from "../api.ts";
import { VARIABLE_NAME } from "../environments.ts";
import { ConfirmDialog, FormDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon } from "./icons.tsx";
import { LocationScope } from "./location-scope.tsx";
import { PageRow, PageRows, ResourceGroup } from "./page-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

type Problem = { problem: VaultProblem; message?: string | undefined };

/** What a value is drawn as: a fixed run of dots, so neither the value nor its length is on the page. */
const HIDDEN_VALUE = "••••••••";

const useProblemText = (location: LocationConfig) => {
  const { t } = useI18n();
  return (p: Problem) =>
    t(`vault.problem.${p.problem}`, { location: location.name, reason: p.message ?? "" });
};

/** The vault page: the keys of the location that is chosen. */
export function VaultSection(props: {
  locations: LocationConfig[];
  status: Record<string, LocationStatus>;
  locationId: string | undefined;
  onLocationChange: (locationId: string) => void;
  onShowLocations: () => void;
  knownSetup: RefObject<Record<string, boolean>>;
}) {
  return (
    <LocationScope {...props}>
      {(location) => <VaultGroup key={location.id} location={location} />}
    </LocationScope>
  );
}

/** The names of the environments that take a key's value, by key: an environment's secret reads `from`, else its name. */
const usedByKey = (
  environments: readonly { name: string; secrets: readonly { name: string; from?: string }[] }[],
): Map<string, string[]> => {
  const used = new Map<string, string[]>();
  for (const environment of environments)
    for (const secret of environment.secrets) {
      const key = secret.from ?? secret.name;
      const names = used.get(key) ?? [];
      if (!names.includes(environment.name)) used.set(key, [...names, environment.name]);
    }
  return used;
};

/** The keys of one location. Read when it is shown. */
function VaultGroup({ location }: { location: LocationConfig }) {
  const { t } = useI18n();
  const store = useAppStore();
  const problemText = useProblemText(location);
  const locationId = location.id;
  const read = useAppState((s) => s.vault[locationId]);
  const environments = useAppState((s) => s.environments?.environments);
  const keys = read?.keys;
  const used = useMemo(() => usedByKey(environments ?? []), [environments]);
  const [query, setQuery] = useState("");
  /** The item whose details are open, the form (a new item, or the key whose value is replaced), the key being removed. */
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<string | "new" | undefined>(undefined);
  const [removing, setRemoving] = useState<string | undefined>(undefined);

  useEffect(() => {
    void store.loadVault(locationId);
  }, [store, locationId]);

  return (
    <>
      <ResourceGroup
        lead={t("vault.lead", { location: location.name })}
        items={keys}
        error={read?.error}
        onRetry={() => void store.loadVault(locationId)}
        says={{
          loading: t("vault.loading"),
          unreadable: t("vault.unreadable"),
          retry: t("vault.retry"),
          empty: t("vault.empty"),
          emptyBody: t("vault.emptyBody"),
        }}
        add={{ label: t("vault.add"), onAdd: () => setEditing("new") }}
      >
        {(keys) => {
          const shown = keys.filter((key) =>
            key.toLowerCase().includes(query.trim().toLowerCase()),
          );
          return (
            <>
              <Input
                type="search"
                data-kind="vault-search"
                aria-label={t("vault.search")}
                placeholder={t("vault.search")}
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
              {shown.length === 0 ? (
                <StateBlock size="inline" align="start" tone="empty" title={t("vault.noMatch")} />
              ) : (
                <PageRows>
                  {shown.map((key) => {
                    const names = used.get(key);
                    return (
                      <PageRow
                        key={key}
                        label={key}
                        description={
                          <span data-slot="connector-status">
                            {names !== undefined
                              ? t("vault.usedBy", { names: names.join(", ") })
                              : t("vault.unused")}
                          </span>
                        }
                      >
                        <Tip label={t("vault.open", { name: key })}>
                          <Button data-variant="ghost" onClick={() => setSelected(key)}>
                            <ChevronRightIcon />
                          </Button>
                        </Tip>
                      </PageRow>
                    );
                  })}
                </PageRows>
              )}
            </>
          );
        }}
      </ResourceGroup>
      {selected !== undefined ? (
        <VaultDetailDialog
          itemKey={selected}
          usedBy={used.get(selected) ?? []}
          onEdit={() => {
            setEditing(selected);
            setSelected(undefined);
          }}
          onRemove={() => {
            setRemoving(selected);
            setSelected(undefined);
          }}
          onDone={() => setSelected(undefined)}
        />
      ) : null}
      {editing !== undefined ? (
        <VaultFormDialog
          location={location}
          existing={keys ?? []}
          editing={editing === "new" ? undefined : editing}
          onDone={() => setEditing(undefined)}
        />
      ) : null}
      {removing !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRemoving(undefined)}
          title={t("vault.removeTitle", { name: removing })}
          description={t("vault.removeDescription", { location: location.name })}
          confirmLabel={t("vault.removeConfirm")}
          destructive
          onConfirm={async () => {
            const answer = await store.removeVaultItem(locationId, removing);
            return "problem" in answer ? problemText(answer) : undefined;
          }}
        />
      ) : null}
    </>
  );
}

/** One item: its name, its value as dots (never the value), and which environments use it. */
function VaultDetailDialog(props: {
  itemKey: string;
  usedBy: string[];
  onEdit: () => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open onOpenChange={(open) => !open && props.onDone()}>
      <DialogBackdrop />
      <DialogContent data-kind="vault-detail">
        <DialogTitle>{props.itemKey}</DialogTitle>
        <dl data-slot="vault-fields">
          <div>
            <dt>{t("vault.detail.name")}</dt>
            <dd data-slot="vault-mono">{props.itemKey}</dd>
          </div>
          <div>
            <dt>{t("vault.detail.value")}</dt>
            <dd role="img" aria-label={t("vault.detail.hidden")}>
              {HIDDEN_VALUE}
            </dd>
          </div>
          <div>
            <dt>{t("vault.detail.usedBy")}</dt>
            <dd>{props.usedBy.length > 0 ? props.usedBy.join(", ") : t("vault.unused")}</dd>
          </div>
        </dl>
        <div data-slot="row" data-dialog-footer="">
          <Button data-variant="destructive" onClick={props.onRemove}>
            {t("vault.detail.remove")}
          </Button>
          <span data-slot="spacer" />
          <Button data-variant="outline" onClick={props.onEdit}>
            {t("vault.detail.edit")}
          </Button>
          <Button data-variant="solid" autoFocus onClick={props.onDone}>
            {t("vault.detail.done")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A new item, or a new value for one that is there: mounted when it opens, so it always starts empty. */
function VaultFormDialog(props: {
  location: LocationConfig;
  existing: readonly string[];
  /** The key whose value is replaced; none for a new item. */
  editing: string | undefined;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const problemText = useProblemText(props.location);
  const [name, setName] = useState(props.editing ?? "");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  const key = name.trim();
  const replacing = props.editing !== undefined || props.existing.includes(key);

  const save = async () => {
    setProblem(undefined);
    const answer = await store.setVaultItem(props.location.id, key, value);
    if ("done" in answer) return true;
    setProblem(answer);
    return false;
  };

  return (
    <FormDialog
      kind="vault-form"
      title={
        props.editing === undefined
          ? t("vault.form.addTitle")
          : t("vault.form.editTitle", { name: props.editing })
      }
      ready={VARIABLE_NAME.test(key) && value !== ""}
      submitLabel={t(props.editing === undefined ? "vault.form.create" : "vault.form.save")}
      onSubmit={save}
      onClose={props.onDone}
      problem={problem !== undefined ? problemText(problem) : undefined}
    >
      {props.editing !== undefined ? (
        // The name of a key that is there is not changed here, and a field that cannot be edited is not one the
        // focus should land on: it is said as text, and the focus goes to the value.
        <div data-slot="vault-name">
          <span data-slot="vault-name-label">{t("vault.form.name")}</span>
          <span data-slot="vault-mono">{props.editing}</span>
        </div>
      ) : (
        <Field name="name" invalid={key !== "" && !VARIABLE_NAME.test(key)}>
          <FieldLabel>{t("vault.form.name")}</FieldLabel>
          <Input
            autoFocus
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            value={name}
            placeholder={t("vault.form.namePlaceholder")}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <FieldDescription>{t("vault.form.nameHint")}</FieldDescription>
          {replacing ? (
            <FieldDescription role="status">
              {t("vault.form.exists", { name: key })}
            </FieldDescription>
          ) : null}
        </Field>
      )}
      <Field name="value">
        <FieldLabel>{t("vault.form.value")}</FieldLabel>
        <Input
          type="password"
          autoFocus={props.editing !== undefined}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
        />
        <FieldDescription>
          {t(props.editing !== undefined ? "vault.form.valueReplace" : "vault.form.valueHint", {
            location: props.location.name,
          })}
        </FieldDescription>
      </Field>
    </FormDialog>
  );
}

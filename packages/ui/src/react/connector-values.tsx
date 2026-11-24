// The values a plugin's server leaves to the person (docs/protocol.md §14 `requires`): a key the plugin's headers name
// and nobody but the person has. They go to the location's daemon and are never read back, so a field shows only
// whether it has one.
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
import { useState } from "react";
import type { ConnectorInfo, ConnectorProblem, LocationConfig } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { useAppStore } from "./store-context.tsx";

export function ConnectorValuesDialog({
  location,
  connector,
  onDone,
}: {
  location: LocationConfig;
  connector: ConnectorInfo;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const names = connector.requires ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<
    { problem: ConnectorProblem; message?: string | undefined } | undefined
  >(undefined);
  const written = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
  const ready = Object.keys(written).length > 0;
  const title = connector.origin?.server ?? connector.name;

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const answer = await store.updateConnector(location.id, connector.id, {
        secrets: { env: written },
      });
      if ("connector" in answer) onDone();
      else setProblem(answer);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onDone()}>
      <DialogBackdrop />
      <DialogContent data-kind="connector-values">
        <DialogTitle>{t("connectors.values.title", { name: title })}</DialogTitle>
        <form
          data-slot="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p data-slot="hint">{t("connectors.values.hint", { location: location.name })}</p>
          {names.map((name, at) => (
            <Field key={name} name={name}>
              <FieldLabel>
                <code>{name}</code>
              </FieldLabel>
              <Input
                type="password"
                autoComplete="off"
                autoFocus={at === 0}
                value={values[name] ?? ""}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setValues((v) => ({ ...v, [name]: value }));
                }}
              />
              {connector.secrets.env.includes(name) ? (
                <FieldDescription>{t("connectors.values.set", { name })}</FieldDescription>
              ) : null}
            </Field>
          ))}
          {problem !== undefined ? (
            <p data-slot="hint" role="alert">
              {t(`connectors.problem.${problem.problem}`, {
                location: location.name,
                reason: problem.message ?? "",
              })}
            </p>
          ) : null}
          <div data-slot="row" data-dialog-footer="">
            <DialogClose disabled={busy}>{t("dialog.cancel")}</DialogClose>
            <Button data-variant="solid" type="submit" disabled={!ready || busy}>
              {t("connectors.values.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// The values a plugin's server leaves to the person (docs/protocol.md §14 `requires`): a key the plugin's headers name
// and nobody but the person has. They go to the location's daemon and are never read back, so a field shows only
// whether it has one.
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { useState } from "react";
import type { ConnectorInfo, ConnectorProblem, LocationConfig } from "../api.ts";
import { FormDialog } from "./dialogs.tsx";
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
  const [problem, setProblem] = useState<
    { problem: ConnectorProblem; message?: string | undefined } | undefined
  >(undefined);
  const written = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
  const title = connector.origin?.server ?? connector.name;

  const save = async () => {
    setProblem(undefined);
    const answer = await store.updateConnector(location.id, connector.id, {
      secrets: { env: written },
    });
    if ("connector" in answer) return true;
    setProblem(answer);
    return false;
  };

  return (
    <FormDialog
      kind="connector-values"
      title={t("connectors.values.title", { name: title })}
      ready={Object.keys(written).length > 0}
      submitLabel={t("connectors.values.save")}
      onSubmit={save}
      onClose={onDone}
      problem={
        problem !== undefined
          ? t(`connectors.problem.${problem.problem}`, {
              location: location.name,
              reason: problem.message ?? "",
            })
          : undefined
      }
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
    </FormDialog>
  );
}

import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { useMemo } from "react";
import { DISPLAY_MODES, displayMode, isDisplayMode } from "../display-mode.ts";
import { viewKey } from "../store/index.ts";
import { ConfigForm, mergeConfigSchema, OptionLabel, propertiesOf } from "./config-form.tsx";
import { useI18n } from "./i18n.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { useDisplayMode } from "./thought.tsx";

/**
 * A session's settings: the agent's (model, mode, effort…), which reach it through the daemon and so only while its
 * location is connected, and how the session is shown here, which is always there.
 */
export function SessionSettings({
  connected,
  onClose,
}: {
  connected: boolean;
  onClose: () => void;
}) {
  const store = useAppStore();
  const { t } = useI18n();
  const location = useAppState((s) => s.selectedLocation);
  const sessionId = useAppState((s) => s.selectedSession);
  const sessions = useAppState((s) => (location !== undefined ? s.sessions[location] : undefined));
  const agents = useAppState((s) => (location !== undefined ? s.agents[location] : undefined));
  const session = sessions?.find((x) => x.sessionId === sessionId);
  const agent = agents?.find((a) => a.id === session?.agent);
  const liveConfigOptions = useAppState((s) =>
    location !== undefined && sessionId !== undefined
      ? s.views[viewKey(location, sessionId)]?.conversation.configOptions
      : undefined,
  );
  const schema = useMemo(
    () =>
      agent === undefined ? undefined : mergeConfigSchema(agent.configSchema, liveConfigOptions),
    [agent, liveConfigOptions],
  );
  if (session === undefined || location === undefined) return null;
  const agentSettings = schema !== undefined && propertiesOf(schema).length > 0;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogBackdrop />
      <DialogContent>
        <DialogTitle>{t("session.settings")}</DialogTitle>
        {/* What it says is of the agent's settings: when they are not here, why. */}
        {!agentSettings ? null : connected ? (
          <DialogDescription>{t("session.settingsDescription")}</DialogDescription>
        ) : (
          <DialogDescription>{t("session.settingsOffline")}</DialogDescription>
        )}
        {connected && agentSettings ? (
          <ConfigForm
            schema={schema ?? {}}
            value={session.config ?? {}}
            defaults={false}
            live
            onChange={(next) => {
              // One setting at a time: the form hands back the whole set, and only what changed is sent.
              const before = session.config ?? {};
              for (const [key, value] of Object.entries(next)) {
                if (before[key] !== value) void store.setSessionConfig(key, value);
              }
            }}
          />
        ) : null}
        <DisplayModeField sessionKey={viewKey(location, session.sessionId)} />
        <div data-slot="row" data-dialog-footer="">
          <DialogClose>{t("dialog.close")}</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A session's display mode, with its agent settings: normal leaves the agent's thinking out of the conversation, detailed
 * shows it. Kept on this machine and not sent to the agent (display-mode.ts), so it is drawn here, not from the agent's
 * schema, and applies at once.
 */
function DisplayModeField({ sessionKey }: { sessionKey: string }) {
  const store = useAppStore();
  const { t } = useI18n();
  const mode = useDisplayMode(sessionKey);
  const options = DISPLAY_MODES.map((value) => ({
    value,
    label: t(`session.display.${value}`),
    description: t(`session.display.${value}.description`),
  }));
  return (
    <div data-slot="config-form">
      <Field name="display">
        <FieldLabel>{t("session.display")}</FieldLabel>
        <Select
          items={options.map((o) => ({ value: o.value, label: o.label }))}
          value={mode}
          onValueChange={(next) => {
            if (!isDisplayMode(next) || next === mode) return;
            displayMode.set(sessionKey, next);
            store.track("display_mode_changed", { mode: next });
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value} label={o.label}>
                <OptionLabel option={o} />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>{t("session.display.description")}</FieldDescription>
      </Field>
    </div>
  );
}

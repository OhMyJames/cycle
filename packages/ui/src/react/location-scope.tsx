// The location a page of Settings is about, chosen once for the pages that keep something on a location's daemon
// (the Subscriptions and API keys pages): the one the person chose, kept through a reconnect, else the first that is
// connected. With more than one to choose from, the choice is the first thing on the page.
import { Field, FieldLabel } from "@ui-sdk/react/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import type { ReactNode, RefObject } from "react";
import type { LocationConfig, LocationStatus } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { StateBlock } from "./state-block.tsx";

export function LocationScope({
  locations,
  status,
  locationId,
  onLocationChange,
  onShowLocations,
  knownSetup,
  children,
}: {
  locations: LocationConfig[];
  status: Record<string, LocationStatus>;
  locationId: string | undefined;
  onLocationChange: (locationId: string) => void;
  onShowLocations: () => void;
  /** What each daemon last said it can do: kept by the page, so it outlives a section (a tab left and come back to). */
  knownSetup: RefObject<Record<string, boolean>>;
  /** What the page shows for the location; `supportsSetup` is whether its daemon can read an agent's setup. */
  children: (location: LocationConfig, supportsSetup: boolean) => ReactNode;
}) {
  const { t } = useI18n();
  const connected = locations.filter((e) => status[e.id]?.state === "connected");
  // The chosen location stays chosen while it reconnects: swapping it out would unmount the page, and with it a
  // sign-in that is under way.
  const chosen = locations.find((e) => e.id === locationId);
  const holding = chosen !== undefined && status[chosen.id]?.state === "reconnecting";
  const location = holding ? chosen : (connected.find((e) => e.id === locationId) ?? connected[0]);
  const choices = locations.filter(
    (e) => status[e.id]?.state === "connected" || (holding && e === chosen),
  );

  if (location === undefined) {
    return (
      <StateBlock
        size="inline"
        align="start"
        tone="away"
        title={t("settings.defaults.none")}
        body={t("settings.defaults.noneBody")}
        action={{ label: t("settings.defaults.showLocations"), onAction: onShowLocations }}
      />
    );
  }

  // What the daemon said it can do, kept through a reconnect (when it has not said again yet).
  const said = status[location.id]?.capabilities?.agentSetup;
  if (said !== undefined) knownSetup.current[location.id] = said === true;
  const supportsSetup =
    said === true || (said === undefined && knownSetup.current[location.id] === true);

  return (
    <>
      {choices.length > 1 ? (
        <div data-slot="page-form">
          <Field name="location">
            <FieldLabel>{t("settings.defaults.location")}</FieldLabel>
            <Select
              items={choices.map((e) => ({ value: e.id, label: e.name }))}
              value={location.id}
              onValueChange={(next) => {
                if (typeof next === "string") onLocationChange(next);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {choices.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
      ) : null}
      {children(location, supportsSetup)}
    </>
  );
}

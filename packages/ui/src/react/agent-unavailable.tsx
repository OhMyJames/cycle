import type { AgentBinaryStatus } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { StateBlock } from "./state-block.tsx";

export const installCommandOf = (agentId: string): string | undefined =>
  agentId === "agy" ? "curl -fsSL https://antigravity.google/cli/install.sh | bash" : undefined;

/** A daemon's binary diagnosis appears both on the Harness page and beside an agent subscription. */
export function UnavailableBinary({
  binary,
  agentId,
  agentName,
  locationName,
  action,
}: {
  binary: AgentBinaryStatus;
  agentId: string;
  agentName: string;
  locationName: string;
  action: { label: string; onAction: () => void };
}) {
  const { t } = useI18n();
  if (binary.problem === undefined) return null;
  return (
    <StateBlock
      size="inline"
      align="start"
      tone="away"
      title={
        binary.problem === "version_too_old"
          ? t("settings.harness.unavailable.tooOld", {
              agent: agentName,
              version: binary.version ?? "",
              location: locationName,
              minVersion: binary.minVersion ?? "",
            })
          : binary.problem === "probe_failed"
            ? t("settings.harness.unavailable.probeFailed", {
                agent: agentName,
                location: locationName,
              })
            : t("settings.harness.unavailable.missing", {
                agent: agentName,
                location: locationName,
              })
      }
      reason={installCommandOf(agentId)}
      action={action}
    />
  );
}

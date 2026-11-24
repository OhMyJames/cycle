// What an agent keeps in its home on one location (docs/protocol.md §16 "本地存储"), at the end of its Harness page: the
// package caches, which can be cleared, and the session records, which are only shown. The daemon decides what is a
// cache; this page never names a folder.
import { Button } from "@ui-sdk/react/button";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LocationConfig, StorageAgent, StorageCleanAnswer } from "../api.ts";
import { ConfirmDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { PageGroup, PageRow, PageRows } from "./page-layout.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppStore } from "./store-context.tsx";

type NumberFormat = ReturnType<typeof useI18n>["number"];

/** A size as people read it, in the person's language: "820 byte", "1.5 kB", "120 MB", "1.9 GB". */
export const bytesText = (number: NumberFormat, bytes: number): string => {
  const unit = (value: number, name: string, digits: number) =>
    number(value, {
      style: "unit",
      unit: name,
      unitDisplay: "short",
      maximumFractionDigits: digits,
    });
  // The unit is chosen after rounding: 999,600 bytes is 1 MB, not "1,000 kB".
  if (bytes < 1000) return unit(bytes, "byte", 0);
  if (bytes < 999_500) return unit(bytes / 1000, "kilobyte", bytes < 10_000 ? 1 : 0);
  if (bytes < 999_500_000) return unit(bytes / 1_000_000, "megabyte", bytes < 10_000_000 ? 1 : 0);
  return unit(bytes / 1_000_000_000, "gigabyte", 1);
};

const total = (agent: StorageAgent, kind: "cache" | "history"): number =>
  agent.items.filter((i) => i.kind === kind).reduce((sum, i) => sum + i.bytes, 0);

export function StorageGroup({
  location,
  agentId,
  agentName,
}: {
  location: LocationConfig;
  agentId: string;
  agentName: string;
}) {
  const { t, number } = useI18n();
  const store = useAppStore();
  const locationId = location.id;
  const [agent, setAgent] = useState<StorageAgent | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  /** The size the person was shown when they asked, so the question does not change as the answer comes in. */
  const [confirming, setConfirming] = useState<number | undefined>(undefined);
  /** What the last clearing freed, until the next one: the answer to the click, in place. */
  const [freed, setFreed] = useState<number | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const all = await store.readStorage(locationId);
      if (!mounted.current) return;
      setAgent(all.find((a) => a.agent === agentId));
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [store, locationId, agentId]);
  useEffect(() => {
    void read();
  }, [read]);

  const problemText = (answer: Extract<StorageCleanAnswer, { cleaned: false }>) =>
    t(`storage.problem.${answer.problem}`, { agent: agentName, location: location.name });

  const caches = agent !== undefined ? total(agent, "cache") : 0;
  const records = agent !== undefined ? total(agent, "history") : 0;

  return (
    <PageGroup
      title={t("storage.title")}
      lead={t("storage.lead", { agent: agentName, location: location.name })}
    >
      {error !== undefined ? (
        <StateBlock
          size="inline"
          align="start"
          tone="error"
          title={t("storage.unreadable")}
          reason={error}
          action={{ label: t("storage.retry"), onAction: () => void read() }}
        />
      ) : loading && agent === undefined ? (
        <StateBlock size="inline" align="start" tone="loading" title={t("storage.loading")} />
      ) : agent === undefined ? null : agent.managed && agent.items.length === 0 ? (
        <StateBlock
          size="inline"
          align="start"
          tone="empty"
          title={t("storage.empty")}
          body={t("storage.emptyBody", { agent: agentName })}
        />
      ) : !agent.managed ? (
        <StateBlock
          size="inline"
          align="start"
          tone="away"
          title={t("storage.unmanaged")}
          body={t("storage.unmanagedBody", { agent: agentName, location: location.name })}
        />
      ) : (
        <PageRows>
          <PageRow
            label={t("storage.cache")}
            description={
              <>
                <span data-slot="connector-status">{bytesText(number, caches)}</span>
                <span data-slot="connector-status">
                  {freed !== undefined
                    ? t("storage.cleared", { size: bytesText(number, freed) })
                    : t("storage.cache.body")}
                </span>
              </>
            }
          >
            <Button
              data-variant="outline"
              disabled={caches === 0}
              onClick={() => setConfirming(caches)}
            >
              {t("storage.clear")}
            </Button>
          </PageRow>
          {records > 0 ? (
            <PageRow
              label={t("storage.history")}
              description={
                <>
                  <span data-slot="connector-status">{bytesText(number, records)}</span>
                  <span data-slot="connector-status">{t("storage.history.body")}</span>
                </>
              }
            />
          ) : null}
        </PageRows>
      )}
      {confirming !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(undefined)}
          title={t("storage.confirmTitle", { agent: agentName })}
          description={t("storage.confirmDescription", {
            agent: agentName,
            location: location.name,
            size: bytesText(number, confirming),
          })}
          confirmLabel={t("storage.clear")}
          destructive
          onConfirm={async () => {
            let answer: StorageCleanAnswer;
            try {
              answer = await store.cleanStorage(locationId, agentId);
            } catch (reason) {
              return reason instanceof Error ? reason.message : String(reason);
            }
            if (!answer.cleaned) return problemText(answer);
            if (mounted.current) setFreed(answer.freedBytes);
            await read();
            return undefined;
          }}
        />
      ) : null}
    </PageGroup>
  );
}

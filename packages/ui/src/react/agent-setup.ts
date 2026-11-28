// What a location's daemon says of one agent's setup (its account, its runtime, its plan's usage), read for a page of
// Settings (Harness, Subscriptions). Read when the page shows it, and again, quietly, when the daemon says it changed.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSetupSnapshot } from "../api.ts";
import { useAppState, useAppStore } from "./store-context.tsx";

export type SetupRead = { forceRefresh?: boolean; refreshUsage?: boolean; silent?: boolean };

/**
 * One agent's setup on one location. `readable`: the daemon can say it and the agent is listed; otherwise nothing is
 * read. `onApplied` is told each time a read's answer is kept. What it holds is that agent's: a caller that shows
 * another keys its component by location and agent, so it starts over.
 */
export function useAgentSetup(
  locationId: string,
  agentId: string,
  readable: boolean,
  onApplied?: () => void,
) {
  const store = useAppStore();
  const revision = useAppState((s) => s.agentSetupRevision[`${locationId}:${agentId}`] ?? 0);
  const [snapshot, setSnapshot] = useState<AgentSetupSnapshot | undefined>(undefined);
  const [loading, setLoading] = useState(readable);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  const seenRevision = useRef(revision);
  /** Each read is numbered: an answer is kept only if no newer one (or a save) has been kept since. */
  const asked = useRef(0);
  const applied = useRef(0);
  /** The visible reads still out: the spinner is theirs, so a silent read that overtakes one cannot leave it spinning. */
  const pendingLoud = useRef(0);
  const appliedHook = useRef(onApplied);
  appliedHook.current = onApplied;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback(
    async (opts: SetupRead) => {
      if (!readable) return;
      const seq = ++asked.current;
      const loud = opts.silent !== true;
      if (loud) {
        pendingLoud.current += 1;
        if (opts.forceRefresh) setRefreshing(true);
        else setLoading(true);
        setLoadError(undefined);
      }
      try {
        const result = await store.readAgentSetup(locationId, agentId, {
          ...(opts.forceRefresh ? { forceRefresh: true } : {}),
          ...(opts.refreshUsage ? { refreshUsage: true } : {}),
        });
        if (!mounted.current || seq <= applied.current) return;
        applied.current = seq;
        setSnapshot(result);
        setLoadError(undefined);
        appliedHook.current?.();
      } catch (error) {
        if (!mounted.current || seq <= applied.current) return;
        if (loud) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (loud && mounted.current) {
          pendingLoud.current -= 1;
          if (pendingLoud.current === 0) {
            setLoading(false);
            setRefreshing(false);
          }
        }
      }
    },
    [readable, store, locationId, agentId],
  );

  useEffect(() => {
    if (readable) void read({ refreshUsage: agentId === "codex" });
  }, [read, readable, agentId]);

  useEffect(() => {
    if (revision === seenRevision.current) return;
    seenRevision.current = revision;
    if (readable) void read({ silent: true });
  }, [revision, read, readable]);

  /** A save's answer is on screen: every read already sent is older, and none of their answers may replace it. */
  const supersede = useCallback(() => {
    applied.current = asked.current;
  }, []);

  return { snapshot, setSnapshot, loading, refreshing, loadError, read, supersede, mounted };
}

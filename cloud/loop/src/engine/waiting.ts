// Runs that wait (CYC-550): a run with a wait row is left alone until it is woken (a signal on the subject) or its
// recheck time has come. The engine knows only the run's key; the subject is the flow's string, opaque here.

import type { LoopStore } from "../store.ts";

export type WaitState = "none" | "waiting" | "due";

/** Whether `key` waits on something: not at all, still, or woken or at its recheck time. */
export const waitStateOf = (store: LoopStore, key: string): WaitState =>
  store.transaction((tx) => {
    if (tx.waits(key).length === 0) return "none";
    return tx.dueWaits().some((w) => w.owner === key) ? "due" : "waiting";
  });

/** A run that was due is going on: its waits are gone, and the event says it was woken (not recovered). */
export const wake = async (store: LoopStore, key: string, phase: string): Promise<void> => {
  const subjects = store.transaction((tx) => {
    const subjects = tx.waits(key).map((w) => w.subject);
    tx.clearWaits(key);
    return subjects;
  });
  await store.event(key, "woken", { phase, on: subjects.join(",") });
};

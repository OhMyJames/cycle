// Whether a session has an unsent draft, for the session list's mark. Only text counts: it is what is kept across a
// restart; attachments and mentions live in memory and are not a reason to mark a row.
import { useSyncExternalStore } from "react";
import type { Draft } from "../draft.ts";
import { useAppStore } from "./store-context.tsx";

export const draftHasText = (draft: Pick<Draft, "text">): boolean => draft.text.trim() !== "";

/** `key` is the composer's: `sessionKey` of the session. Re-renders only when the answer changes. */
export function useHasDraft(key: string): boolean {
  const { drafts } = useAppStore();
  return useSyncExternalStore(drafts.subscribe, () => draftHasText(drafts.get(key)));
}

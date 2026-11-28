// Which session a ConversationView subtree belongs to: defaults to the main window's selected session,
// and is overridden by LoopSessionPanel when a Loop session is opened in the right panel beside Timeline.
import { createContext, useContext } from "react";
import type { AppState } from "../store/index.ts";
import { useAppState } from "./store-context.tsx";

export type SessionScope = {
  locationId: string;
  sessionId: string;
  /** False inside a right-side session panel, where nested Files/Diff side-panel jumps do not apply. */
  hasSidePanel: boolean;
};

const SessionScopeContext = createContext<SessionScope | undefined>(undefined);

export const SessionScopeProvider = SessionScopeContext.Provider;

/** The session the current conversation subtree renders for, and whether it owns the window's Files/Diff side panel. */
export function useSessionScope(): {
  locationId: string | undefined;
  sessionId: string | undefined;
  hasSidePanel: boolean;
} {
  const scoped = useContext(SessionScopeContext);
  const selectedLocation = useAppState((s) => s.selectedLocation);
  const selectedSession = useAppState((s) => s.selectedSession);
  if (scoped !== undefined) return scoped;
  return {
    locationId: selectedLocation,
    sessionId: selectedSession,
    hasSidePanel: true,
  };
}

/** The folder of the scoped session when it owns a Files tab that can show it; undefined otherwise. */
export function useScopedFilesRoot(): string | undefined {
  const { locationId, sessionId, hasSidePanel } = useSessionScope();
  return useAppState((state: AppState) => {
    if (!hasSidePanel || locationId === undefined || sessionId === undefined) return undefined;
    if (state.status[locationId]?.capabilities?.fs !== true) return undefined;
    return state.sessions[locationId]?.find((s) => s.sessionId === sessionId)?.cwd;
  });
}

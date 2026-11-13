import type { UpdateState } from "../client/host.ts";

/** The one thing Settings offers for the app's updates, and the line under its version. */
export type UpdateOffer = {
  readonly label: string;
  readonly action: "check" | "install" | null;
  /** The action the row is for, as an update that waits is. */
  readonly primary: boolean;
  readonly note: string;
};

export function updateOffer(state: UpdateState): UpdateOffer {
  const check = { label: "Check for updates", action: "check", primary: false } as const;
  switch (state.status) {
    case "idle":
      return { ...check, note: "Updates are downloaded in the background." };
    case "checking":
      return {
        label: "Checking…",
        action: null,
        primary: false,
        note: "Looking for a newer version.",
      };
    case "upToDate":
      return { ...check, note: "Cycle is up to date." };
    case "downloading":
      return {
        label: `Downloading ${Math.min(100, Math.max(0, Math.floor(state.progress * 100)))}%`,
        action: null,
        primary: false,
        note: `Version ${state.version} is on its way.`,
      };
    case "ready":
      return {
        label: "Restart to update",
        action: "install",
        primary: true,
        note:
          state.message ??
          `Version ${state.version} is ready. Restarting stops any turn that is running.`,
      };
    case "error":
      return { ...check, note: state.message };
  }
}

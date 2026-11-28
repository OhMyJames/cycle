// The app's bridge as this page expects it (docs/desktop.md "界面更新"). A page may run on an app older than itself, of
// the same contract major (shared/contract.ts): that app's preload made the bridge from its own list of methods, so a
// method added since is not there. It is filled in here with one that fails as a call the app refuses would, so the
// page's usual handling of a failed call applies, instead of a TypeError where the page calls it.
import { API_METHODS, type CycleBridge } from "@cycle/ui/api";

/** What a method the app does not have answers. */
export const notInThisApp = (method: string): Error =>
  new Error(`This version of Cycle cannot do ${method} yet. Update Cycle to use it.`);

/** The bridge with every method this page knows, and the names of those the app lacks. */
export const completeBridge = (
  given: Partial<CycleBridge>,
  methods: readonly string[] = API_METHODS,
): { bridge: CycleBridge; missing: string[] } => {
  const bridge: Record<string, unknown> = { ...given };
  const missing: string[] = [];
  for (const method of methods) {
    if (typeof bridge[method] === "function") continue;
    missing.push(method);
    bridge[method] = () => Promise.reject(notInThisApp(method));
  }
  return { bridge: bridge as CycleBridge, missing };
};

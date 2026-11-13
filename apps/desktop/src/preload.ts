import { type IpcRendererEvent, contextBridge, ipcRenderer } from "electron";
import type { UpdateBridge, UpdateState } from "./shared/update-state";

/** The app's own updates, which the main process says it has only in a packaged macOS app. */
const update: UpdateBridge = {
  state: () => ipcRenderer.invoke("cycle:update-state"),
  check: () => ipcRenderer.invoke("cycle:update-check"),
  install: () => ipcRenderer.invoke("cycle:update-install"),
  onState: (listener) => {
    const heard = (_event: IpcRendererEvent, state: UpdateState): void => listener(state);
    ipcRenderer.on("cycle:update-state", heard);
    return () => ipcRenderer.removeListener("cycle:update-state", heard);
  },
};

/** The page's `window.cycle`: the few things only the app around it can do. */
contextBridge.exposeInMainWorld("cycle", {
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke("cycle:pick-directory"),
  notify: (title: string, body: string): void => {
    void ipcRenderer.invoke("cycle:notify", title, body);
  },
  openExternal: (url: string): void => {
    void ipcRenderer.invoke("cycle:open-external", url);
  },
  insetTitleBar: process.platform === "darwin",
  ...(process.argv.includes("--cycle-updates") ? { update } : {}),
});

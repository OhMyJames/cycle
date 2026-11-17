import { type IpcRendererEvent, contextBridge, ipcRenderer } from "electron";
import type { RemoteBridge, RemoteState } from "./shared/remote-state";
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

/** The remote servers the app can show, and the one it shows. */
const remote: RemoteBridge = {
  list: () => ipcRenderer.invoke("cycle:remotes-list"),
  add: (input) => ipcRenderer.invoke("cycle:remotes-add", input),
  update: (id, input) => ipcRenderer.invoke("cycle:remotes-update", id, input),
  remove: (id) => ipcRenderer.invoke("cycle:remotes-remove", id),
  connect: (id) => ipcRenderer.invoke("cycle:remotes-connect", id),
  state: () => ipcRenderer.invoke("cycle:remotes-state"),
  test: (id) => ipcRenderer.invoke("cycle:remotes-test", id),
  onState: (listener) => {
    const heard = (_event: IpcRendererEvent, state: RemoteState): void => listener(state);
    ipcRenderer.on("cycle:remotes-state", heard);
    return () => ipcRenderer.removeListener("cycle:remotes-state", heard);
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
  remote,
  ...(process.argv.includes("--cycle-updates") ? { update } : {}),
});

import { contextBridge, ipcRenderer } from "electron";

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
});

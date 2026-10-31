// Bridge of the small update window: it reads the updater state and asks for
// one of its few actions. Main accepts these channels only from that window.
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopUpdateState } from "./types.ts";
import type { UpdateWindowAction } from "./updateWindowView.ts";

contextBridge.exposeInMainWorld("polythUpdate", Object.freeze({
  getState: () => ipcRenderer.invoke("desktop:update-window:get") as Promise<DesktopUpdateState>,
  act: (action: UpdateWindowAction) => ipcRenderer.invoke("desktop:update-window:act", action) as Promise<void>,
  onState: (listener: (state: DesktopUpdateState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState) => listener(state);
    ipcRenderer.on("desktop:update:state", handler);
    return () => ipcRenderer.removeListener("desktop:update:state", handler);
  },
}));

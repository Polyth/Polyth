// Bridge of a second window (`window=chat|pane`, secondWindows.ts): the window's
// own caption controls and nothing else. Its title bar is hidden like the main
// window's, so the page's header carries the traffic lights (macOS), the native
// caption overlay (Windows) or Polyth's buttons (Linux). Main accepts these
// channels only from a second window's top frame, and acts on that window.
import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopCaptionGeometry,
  DesktopSecondWindowChrome,
  DesktopSecondWindowSettings,
  DesktopTitleBarAppearance,
  DesktopWindowAction,
  DesktopWindowState,
  PolythDesktopWindowApi,
} from "./types.ts";
import { SECOND_WINDOW_CHANNELS as CHANNELS } from "./secondWindowChrome.ts";

const subscribe = <T>(channel: string, listener: (value: T) => void): (() => void) => {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const api: PolythDesktopWindowApi = {
  getChrome: () => ipcRenderer.invoke(CHANNELS.get) as Promise<DesktopSecondWindowChrome>,
  windowAction: (action: DesktopWindowAction) => ipcRenderer.invoke(CHANNELS.action, action) as Promise<DesktopWindowState>,
  syncCaptionControls: (band: number) => ipcRenderer.invoke(CHANNELS.caption, band) as Promise<DesktopCaptionGeometry | null>,
  setTitleBarAppearance: (appearance: DesktopTitleBarAppearance) => ipcRenderer.invoke(CHANNELS.titlebar, appearance) as Promise<void>,
  onSettingsChanged: (listener: (settings: DesktopSecondWindowSettings) => void) => subscribe(CHANNELS.settings, listener),
  onWindowState: (listener: (state: DesktopWindowState) => void) => subscribe(CHANNELS.state, listener),
};

contextBridge.exposeInMainWorld("polythDesktopWindow", Object.freeze(api));

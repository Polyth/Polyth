import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopCommand,
  DesktopInfo,
  DesktopKeepAwakeState,
  DesktopLocalSetupResult,
  DesktopSettings,
  DesktopSetupClaim,
  DesktopTitleBarAppearance,
  DesktopUpdateState,
  DesktopWindowAction,
  DesktopWindowState,
  PolythDesktopApi,
} from "./types.ts";

const subscribe = <T>(channel: string, listener: (value: T) => void): (() => void) => {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const api: PolythDesktopApi = {
  getInfo: () => ipcRenderer.invoke("desktop:info") as Promise<DesktopInfo>,
  requestSetupClaim: (request) =>
    ipcRenderer.invoke("desktop:setup:claim", { fresh: request?.fresh === true }) as Promise<DesktopSetupClaim>,
  restartAfterSetup: () => ipcRenderer.invoke("desktop:setup:restart") as Promise<void>,
  completeLocalSetup: () => ipcRenderer.invoke("desktop:setup:local") as Promise<DesktopLocalSetupResult>,
  renewOwnerSession: () => ipcRenderer.invoke("desktop:session:renew") as Promise<boolean>,
  confirmOwnerSession: () => ipcRenderer.invoke("desktop:session:confirm") as Promise<boolean>,
  getSettings: () => ipcRenderer.invoke("desktop:settings:get") as Promise<DesktopSettings>,
  setSettings: (patch) =>
    ipcRenderer.invoke("desktop:settings:set", patch) as Promise<DesktopSettings>,
  windowAction: (action: DesktopWindowAction) =>
    ipcRenderer.invoke("desktop:window", action) as Promise<DesktopWindowState>,
  getWindowState: () => ipcRenderer.invoke("desktop:window:get") as Promise<DesktopWindowState>,
  setTitleBarAppearance: (appearance: DesktopTitleBarAppearance) =>
    ipcRenderer.invoke("desktop:window:titlebar", appearance) as Promise<void>,
  revealPath: (path) => ipcRenderer.invoke("desktop:path:reveal", path) as Promise<void>,
  openPath: (path) => ipcRenderer.invoke("desktop:path:open", path) as Promise<void>,
  openDataFolder: () => ipcRenderer.invoke("desktop:data:open") as Promise<void>,
  quit: () => ipcRenderer.invoke("desktop:quit") as Promise<void>,
  getUpdateState: () =>
    ipcRenderer.invoke("desktop:update:get") as Promise<DesktopUpdateState>,
  checkForUpdates: () =>
    ipcRenderer.invoke("desktop:update:check") as Promise<DesktopUpdateState>,
  downloadUpdate: () =>
    ipcRenderer.invoke("desktop:update:download") as Promise<DesktopUpdateState>,
  installUpdate: () => ipcRenderer.invoke("desktop:update:install") as Promise<void>,
  showUpdateProgress: () => ipcRenderer.invoke("desktop:update:show") as Promise<void>,
  getKeepAwakeState: () =>
    ipcRenderer.invoke("desktop:keep-awake:get") as Promise<DesktopKeepAwakeState>,
  setAgentActivity: (working) =>
    ipcRenderer.invoke("desktop:keep-awake:activity", working === true) as Promise<DesktopKeepAwakeState>,
  onKeepAwakeState: (listener) => subscribe("desktop:keep-awake:state", listener),
  onSettingsChanged: (listener) => subscribe("desktop:settings:changed", listener),
  onWindowState: (listener) => subscribe("desktop:window:state", listener),
  onCommand: (listener) => subscribe<DesktopCommand>("desktop:command", listener),
  onUpdateState: (listener) => subscribe("desktop:update:state", listener),
};

contextBridge.exposeInMainWorld("polythDesktop", Object.freeze(api));

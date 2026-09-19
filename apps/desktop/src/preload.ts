import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopChatWorkspaceConnectResult,
  DesktopChatWorkspaceConnectionsState,
  DesktopChatWorkspacePairingAttempt,
  DesktopChatWorkspacePairingPreview,
  DesktopChatWorkspaceSurface,
  DesktopInfo,
  DesktopSettings,
  DesktopSetupClaim,
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
  requestSetupClaim: () =>
    ipcRenderer.invoke("desktop:setup:claim") as Promise<DesktopSetupClaim>,
  restartAfterSetup: () => ipcRenderer.invoke("desktop:setup:restart") as Promise<void>,
  getSettings: () => ipcRenderer.invoke("desktop:settings:get") as Promise<DesktopSettings>,
  setSettings: (patch) =>
    ipcRenderer.invoke("desktop:settings:set", patch) as Promise<DesktopSettings>,
  windowAction: (action: DesktopWindowAction) =>
    ipcRenderer.invoke("desktop:window", action) as Promise<DesktopWindowState>,
  revealPath: (path) => ipcRenderer.invoke("desktop:path:reveal", path) as Promise<void>,
  openPath: (path) => ipcRenderer.invoke("desktop:path:open", path) as Promise<void>,
  openDataFolder: () => ipcRenderer.invoke("desktop:data:open") as Promise<void>,
  chatWorkspaceConnections: () =>
    ipcRenderer.invoke("desktop:chat-workspace:connections") as Promise<DesktopChatWorkspaceConnectionsState>,
  connectChatWorkspace: (connectionId) =>
    ipcRenderer.invoke("desktop:chat-workspace:connect", connectionId) as Promise<DesktopChatWorkspaceConnectResult>,
  previewChatWorkspacePairing: (ticket) =>
    ipcRenderer.invoke("desktop:chat-workspace:pairing:preview", ticket) as Promise<DesktopChatWorkspacePairingPreview>,
  beginChatWorkspacePairing: (ticket, label) =>
    ipcRenderer.invoke("desktop:chat-workspace:pairing:begin", ticket, label) as Promise<DesktopChatWorkspacePairingAttempt>,
  confirmChatWorkspacePairing: (attemptId) =>
    ipcRenderer.invoke("desktop:chat-workspace:pairing:confirm", attemptId) as Promise<DesktopChatWorkspaceConnectResult>,
  cancelChatWorkspacePairing: (attemptId) =>
    ipcRenderer.invoke("desktop:chat-workspace:pairing:cancel", attemptId) as Promise<{ ok: true }>,
  disconnectChatWorkspace: () =>
    ipcRenderer.invoke("desktop:chat-workspace:disconnect") as Promise<{ ok: true }>,
  setChatWorkspaceSurface: (surface: DesktopChatWorkspaceSurface) =>
    ipcRenderer.invoke("desktop:chat-workspace:surface", surface) as Promise<{ ok: true }>,
  quit: () => ipcRenderer.invoke("desktop:quit") as Promise<void>,
  checkForUpdates: () =>
    ipcRenderer.invoke("desktop:update:check") as Promise<DesktopUpdateState>,
  downloadUpdate: () =>
    ipcRenderer.invoke("desktop:update:download") as Promise<DesktopUpdateState>,
  installUpdate: () => ipcRenderer.invoke("desktop:update:install") as Promise<void>,
  onSettingsChanged: (listener) => subscribe("desktop:settings:changed", listener),
  onWindowState: (listener) => subscribe("desktop:window:state", listener),
  onUpdateState: (listener) => subscribe("desktop:update:state", listener),
};

contextBridge.exposeInMainWorld("polythDesktop", Object.freeze(api));

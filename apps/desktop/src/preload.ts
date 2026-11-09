import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopCommand,
  DesktopInfo,
  DesktopServersResult,
  DesktopServersView,
  DesktopWindowPlacement,
  DesktopKeepAwakeState,
  DesktopLocalSetupResult,
  DesktopSettings,
  DesktopSetupClaim,
  DesktopTitleBarAppearance,
  DesktopUpdateState,
  DesktopWindowAction,
  DesktopWindowState,
  PolythDesktopApi,
  PolythDesktopServersApi,
} from "./types.ts";

declare const __POLYTH_DESKTOP_FLAVOR__: string;

const subscribe = <T>(channel: string, listener: (value: T) => void): (() => void) => {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const placement = (): DesktopWindowPlacement => {
  try {
    return ipcRenderer.sendSync("desktop:surface") as DesktopWindowPlacement;
  } catch {
    return { surface: null, linkProxy: false };
  }
};

const servers: PolythDesktopServersApi = {
  menu: (anchor) => ipcRenderer.invoke("desktop:servers:menu", anchor) as Promise<void>,
  list: (options) => ipcRenderer.invoke("desktop:servers:list", { add: options?.add === true }) as Promise<void>,
  resume: (path) => ipcRenderer.invoke("desktop:servers:resume", path) as Promise<void>,
  state: () => ipcRenderer.invoke("desktop:servers:state") as Promise<DesktopServersView>,
  open: (target) => ipcRenderer.invoke("desktop:servers:open", target) as Promise<DesktopServersResult<void>>,
  link: (method, params) => ipcRenderer.invoke("desktop:link", method, params) as Promise<DesktopServersResult<unknown>>,
  forgetAddress: (url) => ipcRenderer.invoke("desktop:servers:forget-address", url) as Promise<DesktopServersView>,
  setRunLocalServer: (run) => ipcRenderer.invoke("desktop:servers:run-local", run === true) as Promise<DesktopServersView>,
};

const place = placement();

const api: PolythDesktopApi = {
  surface: place.surface,
  linkProxy: place.linkProxy,
  // The workstation edition has no other servers (src/edition.ts): without the
  // API the page shows no server switcher, and main refuses the channels anyway.
  ...(__POLYTH_DESKTOP_FLAVOR__ === "workstation" ? {} : { servers: Object.freeze(servers) }),
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

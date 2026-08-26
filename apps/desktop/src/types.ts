export type DesktopControlPosition = "left" | "right";
export type DesktopControlTheme = "system" | "dark" | "light";
export type DesktopWindowAction = "minimize" | "toggle-maximize" | "close";

export interface DesktopSettings {
  closeToTray: boolean;
  startMinimized: boolean;
  launchAtLogin: boolean;
  keepAwake: boolean;
  automaticUpdates: boolean;
  lowResourceMode: boolean;
  reduceAnimations: boolean;
  controlsPosition: DesktopControlPosition;
  controlsTheme: DesktopControlTheme;
}

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error"
  | "disabled";

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  message: string;
  version?: string;
  percent?: number;
}

export interface DesktopInfo {
  appVersion: string;
  opencodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  dataDir: string;
  logPath: string;
  packaged: boolean;
  trayAvailable: boolean;
  canLaunchAtLogin: boolean;
  keepAwakeActive: boolean;
  lowResourceMode: boolean;
}

export interface DesktopWindowState {
  maximized: boolean;
  visible: boolean;
  focused: boolean;
}

export interface PolythDesktopApi {
  getInfo(): Promise<DesktopInfo>;
  getSettings(): Promise<DesktopSettings>;
  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  windowAction(action: DesktopWindowAction): Promise<DesktopWindowState>;
  revealPath(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openDataFolder(): Promise<void>;
  quit(): Promise<void>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  onSettingsChanged(listener: (settings: DesktopSettings) => void): () => void;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
}

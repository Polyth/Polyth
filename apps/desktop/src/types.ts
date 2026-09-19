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

export interface DesktopChatWorkspaceConnection {
  id?: string;
  connectionId?: string;
  hostEndpointId?: string;
  hostLabel?: string;
  pairingState?: string;
  lastUsedAt?: number;
  lastTransport?: string | null;
  revoked?: boolean;
  hasSecureIdentity?: boolean;
}

export interface DesktopChatWorkspaceConnectionsState {
  activeConnectionId: string | null;
  connections: DesktopChatWorkspaceConnection[];
}

export interface DesktopChatWorkspaceConnectResult {
  connectionId: string;
  origin: string;
}

export interface DesktopChatWorkspacePairingPreview {
  hostLabel: string;
  hostFingerprint: string;
  expiresAt: string;
}

export interface DesktopChatWorkspacePairingAttempt {
  attemptId: string;
  safetyPhrase?: string[];
  state: string;
}

export interface DesktopChatWorkspaceSurface {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  /** True while this renderer owns presentation, even when temporarily hidden behind native UI. */
  claimed?: boolean;
}

export interface DesktopSetupPreparation {
  recoveryCodes: string[];
}

export interface DesktopSetupInput {
  name: string;
  organizationName: string;
  login: string;
  password: string;
  recoveryAcknowledged: boolean;
}

export interface PolythDesktopApi {
  getInfo(): Promise<DesktopInfo>;
  prepareSetup(): Promise<DesktopSetupPreparation>;
  completeSetup(input: DesktopSetupInput): Promise<void>;
  restartAfterSetup(): Promise<void>;
  getSettings(): Promise<DesktopSettings>;
  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  windowAction(action: DesktopWindowAction): Promise<DesktopWindowState>;
  revealPath(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openDataFolder(): Promise<void>;
  chatWorkspaceConnections(): Promise<DesktopChatWorkspaceConnectionsState>;
  connectChatWorkspace(connectionId: string): Promise<DesktopChatWorkspaceConnectResult>;
  previewChatWorkspacePairing(ticket: string): Promise<DesktopChatWorkspacePairingPreview>;
  beginChatWorkspacePairing(ticket: string, label: string): Promise<DesktopChatWorkspacePairingAttempt>;
  confirmChatWorkspacePairing(attemptId: string): Promise<DesktopChatWorkspaceConnectResult>;
  cancelChatWorkspacePairing(attemptId: string): Promise<{ ok: true }>;
  disconnectChatWorkspace(): Promise<{ ok: true }>;
  setChatWorkspaceSurface(surface: DesktopChatWorkspaceSurface): Promise<{ ok: true }>;
  quit(): Promise<void>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  onSettingsChanged(listener: (settings: DesktopSettings) => void): () => void;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
}

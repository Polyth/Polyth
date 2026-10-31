export type DesktopControlPosition = "left" | "right";
export type DesktopControlTheme = "system" | "dark" | "light";
export type DesktopWindowAction = "minimize" | "toggle-maximize" | "close";
/** Release channel the desktop updater follows; see apps/desktop/src/updaterChannel.ts. */
export type DesktopUpdateChannel = "stable" | "test" | "nightly";
/** Keep-awake holds the blocker only while an agent works, or the whole run. */
export type DesktopKeepAwakeMode = "working" | "always";

export interface DesktopSettings {
  closeToTray: boolean;
  startMinimized: boolean;
  launchAtLogin: boolean;
  keepAwake: boolean;
  /** Absent from shells older than keep-awake modes (they behave as "always"). */
  keepAwakeMode?: DesktopKeepAwakeMode;
  automaticUpdates: boolean;
  updateChannel: DesktopUpdateChannel;
  lowResourceMode: boolean;
  /** Disable GPU acceleration (applies after restart). Kept separate from
   *  low-resource mode: on most machines software rendering is slower. */
  softwareRendering: boolean;
  reduceAnimations: boolean;
  controlsPosition: DesktopControlPosition;
  controlsTheme: DesktopControlTheme;
}

export interface DesktopInfo {
  appVersion: string;
  opencodeVersion: string;
  platform: string;
  arch: string;
  dataDir: string;
  logPath: string;
  packaged: boolean;
  trayAvailable: boolean;
  canLaunchAtLogin: boolean;
  keepAwakeActive: boolean;
  lowResourceMode: boolean;
  softwareRendering: boolean;
  /** The macOS 12 build on macOS 12: updates come from stable releases only.
   *  Absent from shells older than that build. */
  macLegacyUpdates?: boolean;
}

/** The blocker as the desktop main process holds it. */
export interface DesktopKeepAwakeState {
  enabled: boolean;
  mode: DesktopKeepAwakeMode;
  /** The renderer's last report of a working agent. */
  working: boolean;
  active: boolean;
}

export interface DesktopWindowState {
  maximized: boolean;
  fullscreen: boolean;
  visible: boolean;
  focused: boolean;
}

/** The native Windows caption overlay: its background (`#rrggbbaa`, sent
 *  fully transparent so the renderer's own surface shows under the buttons;
 *  older shells accept only `#rrggbb`), its glyph colour (`#rrggbb`) and its
 *  CSS-px height. */
export interface DesktopTitleBarAppearance {
  color: string;
  symbolColor: string;
  height: number;
}

/** Native menu commands the renderer carries out with its own handlers. */
export type DesktopCommand = "open-settings" | "new-session" | "search-sessions" | "command-palette";

export interface DesktopUpdateState {
  phase:
    | "idle" | "checking" | "available" | "downloading" | "downloaded"
    | "installing" | "installed" | "up-to-date" | "error" | "disabled";
  message: string;
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  /** "manual" builds (ad-hoc signed macOS) only open the release page. */
  installMode?: "in-app" | "manual";
  /** The desktop's small update window is on screen and shows the progress itself. */
  progressWindow?: boolean;
}

export interface DesktopSetupClaim {
  claimToken: string;
  /** Epoch ms after which the server refuses the claim (absent from older shells). */
  expiresAt?: number;
}

export interface DesktopSetupClaimRequest {
  /** Rotate out the current claim (after the server refused it) instead of reusing it. */
  fresh?: boolean;
}

/** First run for an owner who uses Polyth alone: no password, name from the OS. */
export type DesktopLocalSetupResult =
  | { ok: true }
  | { ok: false; error: "setup-completed" | "recovery-required" | "unavailable" };

export interface PolythDesktopApi {
  getInfo(): Promise<DesktopInfo>;
  requestSetupClaim(request?: DesktopSetupClaimRequest): Promise<DesktopSetupClaim>;
  restartAfterSetup(): Promise<void>;
  /** Finish first run without a password (absent from older shells). */
  completeLocalSetup?(): Promise<DesktopLocalSetupResult>;
  /** Re-open this window's owner session while the owner has no password;
   *  false once they protected the account (absent from older shells). */
  renewOwnerSession?(): Promise<boolean>;
  /** Confirm, from the main process, that this window may protect the
   *  account now (absent from older shells). */
  confirmOwnerSession?(): Promise<boolean>;
  getSettings(): Promise<DesktopSettings>;
  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  windowAction(action: DesktopWindowAction): Promise<DesktopWindowState>;
  getWindowState(): Promise<DesktopWindowState>;
  setTitleBarAppearance(appearance: DesktopTitleBarAppearance): Promise<void>;
  revealPath(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openDataFolder(): Promise<void>;
  quit(): Promise<void>;
  /** Absent from shells older than the main-window update notice. */
  getUpdateState?(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  /** Brings the small update window forward; absent from older shells. */
  showUpdateProgress?(): Promise<void>;
  /** Keep-awake state and agent activity; absent from shells older than modes. */
  getKeepAwakeState?(): Promise<DesktopKeepAwakeState>;
  setAgentActivity?(working: boolean): Promise<DesktopKeepAwakeState>;
  onKeepAwakeState?(listener: (state: DesktopKeepAwakeState) => void): () => void;
  onSettingsChanged(listener: (settings: DesktopSettings) => void): () => void;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
  onCommand(listener: (command: DesktopCommand) => void): () => void;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
}

declare global {
  interface Window {
    polythDesktop?: PolythDesktopApi;
  }
}

export const desktopBridge = (): PolythDesktopApi | undefined =>
  typeof window === "undefined" ? undefined : window.polythDesktop;

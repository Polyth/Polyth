export type DesktopControlPosition = "left" | "right";
export type DesktopControlTheme = "system" | "dark" | "light";
export type DesktopWindowAction = "minimize" | "toggle-maximize" | "close";
/** Release channel the desktop updater follows; see apps/desktop/src/updaterChannel.ts. */
export type DesktopUpdateChannel = "stable" | "test" | "nightly";
/** When keep-awake holds the app-suspension blocker: only while an agent is
 *  working, or for as long as Polyth runs. */
export type DesktopKeepAwakeMode = "working" | "always";

export interface DesktopSettings {
  closeToTray: boolean;
  startMinimized: boolean;
  launchAtLogin: boolean;
  keepAwake: boolean;
  keepAwakeMode: DesktopKeepAwakeMode;
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

export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  /** Restart accepted: Polyth is closing so the installer can run silently. */
  | "installing"
  /** First start after an update this app installed. */
  | "installed"
  | "up-to-date"
  | "error"
  | "disabled";

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  message: string;
  version?: string;
  percent?: number;
  /** Download progress in bytes while `downloading`. */
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  /** "manual" builds (ad-hoc signed macOS) only open the release page. */
  installMode?: "in-app" | "manual";
  /** The small update window is on screen (it then shows the progress). */
  progressWindow?: boolean;
}

/** What the window is showing; decides what it may ask of the main process. */
export type DesktopWindowSurface = "local" | "hub" | "remote";

/** What the main process says about a page as it loads. */
export interface DesktopWindowPlacement {
  surface: DesktopWindowSurface | null;
  /** A local Link proxy serves this page, so it can lose that proxy. */
  linkProxy: boolean;
}

/** The server on screen. `label` is what the person calls it. */
export interface DesktopServerInfo {
  kind: "local" | "link" | "address";
  label: string;
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
  softwareRendering: boolean;
  /** The macOS 12 build on macOS 12: updates come from stable releases only. */
  macLegacyUpdates: boolean;
  server: DesktopServerInfo;
}

/** The blocker as main holds it. `working` is the renderer's last report. */
export interface DesktopKeepAwakeState {
  enabled: boolean;
  mode: DesktopKeepAwakeMode;
  working: boolean;
  active: boolean;
}

export interface DesktopWindowState {
  maximized: boolean;
  fullscreen: boolean;
  visible: boolean;
  focused: boolean;
}

/** Colors (`#rrggbb`) and CSS-px height the native Windows caption overlay
 *  paints so it is indistinguishable from the renderer header. */
export interface DesktopTitleBarAppearance {
  color: string;
  symbolColor: string;
  height: number;
}

/** Native menu commands the renderer carries out with its own handlers. */
export type DesktopCommand = "open-settings" | "new-session" | "search-sessions" | "command-palette";

export interface DesktopSetupClaim {
  claimToken: string;
  /** Epoch ms after which the server refuses the claim. */
  expiresAt: number;
}

export interface DesktopSetupClaimRequest {
  /** Rotate out the current claim (after the server refused it) instead of reusing it. */
  fresh?: boolean;
}

/** First run for an owner who uses Polyth alone: no password, name from the OS. */
export type DesktopLocalSetupResult =
  | { ok: true }
  | { ok: false; error: "setup-completed" | "recovery-required" | "unavailable" };

export interface DesktopServerAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The server list's view of this computer and the servers saved by address. */
export interface DesktopServersView {
  active: { kind: "local" } | { kind: "link"; id: string } | { kind: "address"; url: string };
  runLocalServer: boolean;
  /** This computer's server: running, waiting for first-run setup, or stopped. */
  local: "running" | "setup" | "stopped";
  /** The Link client is part of this build. */
  linkAvailable: boolean;
  addresses: { url: string; lastUsedAt: number }[];
}

/** A failure travels as a value: IPC keeps only an error's message, and the
 *  list decides by code. */
export type DesktopServersResult<T> = { ok: true; result: T } | { ok: false; code: string };

export type DesktopOpenServer = { kind: "local"; path?: string } | { kind: "address"; url: string };

export interface PolythDesktopServersApi {
  /** The native server menu at `anchor`. The app draws it, so the page never reads the list. */
  menu(anchor?: DesktopServerAnchor): Promise<void>;
  /** Shows the server list, optionally leading with adding a server. */
  list(options?: { add?: boolean }): Promise<void>;
  /** The open server's page lost its local proxy: reconnect it at `path`. */
  resume(path?: string): Promise<void>;
  state(): Promise<DesktopServersView>;
  open(target: DesktopOpenServer): Promise<DesktopServersResult<void>>;
  link(method: string, params?: Record<string, unknown>): Promise<DesktopServersResult<unknown>>;
  forgetAddress(url: string): Promise<DesktopServersView>;
  setRunLocalServer(run: boolean): Promise<DesktopServersView>;
}

export interface PolythDesktopApi {
  /** Read once per page: the main process answers from the page's own origin. */
  surface: DesktopWindowSurface | null;
  linkProxy: boolean;
  servers: PolythDesktopServersApi;
  getInfo(): Promise<DesktopInfo>;
  requestSetupClaim(request?: DesktopSetupClaimRequest): Promise<DesktopSetupClaim>;
  restartAfterSetup(): Promise<void>;
  /** Finish first run without a password; call `restartAfterSetup` next. */
  completeLocalSetup(): Promise<DesktopLocalSetupResult>;
  /** Re-open this window's owner session while the owner has no password;
   *  false once they protected the account (they sign in instead). */
  renewOwnerSession(): Promise<boolean>;
  /** Confirm, from the main process, that this window may protect the
   *  account now (choose the owner's first password). */
  confirmOwnerSession(): Promise<boolean>;
  getSettings(): Promise<DesktopSettings>;
  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  windowAction(action: DesktopWindowAction): Promise<DesktopWindowState>;
  getWindowState(): Promise<DesktopWindowState>;
  setTitleBarAppearance(appearance: DesktopTitleBarAppearance): Promise<void>;
  revealPath(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openDataFolder(): Promise<void>;
  quit(): Promise<void>;
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  downloadUpdate(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  /** Brings the small update window (download/install progress) to the front. */
  showUpdateProgress(): Promise<void>;
  getKeepAwakeState(): Promise<DesktopKeepAwakeState>;
  /** The renderer's report of whether any agent is working right now. */
  setAgentActivity(working: boolean): Promise<DesktopKeepAwakeState>;
  onKeepAwakeState(listener: (state: DesktopKeepAwakeState) => void): () => void;
  onSettingsChanged(listener: (settings: DesktopSettings) => void): () => void;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
  onCommand(listener: (command: DesktopCommand) => void): () => void;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
}

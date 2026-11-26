import type {
  BugReportApp,
  BugReportError,
  BugReportPackage,
  BugReportSettingValue,
  BugReportWeb,
} from "@polyth/contracts/bug-report";
import type { FeedbackKind, FeedbackProfile } from "@polyth/contracts/feedback";

export type DesktopControlPosition = "left" | "right";
export type DesktopControlTheme = "system" | "dark" | "light";
export type DesktopWindowAction = "minimize" | "toggle-maximize" | "close";
/** Release channel the desktop updater follows; see apps/desktop/src/updaterChannel.ts. */
export type DesktopUpdateChannel = "stable" | "nightly";
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
  /** Linux: take the side, order and set of caption buttons from the desktop
   *  environment (GNOME/KDE/XFCE button layout) instead of controlsPosition,
   *  which stays the manual choice older renderers read. */
  controlsFollowSystem: boolean;
  controlsTheme: DesktopControlTheme;
}

export type DesktopCaptionButton = "minimize" | "maximize" | "close";

/** The caption-button layout the Linux desktop environment uses. */
export interface DesktopSystemControls {
  side: DesktopControlPosition;
  /** In on-screen order, left to right. */
  buttons: DesktopCaptionButton[];
}

/** Where the OS-drawn caption controls sit, in CSS px of the page (page zoom
 *  applied): the macOS traffic-light group as the window placed it. */
export interface DesktopCaptionGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
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
  /** The build follows one stable-only feed and offers no channel choice
   *  (the macOS 12 build on macOS 12, the workstation edition). */
  stableOnlyUpdates: boolean;
  /** "workstation": a local-only shell; no other servers, no Polyth Link. */
  edition: "standard" | "workstation";
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
  /** Linux: the desktop environment's caption-button layout, or null when it
   *  cannot be read. Absent on other platforms. */
  systemControls?: DesktopSystemControls | null;
}

/** Colors (`#rrggbb`) and CSS-px height the native Windows caption overlay
 *  paints so it is indistinguishable from the renderer header. */
export interface DesktopTitleBarAppearance {
  color: string;
  symbolColor: string;
  height: number;
}

/** The desktop settings a second window's caption controls read: where the
 *  buttons sit and how the chrome performs. Nothing else of the settings
 *  reaches a second window. */
export type DesktopSecondWindowSettings = Pick<
  DesktopSettings,
  "controlsPosition" | "controlsFollowSystem" | "controlsTheme" | "lowResourceMode" | "reduceAnimations"
>;

/** What a second window (`window=chat|pane`) is told about its own chrome. */
export interface DesktopSecondWindowChrome {
  platform: string;
  settings: DesktopSecondWindowSettings;
  state: DesktopWindowState;
}

/** The second-window bridge (`window.polythDesktopWindow`,
 *  apps/desktop/src/secondWindowPreload.ts): the caption controls of the
 *  window that asks, and nothing else. Every other desktop channel answers
 *  the main window only. */
export interface PolythDesktopWindowApi {
  getChrome(): Promise<DesktopSecondWindowChrome>;
  windowAction(action: DesktopWindowAction): Promise<DesktopWindowState>;
  /** macOS: centre the traffic lights on the header band (CSS px). */
  syncCaptionControls(band: number): Promise<DesktopCaptionGeometry | null>;
  /** Windows: the native caption overlay's colours and height. */
  setTitleBarAppearance(appearance: DesktopTitleBarAppearance): Promise<void>;
  onSettingsChanged(listener: (settings: DesktopSecondWindowSettings) => void): () => void;
  onWindowState(listener: (state: DesktopWindowState) => void): () => void;
}

/** Native menu commands the renderer carries out with its own handlers. */
export type DesktopCommand = "open-settings" | "new-session" | "search-sessions" | "command-palette" | "report-bug";

/** Feedback (src/bugReport.ts). */
export interface DesktopBugReportState {
  /** False when an administrator turned feedback off (`POLYTH_BUG_REPORT_ORIGIN=off`). */
  available: boolean;
  /** Feedback waiting for the intake. */
  queued: number;
}

export interface DesktopBugReportCapture {
  /** Pass back in the draft to include this screenshot. */
  captureId: string;
  /** This window only, as the person will see it in the preview. */
  screenshot: { dataUrl: string; width: number; height: number; bytes: number } | null;
  /** What the desktop adds to every feedback, shown before sending. */
  base: {
    app: BugReportApp;
    settings: Record<string, BugReportSettingValue>;
    /** The pseudonym that changes every day (anonymous feedback). */
    installDaily: string;
    /** The pseudonym the person can reset: sent only with a profile or contact. */
    installPerson: string;
    /** The profile the person saved with an earlier feedback, to prefill. */
    savedProfile: FeedbackProfile | null;
  };
}

/** The renderer's part of a feedback. The desktop adds build, pseudonym and
 *  `desktop.*` settings itself and validates the whole feedback. A part the
 *  person left out is null: it is sent exactly when it is present. */
export interface DesktopBugReportDraft {
  kind: FeedbackKind;
  text: string;
  /** "" for none. */
  contact: string;
  /** null sends no screenshot. */
  captureId: string | null;
  /** null sends no technical details. */
  technical: {
    web: BugReportWeb;
    /** `ui.*` keys only; anything else is dropped. */
    settings: Record<string, BugReportSettingValue>;
    packages: BugReportPackage[];
    errors: BugReportError[];
  } | null;
  /** null sends no profile. */
  profile: FeedbackProfile | null;
}

export type DesktopBugReportOutcome =
  | { result: "received"; ref: number }
  /** Kept on this computer; it goes when the intake can take it. */
  | { result: "queued" }
  /** The service-wide daily budget is used up: try later. */
  | { result: "rate" }
  | { result: "invalid" }
  /** Feedback is off on this build. */
  | { result: "unavailable" };

export interface PolythDesktopBugReportApi {
  state(): Promise<DesktopBugReportState>;
  /** Screenshot this window now; call before showing the sheet. */
  capture(): Promise<DesktopBugReportCapture>;
  send(draft: DesktopBugReportDraft): Promise<DesktopBugReportOutcome>;
  /** The screenshot with the person's marks drawn in (a JPEG) replaces the
   *  capture's; the shell re-encodes it to the wire's limits. Null when the
   *  capture is gone or the bytes are not an image. */
  annotate(captureId: string, jpeg: Uint8Array): Promise<DesktopBugReportCapture["screenshot"]>;
  /** Erases what this computer sent under its resettable pseudonym and starts
   *  a new one. Absent from older shells. */
  forget(): Promise<{ result: "forgotten"; count: number } | { result: "unavailable" }>;
}

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

/** Resetting a forgotten owner password on the computer that runs Polyth. */
export type DesktopOwnerPasswordResetResult =
  | { ok: true; login: string }
  | { ok: false; error: "cancelled" | "invalid-input" | "forbidden" | "unavailable" };

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

export type DesktopOpenServer = { kind: "local"; path?: string } | { kind: "address"; url: string; path?: string };

/** A project as another server's zone lists it: what its row draws. */
export interface DesktopServerZoneProject {
  id: string;
  name: string;
  icon?: string;
  color?: string;
}

/** A server other than the one on screen, with the projects its own page
 *  listed the last time it was open (src/serverZones.ts). */
export interface DesktopServerZone {
  key: string;
  kind: "local" | "link" | "address";
  /** Empty for this computer: the page names it in its own language. */
  label: string;
  /** False once a pairing was revoked: opening leads to the server list. */
  available: boolean;
  folded: boolean;
  projects: DesktopServerZoneProject[];
  /** Null until that server's page was open once. */
  reportedAt: number | null;
}

export interface DesktopServerZonesView {
  /** "ask": this page is another server's, and the person has not let that
   *  server list their other servers yet. */
  access: "granted" | "ask";
  zones: DesktopServerZone[];
}

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
  /** The other servers as zones, for the page of the server on screen. */
  zones(): Promise<DesktopServerZonesView>;
  /** This page's own projects, kept for the other servers' navigators. */
  reportZoneProjects(projects: DesktopServerZoneProject[]): Promise<void>;
  /** Another server's page asks to list the zones: the app asks the person. */
  allowZones(): Promise<DesktopServerZonesView>;
  /** Moves the window to a zone's server, at one of its listed projects. */
  openZone(key: string, projectId?: string): Promise<DesktopServersResult<void>>;
  foldZone(key: string, folded: boolean): Promise<DesktopServerZonesView>;
}

export interface PolythDesktopApi {
  /** Read once per page: the main process answers from the page's own origin. */
  surface: DesktopWindowSurface | null;
  linkProxy: boolean;
  /** Absent in the workstation edition: it shows this computer's server only. */
  servers?: PolythDesktopServersApi;
  getInfo(): Promise<DesktopInfo>;
  requestSetupClaim(request?: DesktopSetupClaimRequest): Promise<DesktopSetupClaim>;
  restartAfterSetup(): Promise<void>;
  /** Finish first run without a password; call `restartAfterSetup` next. */
  completeLocalSetup(): Promise<DesktopLocalSetupResult>;
  /** Re-open this window's owner session: always while the owner has no
   *  password, and on a loopback-only server also once they have one. */
  renewOwnerSession(): Promise<boolean>;
  /** The owner forgot the password: main asks the operating system (Touch
   *  ID, or a native confirmation), sets the new one, ends every session and
   *  re-opens this window's owner session. */
  resetOwnerPassword(password: string): Promise<DesktopOwnerPasswordResetResult>;
  /** Confirm, from the main process, that this window may protect the
   *  account now (choose the owner's first password). */
  confirmOwnerSession(): Promise<boolean>;
  getSettings(): Promise<DesktopSettings>;
  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  windowAction(action: DesktopWindowAction): Promise<DesktopWindowState>;
  getWindowState(): Promise<DesktopWindowState>;
  setTitleBarAppearance(appearance: DesktopTitleBarAppearance): Promise<void>;
  syncCaptionControls(band: number): Promise<DesktopCaptionGeometry | null>;
  revealPath(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  /** Where a dropped or picked file sits on this computer; "" for a file made
   *  in the page, and always "" on another server's window (a path names the
   *  person, and that server could not open it anyway). */
  pathForFile(file: File): string;
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
  /** Nightly bug reports. Absent from older shells; `state().available` is
   *  false on builds that send none. */
  bugReport?: PolythDesktopBugReportApi;
  /** Browser pages this computer hosts, shown live in place of frames. Absent
   *  from older shells; only this computer's own server window may place. */
  webViews?: PolythDesktopWebViewsApi;
}

/** A place in the window, in CSS px of the page asking. */
export interface DesktopWebViewRect { x: number; y: number; width: number; height: number }

export interface PolythDesktopWebViewsApi {
  /** Show the page `id` (a browser session's `nativeViewId`) at `rect`, or
   *  stop showing it with `null`. Rejects for unknown ids. */
  place(id: string, rect: DesktopWebViewRect | null): Promise<void>;
}

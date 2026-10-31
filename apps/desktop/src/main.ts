import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  powerSaveBlocker,
  screen,
  session,
  shell,
  Tray,
  type ContextMenuParams,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type Rectangle,
} from "electron";
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "@polyth/server";
import { cliLauncherPlan, installCliLauncher, openPathFromArgv } from "./cliInstall.ts";
import { setLinuxAutostartEnabled } from "./linuxAutostart.ts";
import { validateAbsoluteLocalPath } from "./localPath.ts";
import { desktopServerPackages } from "./serverPackages.ts";
import { createDesktopSetupClaimBroker } from "./setupClaim.ts";
import { osDisplayName } from "./osDisplayName.ts";
import { withoutForeignSessionCookies } from "./sessionCookieGuard.ts";
import { readSavedServerPort, reserveServerPort, saveServerPort } from "./serverPort.ts";
import {
  DEFAULT_DESKTOP_SETTINGS,
  normalizeDesktopSettings,
  readDesktopSettings,
  readDesktopSettingsSync,
  writeDesktopSettings,
} from "./settings.ts";
import type {
  DesktopCommand,
  DesktopInfo,
  DesktopKeepAwakeState,
  DesktopLocalSetupResult,
  DesktopSettings,
  DesktopUpdateState,
  DesktopWindowAction,
  DesktopWindowState,
} from "./types.ts";
import { assertUpdaterCapability } from "./updaterCapability.ts";
import { followsMacLegacyFeed, resolveUpdaterConfig, updateChannelForVersion } from "./updaterChannel.ts";
import { releasePageUrl, resolveUpdateInstallMode, type UpdateInstallMode } from "./updaterInstallMode.ts";
import {
  parsePendingUpdate,
  pendingUpdateOutcome,
  UPDATE_WINDOW_ACTIONS,
  UPDATE_WINDOW_SIZE,
  updateWindowBounds,
  type UpdateWindowAction,
} from "./updateWindowView.ts";
import { desktopChromeOptions, normalizeTitleBarAppearance, trayIconSize } from "./windowChrome.ts";
import { stagedChromiumExecutable } from "./chromiumResource.ts";
import { keepAwakeWanted } from "./keepAwake.ts";

declare const __POLYTH_OPENCODE_VERSION__: string;
declare const __POLYTH_DESKTOP_FLAVOR__: string;
type DesktopAutoUpdater = typeof import("electron-updater").autoUpdater;
let autoUpdater: DesktopAutoUpdater | null = null;
const backgroundStart = process.argv.includes("--background");
/** The macOS 12 build on macOS 12 updates from its own stable-only feed. */
const macLegacyUpdates = followsMacLegacyFeed(__POLYTH_DESKTOP_FLAVOR__, process.platform, process.getSystemVersion());

interface SavedWindowState {
  bounds?: Rectangle;
  maximized?: boolean;
}

const isE2e = process.env.POLYTH_DESKTOP_E2E === "1";
const startupSmoke = process.env.POLYTH_DESKTOP_STARTUP_SMOKE === "1";
const bootstrapLogPath = startupSmoke && process.env.POLYTH_DESKTOP_USER_DATA
  ? join(resolve(process.env.POLYTH_DESKTOP_USER_DATA), "desktop", "polyth-bootstrap.log")
  : null;
const bootstrapTrace = (message: string): void => {
  if (!bootstrapLogPath) return;
  try {
    mkdirSync(dirname(bootstrapLogPath), { recursive: true });
    appendFileSync(bootstrapLogPath, `${new Date().toISOString()} ${message}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}
};
bootstrapTrace(`main module evaluated on ${process.platform}-${process.arch}`);
if (process.env.POLYTH_DESKTOP_USER_DATA) {
  bootstrapTrace("before app.setPath(userData)");
  app.setPath("userData", resolve(process.env.POLYTH_DESKTOP_USER_DATA));
  bootstrapTrace("after app.setPath(userData)");
}
bootstrapTrace("before reading startup settings");
/** Until the user picks one, a build follows the channel it was published on. */
const desktopSettingsDefaults: DesktopSettings = {
  ...DEFAULT_DESKTOP_SETTINGS,
  updateChannel: updateChannelForVersion(app.getVersion()),
};
const startupSettings = readDesktopSettingsSync(join(app.getPath("userData"), "desktop", "settings.json"), desktopSettingsDefaults);
bootstrapTrace("after reading startup settings");
const startupLowResourceMode = startupSettings.lowResourceMode;
const startupSoftwareRendering = startupSettings.softwareRendering;
// GPU acceleration is independent of low-resource mode: on integrated
// graphics, software compositing moves every scroll/typing frame onto the CPU
// and is slower than the GPU path. It is only an escape hatch for bad drivers.
if (startupSoftwareRendering) app.disableHardwareAcceleration();
if (startupLowResourceMode) {
  app.commandLine.appendSwitch("disk-cache-size", String(32 * 1024 * 1024));
  process.env.POLYTH_TERM_REPLAY_BYTES ??= String(64 * 1024);
  process.env.POLYTH_MAX_TERMINALS ??= "4";
}
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-transparent-visuals");
}
let mainWindow: BrowserWindow | null = null;
/** The small update window: download progress, the restart prompt and the handover to the installer. */
let updateWindow: BrowserWindow | null = null;
let updateWindowCloseTimer: NodeJS.Timeout | null = null;
let tray: Tray | null = null;
let settings: DesktopSettings;
let baseUrl = "";
const desktopSetupClaims = createDesktopSetupClaimBroker(() => requireDesktopSetupLifecycle().issueSetupClaim());
let dataDir = "";
let logPath = "";
let settingsPath = "";
let windowStatePath = "";
let serverPortPath = "";
let serverLifecycle: Awaited<ReturnType<typeof boot>> | null = null;
let updateState: DesktopUpdateState = { phase: "idle", message: "Updates are ready to check." };
let quitting = false;
/** app.quit() reached before-quit (quitAndInstall quits only once its installer started). */
let quitStarted = false;
let serverStopped = false;
let keepAwakeBlockerId: number | null = null;
/** The renderer's last report of a working agent; cleared when it reloads or dies. */
let agentsWorking = false;
let updateStartupTimer: NodeJS.Timeout | null = null;
let updateTimer: NodeJS.Timeout | null = null;
let updateInstallMode: UpdateInstallMode = "in-app";
/** "Try again" in the update window: download the release the next check finds. */
let downloadWhenFound = false;
/** The user asked for this download: its end (ready or failed) reopens the update window. */
let downloadWatched = false;
let updatePendingPath = "";
let saveBoundsTimer: NodeJS.Timeout | null = null;
/** A saved maximized window is maximized when first shown, never while hidden:
 *  on Windows `maximize()` also shows the window, which would defeat
 *  start-hidden and login-item background starts. */
let pendingMaximize = false;

app.setName("Polyth");
// Windows groups taskbar buttons and attributes toast notifications by the
// AppUserModelID; it must match the installer's appId or notifications from
// the renderer are dropped/unbranded.
if (process.platform === "win32") app.setAppUserModelId("com.polyth.desktop");

const log = (message: string, error?: unknown): void => {
  const suffix = error === undefined
    ? ""
    : ` ${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`;
  const line = `${new Date().toISOString()} ${message}${suffix}\n`;
  console.log(`[desktop] ${message}`, error ?? "");
  if (!logPath) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line, { encoding: "utf8", mode: 0o600 });
  } catch {}
};

const packagedResource = (name: string): string => join(process.resourcesPath, name);

/** Both icons carry the same re-framed mark (scripts/prepare-icon.mjs);
 *  Windows gets the 256px build/icon-win.png its .ico tops out at, every
 *  other platform the 512px build/icon.png. */
const appIconFileName = (): string => (process.platform === "win32" ? "icon-win.png" : "icon.png");

const appIconPath = (): string => app.isPackaged
  ? packagedResource(appIconFileName())
  : join(app.getAppPath(), "build", appIconFileName());

const opencodePath = (): string => {
  const executable = process.platform === "win32" ? "opencode.exe" : "opencode";
  return app.isPackaged
    ? packagedResource(join("opencode", `${process.platform}-${process.arch}`, executable))
    : join(app.getAppPath(), "resources", "opencode", `${process.platform}-${process.arch}`, executable);
};

const webDistPath = (): string => app.isPackaged
  ? packagedResource("web")
  : resolve(app.getAppPath(), "../web/dist");

const webPackagesPath = (): string => app.isPackaged
  ? packagedResource("packages")
  : resolve(app.getAppPath(), "../../packages");

const linkHostPath = (): string | undefined => {
  if (process.env.POLYTH_LINK_HOST) return process.env.POLYTH_LINK_HOST;
  const executable = process.platform === "win32" ? "polyth-link-host.exe" : "polyth-link-host";
  return app.isPackaged ? packagedResource(join("polyth-link", executable)) : undefined;
};

const readSavedWindowState = (): SavedWindowState => {
  try {
    const raw = JSON.parse(readFileSync(windowStatePath, "utf8")) as SavedWindowState;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
};

const visibleBounds = (saved?: Rectangle): Rectangle | undefined => {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return undefined;
  if (saved.width < 700 || saved.height < 500) return undefined;
  const intersects = screen.getAllDisplays().some(({ workArea }) =>
    saved.x < workArea.x + workArea.width
    && saved.x + saved.width > workArea.x
    && saved.y < workArea.y + workArea.height
    && saved.y + saved.height > workArea.y);
  return intersects ? saved : undefined;
};

const saveWindowState = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const previous = readSavedWindowState();
  const next: SavedWindowState = {
    bounds: mainWindow.isMaximized() ? previous.bounds : mainWindow.getBounds(),
    maximized: mainWindow.isMaximized() || pendingMaximize,
  };
  const temp = `${windowStatePath}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(windowStatePath), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, windowStatePath);
  } catch (error) {
    log("Could not save window state", error);
  }
};

const scheduleWindowStateSave = (): void => {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(saveWindowState, 250);
  saveBoundsTimer.unref?.();
};

const windowState = (): DesktopWindowState => ({
  maximized: mainWindow?.isMaximized() ?? false,
  fullscreen: mainWindow?.isFullScreen() ?? false,
  visible: mainWindow?.isVisible() ?? false,
  focused: mainWindow?.isFocused() ?? false,
});

const sendToRenderer = (channel: string, value: unknown): void => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, value);
};

/** Whether the small update window owns the update progress. It owns it from
 *  the moment it exists, not only once it is painted: the main-window notice
 *  and the small window sit in the same corner, so a notice that outlived
 *  window creation could be covered by a window without a single click
 *  reaching it. Closing the window (not hiding it) releases the progress. */
const updateWindowOpen = (): boolean => !!updateWindow && !updateWindow.isDestroyed();

/** The updater state as both windows see it. */
const publishedUpdateState = (): DesktopUpdateState => ({ ...updateState, progressWindow: updateWindowOpen() });

const broadcastUpdateState = (): void => {
  const state = publishedUpdateState();
  sendToRenderer("desktop:update:state", state);
  if (updateWindow && !updateWindow.isDestroyed() && !updateWindow.webContents.isDestroyed()) {
    updateWindow.webContents.send("desktop:update:state", state);
  }
};

const broadcastWindowState = (): void => sendToRenderer("desktop:window:state", windowState());

const sendCommand = (command: DesktopCommand): void => {
  showWindow();
  sendToRenderer("desktop:command", command);
};

const revealWindow = (window: BrowserWindow): void => {
  if (pendingMaximize) {
    pendingMaximize = false;
    window.maximize();
  }
  window.show();
  window.focus();
};

const showWindow = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  revealWindow(mainWindow);
  broadcastWindowState();
};

const applyLoginSetting = async (): Promise<void> => {
  if (!app.isPackaged) return;
  if (process.platform === "linux") {
    const file = await setLinuxAutostartEnabled({ enabled: settings.launchAtLogin });
    log(`Linux launch-at-login ${settings.launchAtLogin ? "enabled" : "disabled"}: ${file}`);
    return;
  }
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
    ...(process.platform === "darwin"
      ? { openAsHidden: settings.launchAtLogin, args: settings.launchAtLogin ? ["--background"] : [] }
      : { args: settings.launchAtLogin ? ["--background"] : [] }),
  });
};

const keepAwakeActive = (): boolean => keepAwakeBlockerId !== null && powerSaveBlocker.isStarted(keepAwakeBlockerId);

const keepAwakeState = (): DesktopKeepAwakeState => ({
  enabled: settings.keepAwake,
  mode: settings.keepAwakeMode,
  working: agentsWorking,
  active: keepAwakeActive(),
});

const applyKeepAwakeSetting = (): void => {
  const active = keepAwakeActive();
  const wanted = keepAwakeWanted(settings, agentsWorking);
  if (wanted && !active) {
    keepAwakeBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    log(`Keep-awake started (${settings.keepAwakeMode})`);
  } else if (!wanted && active && keepAwakeBlockerId !== null) {
    powerSaveBlocker.stop(keepAwakeBlockerId);
    keepAwakeBlockerId = null;
    log("Keep-awake stopped");
  }
  sendToRenderer("desktop:keep-awake:state", keepAwakeState());
};

/** A reloaded or crashed renderer can no longer report its agents: forget the
 *  last report so a "working" blocker never outlives the page that asked. */
const resetAgentActivity = (): void => {
  if (!agentsWorking) return;
  agentsWorking = false;
  applyKeepAwakeSetting();
};

const persistSettings = async (patch: unknown): Promise<DesktopSettings> => {
  const requested = patch && typeof patch === "object" && !Array.isArray(patch)
    ? patch as Partial<DesktopSettings>
    : {};
  const next = normalizeDesktopSettings({ ...settings, ...requested }, desktopSettingsDefaults);
  const channelChanged = next.updateChannel !== settings.updateChannel;
  settings = next;
  await applyLoginSetting();
  applyKeepAwakeSetting();
  if (channelChanged) applyUpdateChannel();
  refreshAutomaticUpdateSchedule();
  await writeDesktopSettings(settingsPath, settings);
  sendToRenderer("desktop:settings:changed", settings);
  rebuildTrayMenu();
  return settings;
};

const setUpdateState = (next: DesktopUpdateState): DesktopUpdateState => {
  const previousPhase = updateState.phase;
  updateState = { ...next, installMode: updateInstallMode };
  broadcastUpdateState();
  // Progress ticks only refresh the windows; the tray and the log follow phases.
  if (next.phase !== "downloading" || previousPhase !== "downloading") {
    rebuildTrayMenu();
    log(`Updater: ${next.phase} — ${next.message}`);
  }
  return publishedUpdateState();
};

const checkForUpdates = async (): Promise<DesktopUpdateState> => {
  if (!app.isPackaged || isE2e) {
    return setUpdateState({
      phase: "disabled",
      message: app.isPackaged ? "Update checks are disabled in the desktop test harness." : "Update checks are available in packaged builds.",
    });
  }
  try {
    const updater = autoUpdater;
    if (!updater) throw new Error("Updater is not configured");
    assertUpdaterCapability({ packaged: app.isPackaged });
    await updater.checkForUpdates();
  } catch (error) {
    setUpdateState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
  }
  return publishedUpdateState();
};

function refreshAutomaticUpdateSchedule(): void {
  if (updateStartupTimer) clearTimeout(updateStartupTimer);
  if (updateTimer) clearInterval(updateTimer);
  updateStartupTimer = null;
  updateTimer = null;
  if (!settings.automaticUpdates || !app.isPackaged || isE2e) return;
  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null;
    void checkForUpdates();
  }, startupLowResourceMode ? 60_000 : 12_000);
  updateStartupTimer.unref?.();
  updateTimer = setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1_000);
  updateTimer.unref?.();
}

/** A download the user asked for shows its progress in the small update window. */
const downloadUpdate = async ({ showProgress = false }: { showProgress?: boolean } = {}): Promise<DesktopUpdateState> => {
  if (updateState.phase !== "available") {
    if (showProgress && (updateState.phase === "downloading" || updateState.phase === "downloaded")) {
      if (updateState.phase === "downloading") downloadWatched = true;
      void showUpdateWindow();
    }
    return publishedUpdateState();
  }
  if (updateInstallMode === "manual") return openUpdateReleasePage();
  const version = updateState.version;
  setUpdateState({
    phase: "downloading", message: `Downloading Polyth ${version ?? "update"}…`, ...(version ? { version } : {}),
  });
  downloadWatched = showProgress;
  if (showProgress) void showUpdateWindow();
  try {
    const updater = autoUpdater;
    if (!updater) throw new Error("Updater is not configured");
    await updater.downloadUpdate();
  } catch (error) {
    setUpdateState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    if (downloadWatched) void showUpdateWindow();
    downloadWatched = false;
  }
  return publishedUpdateState();
};

/** "Try again" after a failed download or install: check, then download what it finds. */
const retryUpdate = async (): Promise<void> => {
  if (updateState.phase === "available") { await downloadUpdate({ showProgress: true }); return; }
  downloadWhenFound = updateInstallMode === "in-app";
  await checkForUpdates();
};

const clearUpdateWindowCloseTimer = (): void => {
  if (updateWindowCloseTimer) clearTimeout(updateWindowCloseTimer);
  updateWindowCloseTimer = null;
};

const closeUpdateWindow = (): void => {
  clearUpdateWindowCloseTimer();
  if (updateWindow && !updateWindow.isDestroyed()) updateWindow.close();
};

const createUpdateWindow = (): BrowserWindow => {
  const display = mainWindow && !mainWindow.isDestroyed()
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay();
  const window = new BrowserWindow({
    ...updateWindowBounds(display.workArea, UPDATE_WINDOW_SIZE),
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    roundedCorners: true,
    title: "Polyth update",
    icon: appIconPath(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#14171d" : "#ffffff",
    webPreferences: {
      preload: join(import.meta.dirname, "update-window-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  if (process.platform !== "darwin") window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  // Hiding closes it: a hidden window would keep the app alive once the main
  // window is gone. Reopening rebuilds it from the current state.
  window.on("show", broadcastUpdateState);
  window.on("closed", () => {
    if (updateWindow !== window) return;
    updateWindow = null;
    clearUpdateWindowCloseTimer();
    broadcastUpdateState();
  });
  void window.loadFile(join(import.meta.dirname, "update-window.html")).catch((error: unknown) => log("Update window failed to load", error));
  return window;
};

/**
 * Shows the small update window without taking focus from the main window
 * (`focus` for an explicit "show progress"). Resolves once it is painted, or
 * after a short wait, so a state about to end the process is seen first.
 */
function showUpdateWindow({ focus = false }: { focus?: boolean } = {}): Promise<void> {
  if (isE2e) return Promise.resolve();
  clearUpdateWindowCloseTimer();
  const existing = updateWindow && !updateWindow.isDestroyed() ? updateWindow : null;
  const window = existing ?? createUpdateWindow();
  updateWindow = window;
  // The notice in the main window steps aside as soon as the small window
  // exists, not only once it is painted: while it is being created both were
  // visible in the same corner, and the small window covered the notice's
  // restart button.
  broadcastUpdateState();
  const reveal = () => {
    if (window.isDestroyed()) return;
    try {
      if (focus) window.show();
      else if (!window.isVisible()) window.showInactive();
      window.moveTop();
    } catch (error) {
      log("Could not reveal the update window", error);
    }
  };
  if (existing && !window.webContents.isLoading()) {
    reveal();
    return Promise.resolve();
  }
  return new Promise((resolveShown) => {
    // A page that never reports ready-to-show (a broken bundle, a vanished
    // html file) must still reveal the window: otherwise the app waits and
    // then quits with no progress surface at all. The 1.5 s fallback reveals
    // whatever the window has rather than silently staying hidden.
    const timer = setTimeout(() => {
      reveal();
      resolveShown();
    }, 1_500);
    window.once("ready-to-show", () => { clearTimeout(timer); reveal(); resolveShown(); });
  });
}

/** An explicit "show progress": the window comes forward and follows the download to its end. */
function showUpdateProgress(): Promise<void> {
  if (updateState.phase === "downloading") downloadWatched = true;
  return showUpdateWindow({ focus: true });
}

/** Closes a window that only reports news (installed, up to date) after a while. */
const closeUpdateWindowLater = (delayMs: number): void => {
  clearUpdateWindowCloseTimer();
  updateWindowCloseTimer = setTimeout(() => {
    updateWindowCloseTimer = null;
    if (!["available", "downloading", "downloaded", "installing", "error"].includes(updateState.phase)) closeUpdateWindow();
  }, delayMs);
  updateWindowCloseTimer.unref?.();
};

const runUpdateWindowAction = async (action: UpdateWindowAction): Promise<void> => {
  if (action === "hide") closeUpdateWindow();
  else if (action === "download") await downloadUpdate({ showProgress: true });
  else if (action === "install") await installUpdate();
  else await retryUpdate();
};

const shutdownServer = async (): Promise<void> => {
  if (serverStopped) return;
  serverStopped = true;
  if (updateStartupTimer) clearTimeout(updateStartupTimer);
  updateStartupTimer = null;
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = null;
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = null;
  saveWindowState();
  if (keepAwakeBlockerId !== null && powerSaveBlocker.isStarted(keepAwakeBlockerId)) {
    powerSaveBlocker.stop(keepAwakeBlockerId);
  }
  keepAwakeBlockerId = null;
  await serverLifecycle?.shutdown().catch((error) => log("Server shutdown failed", error));
  serverLifecycle = null;
  log("Polyth server stopped");
};

const quitApp = (): void => {
  quitting = true;
  app.quit();
};

function rebuildTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: mainWindow?.isVisible() ? "Focus Polyth" : "Show Polyth", click: showWindow },
    { label: "Hide", enabled: mainWindow?.isVisible() ?? false, click: () => { mainWindow?.hide(); broadcastWindowState(); } },
    { type: "separator" },
    { label: "Open data folder", click: () => void shell.openPath(dataDir).then((error) => { if (error) log(`Could not open data folder: ${error}`); }) },
    { label: "Install command-line tool…", visible: app.isPackaged, click: () => void installCommandLineTool() },
    { label: "Close to tray", type: "checkbox", checked: settings.closeToTray, click: ({ checked }) => void persistSettings({ closeToTray: checked }) },
    { label: "Launch at login", type: "checkbox", visible: app.isPackaged && ["darwin", "linux", "win32"].includes(process.platform), checked: settings.launchAtLogin, click: ({ checked }) => void persistSettings({ launchAtLogin: checked }) },
    { label: settings.keepAwakeMode === "working" ? "Keep awake while agents work" : "Keep awake while running", type: "checkbox", checked: settings.keepAwake, click: ({ checked }) => void persistSettings({ keepAwake: checked }) },
    { type: "separator" },
    {
      label: updateState.phase === "downloading"
        ? "Show update download…"
        : updateState.phase === "downloaded" ? "Restart to update"
          : updateState.phase === "installing" ? "Installing update…" : "Check for updates",
      enabled: updateState.phase !== "checking" && updateState.phase !== "installing",
      click: () => {
        if (updateState.phase === "downloaded") void installUpdate();
        else if (updateState.phase === "downloading") void showUpdateProgress();
        else void checkForUpdates();
      },
    },
    { type: "separator" },
    { label: "Quit Polyth", accelerator: "CommandOrControl+Q", click: quitApp },
  ]));
}

const createTray = (): void => {
  const size = trayIconSize(process.platform);
  const icon = nativeImage.createFromPath(appIconPath()).resize({ width: size, height: size, quality: "best" });
  tray = new Tray(icon);
  tray.setToolTip("Polyth");
  tray.on("click", () => {
    if (mainWindow?.isVisible()) { mainWindow.hide(); broadcastWindowState(); }
    else showWindow();
  });
  tray.on("double-click", showWindow);
  rebuildTrayMenu();
  log("System tray created with context menu");
};

/** Write a user-owned `polyth` launcher that runs the bundled CLI with this
 *  app's own binary (no separate Node.js needed). */
const installCommandLineTool = async (): Promise<void> => {
  const plan = cliLauncherPlan({
    platform: process.platform,
    executable: process.execPath,
    ...(process.env.APPIMAGE ? { appImage: process.env.APPIMAGE } : {}),
    cliScript: packagedResource(join("cli", "polyth.cjs")),
    home: app.getPath("home"),
    ...(process.env.LOCALAPPDATA ? { localAppData: process.env.LOCALAPPDATA } : {}),
  });
  try {
    await installCliLauncher(plan);
    log(`Installed the polyth command-line tool at ${plan.path}`);
    await dialog.showMessageBox({
      type: "info",
      message: "The polyth command is installed",
      detail: `${plan.path}\n\n${plan.pathHint}\n\nTry: polyth status`,
    });
  } catch (error) {
    log("Command-line tool install failed", error);
    await dialog.showMessageBox({ type: "error", message: "Could not install the polyth command", detail: (error as Error).message });
  }
};

/** `polyth open` relaunches the app with `--polyth-open=/p/…/s/…`; the single
 *  instance receives it here and navigates its own window. */
const openFromSecondInstance = (argv: readonly string[]): void => {
  showWindow();
  const path = openPathFromArgv(argv);
  if (!path || !baseUrl || !mainWindow || mainWindow.isDestroyed()) return;
  void mainWindow.loadURL(`${baseUrl}${path}`).catch((error) => log("Could not open the requested path", error));
};

/** Shortcuts shown in the native menu are owned by the renderer keymap
 *  (`@polyth/hotkeys`); they are displayed but not registered, so the web
 *  handler — which honours user remapping — stays the single owner. */
const rendererShortcut = (accelerator: string): Pick<MenuItemConstructorOptions, "accelerator" | "registerAccelerator"> => ({
  accelerator,
  registerAccelerator: false,
});

const installApplicationMenu = (): void => {
  const mac = process.platform === "darwin";
  const settingsItem: MenuItemConstructorOptions = {
    label: mac ? "Settings…" : "Settings",
    ...rendererShortcut("CommandOrControl+,"),
    click: () => sendCommand("open-settings"),
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{
      label: "Polyth",
      submenu: [
        { role: "about" as const },
        { label: "Check for Updates…", click: () => void checkForUpdates() },
        { type: "separator" as const },
        settingsItem,
        { type: "separator" as const },
        { role: "services" as const },
        { type: "separator" as const },
        { role: "hide" as const }, { role: "hideOthers" as const }, { role: "unhide" as const },
        { type: "separator" as const }, { role: "quit" as const },
      ],
    }] : []),
    { label: "File", submenu: [
      { label: "New Chat", ...rendererShortcut("CommandOrControl+N"), click: () => sendCommand("new-session") },
      { label: "Search Chats…", ...rendererShortcut("CommandOrControl+Shift+O"), click: () => sendCommand("search-sessions") },
      { label: "Command Palette…", ...rendererShortcut("CommandOrControl+K"), click: () => sendCommand("command-palette") },
      { type: "separator" },
      { label: "Show Polyth", accelerator: "CommandOrControl+Shift+P", click: showWindow },
      { label: "Open Data Folder", click: () => void shell.openPath(dataDir) },
      { label: "Install Command-Line Tool…", enabled: app.isPackaged, click: () => void installCommandLineTool() },
      ...(mac ? [] : [{ type: "separator" as const }, settingsItem]),
      { type: "separator" }, mac ? { role: "close" as const } : { role: "quit" as const },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [
      { role: "reload" }, ...(isE2e || !app.isPackaged ? [{ role: "toggleDevTools" as const }] : []),
      { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      { type: "separator" }, { role: "togglefullscreen" },
    ] },
    { role: "windowMenu" },
  ]));
};

/** Electron renders no context menu of its own. Pages that draw a custom
 *  menu call preventDefault(), which suppresses this event; everywhere else
 *  text fields, selections, links, and spelling get the native menu. */
const showContextMenu = (window: BrowserWindow, params: ContextMenuParams): void => {
  const items: MenuItemConstructorOptions[] = [];
  const { editFlags } = params;
  if (params.isEditable && params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, 5);
    for (const suggestion of suggestions) {
      items.push({ label: suggestion, click: () => window.webContents.replaceMisspelling(suggestion) });
    }
    if (suggestions.length === 0) items.push({ label: "No spelling suggestions", enabled: false });
    items.push({
      label: "Add to Dictionary",
      click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    items.push({ type: "separator" });
  }
  if (params.linkURL && safeExternalUrl(params.linkURL)) {
    items.push(
      { label: "Open Link in Browser", click: () => void shell.openExternal(params.linkURL) },
      { label: "Copy Link Address", click: () => clipboard.writeText(params.linkURL) },
      { type: "separator" },
    );
  }
  if (params.isEditable) {
    items.push(
      { role: "undo", enabled: editFlags.canUndo },
      { role: "redo", enabled: editFlags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: editFlags.canCut },
      { role: "copy", enabled: editFlags.canCopy },
      { role: "paste", enabled: editFlags.canPaste },
      { role: "pasteAndMatchStyle", enabled: editFlags.canPaste, visible: process.platform === "darwin" },
      { type: "separator" },
      { role: "selectAll", enabled: editFlags.canSelectAll },
    );
  } else if (params.selectionText.trim()) {
    items.push({ role: "copy", enabled: editFlags.canCopy });
  }
  while (items.at(-1)?.type === "separator") items.pop();
  if (items.length === 0) return;
  Menu.buildFromTemplate(items).popup({ window, x: params.x, y: params.y });
};

const safeExternalUrl = (raw: string): boolean => {
  try { return ["https:", "http:", "mailto:"].includes(new URL(raw).protocol); }
  catch { return false; }
};

const isLocalNavigation = (raw: string): boolean => {
  try { return new URL(raw).origin === new URL(baseUrl).origin; }
  catch { return false; }
};

const createWindow = async (): Promise<void> => {
  const saved = readSavedWindowState();
  const bounds = visibleBounds(saved.bounds);
  const chrome = desktopChromeOptions(process.platform, nativeTheme.shouldUseDarkColors);
  const window = new BrowserWindow({
    width: bounds?.width ?? (startupLowResourceMode ? 1100 : 1360),
    height: bounds?.height ?? (startupLowResourceMode ? 720 : 860),
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 760,
    minHeight: 520,
    // Platform chrome lives in windowChrome.ts: native traffic lights on
    // macOS, the native caption overlay (Snap Layouts) on Windows, and a
    // transparent frameless sheet with renderer controls on Linux.
    ...chrome,
    roundedCorners: true,
    show: false,
    title: "Polyth",
    icon: appIconPath(),
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: !startupLowResourceMode,
      backgroundThrottling: true,
    },
  });
  mainWindow = window;
  pendingMaximize = saved.maximized === true;
  // The application menu still owns accelerators, but a frameless or
  // hidden-title-bar window must never grow an in-window menu bar.
  if (process.platform !== "darwin") window.setMenuBarVisibility(false);
  window.webContents.on("context-menu", (_event, params) => showContextMenu(window, params));
  window.webContents.setWindowOpenHandler(({ url }) => { if (safeExternalUrl(url)) void shell.openExternal(url); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => { if (isLocalNavigation(url)) return; event.preventDefault(); if (safeExternalUrl(url)) void shell.openExternal(url); });
  window.webContents.on("render-process-gone", (_event, details) => {
    log(`Renderer stopped: ${details.reason} (${details.exitCode})`);
    resetAgentActivity();
  });
  window.webContents.on("did-navigate", resetAgentActivity);
  window.on("resize", scheduleWindowStateSave);
  window.on("move", scheduleWindowStateSave);
  window.on("maximize", () => { broadcastWindowState(); scheduleWindowStateSave(); });
  window.on("unmaximize", () => { broadcastWindowState(); scheduleWindowStateSave(); });
  window.on("enter-full-screen", broadcastWindowState);
  window.on("leave-full-screen", broadcastWindowState);
  window.on("show", () => { broadcastWindowState(); rebuildTrayMenu(); });
  window.on("hide", () => { broadcastWindowState(); rebuildTrayMenu(); });
  window.on("focus", broadcastWindowState);
  window.on("blur", broadcastWindowState);
  window.on("close", (event) => {
    if (!quitting && settings.closeToTray) { event.preventDefault(); window.hide(); broadcastWindowState(); log("Window hidden to tray"); }
  });
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; rebuildTrayMenu(); });
  window.once("ready-to-show", () => {
    if (!settings.startMinimized && !backgroundStart) revealWindow(window);
    else log(backgroundStart ? "Started in background from login item" : "Started hidden in system tray");
    log("Desktop renderer ready");
  });
  const maxRendererNavigationAttempts = 8;
  for (let attempt = 1; ; attempt += 1) {
    try { await window.loadURL(baseUrl); break; }
    catch (error) {
      if (attempt >= maxRendererNavigationAttempts || window.isDestroyed()) throw error;
      log(`Renderer navigation attempt ${attempt} failed; retrying`, error);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(1_000, attempt * 500)));
    }
  }
};

const ensureTrustedSender = (event: IpcMainInvokeEvent): void => {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Untrusted desktop IPC sender");
  const url = event.senderFrame?.url ?? "";
  if (!isLocalNavigation(url)) throw new Error("Untrusted desktop IPC sender");
};

const trustedHandle = <Args extends unknown[], Result>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>): void => {
  ipcMain.handle(channel, (event, ...args: Args) => { ensureTrustedSender(event); return handler(event, ...args); });
};

const isUpdateWindowPage = (url: string): boolean => {
  try {
    const expected = resolve(import.meta.dirname, "update-window.html");
    const actual = resolve(fileURLToPath(url));
    return process.platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  } catch {
    return false;
  }
};

/** Channels of the small update window accept only that window's own page. */
const updateWindowHandle = <Args extends unknown[], Result>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>): void => {
  ipcMain.handle(channel, (event, ...args: Args) => {
    if (!updateWindow || event.sender !== updateWindow.webContents || !isUpdateWindowPage(event.senderFrame?.url ?? "")) {
      throw new Error("Untrusted update window IPC sender");
    }
    return handler(event, ...args);
  });
};

/**
 * While the owner has no password ("only me" first run), the server opens an
 * owner session only through this in-process channel and the main process
 * puts it straight into this window's cookie jar: the page never sees the
 * token, and another browser or app on this machine stays at the sign-in
 * screen. A no-op once the owner protected the account.
 */
let ownerCookieName: string | null = null;
const ensureDesktopOwnerSession = async (): Promise<boolean> => {
  const lifecycle = serverLifecycle;
  const issue = lifecycle && "issueLocalOwnerSession" in lifecycle ? lifecycle.issueLocalOwnerSession : undefined;
  if (typeof issue !== "function" || !baseUrl) return false;
  const owner = issue.call(lifecycle);
  if (!owner) return false;
  // No expiry: a memory-only cookie. Every launch opens a new session, so the
  // token never needs to rest in the profile's cookie database.
  await session.defaultSession.cookies.set({
    url: baseUrl,
    name: owner.cookieName,
    value: owner.token,
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "strict",
  });
  ownerCookieName = owner.cookieName;
  log("Opened the owner session for this window");
  return true;
};

/** Protecting the account (choosing the owner's first password) needs this
 *  window's own session confirmed right now, by the main process: a copied
 *  cookie can never do it from elsewhere. */
const confirmDesktopOwnerSession = async (): Promise<boolean> => {
  const lifecycle = serverLifecycle;
  const confirm = lifecycle && "confirmLocalOwnerSession" in lifecycle ? lifecycle.confirmLocalOwnerSession : undefined;
  if (typeof confirm !== "function" || !baseUrl || !ownerCookieName) return false;
  const [cookie] = await session.defaultSession.cookies.get({ url: baseUrl, name: ownerCookieName });
  return cookie ? confirm.call(lifecycle, cookie.value) : false;
};

const completeLocalSetup = async (): Promise<DesktopLocalSetupResult> => {
  const lifecycle = serverLifecycle;
  const complete = lifecycle && "completeLocalSetup" in lifecycle ? lifecycle.completeLocalSetup : undefined;
  if (typeof complete !== "function") return { ok: false, error: "unavailable" };
  const name = await osDisplayName();
  try {
    try {
      complete.call(lifecycle, { name });
    } catch (error) {
      // A name the account rules refuse never blocks the first run; it can
      // be renamed in Settings.
      if ((error as { code?: unknown } | null)?.code !== "invalid-input") throw error;
      complete.call(lifecycle, { name: "Owner" });
    }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    log("First run without a password failed", error);
    return { ok: false, error: code === "setup-completed" || code === "recovery-required" ? code : "unavailable" };
  }
  desktopSetupClaims.reset();
  log("First run finished for an owner without a password");
  return { ok: true };
};

const requireDesktopSetupLifecycle = () => {
  const lifecycle = serverLifecycle;
  const issueSetupClaim = lifecycle && "issueSetupClaim" in lifecycle ? lifecycle.issueSetupClaim : undefined;
  if (typeof issueSetupClaim !== "function") {
    throw Object.assign(new Error("Desktop setup is not active"), { code: "setup-not-active" });
  }
  return { issueSetupClaim: () => issueSetupClaim.call(lifecycle) };
};

const writePendingUpdate = (version: string): void => {
  if (!updatePendingPath) return;
  try {
    mkdirSync(dirname(updatePendingPath), { recursive: true });
    writeFileSync(updatePendingPath, `${JSON.stringify({ version, from: app.getVersion() })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    log("Could not record the pending update", error);
  }
};

/**
 * Restart and install. The small window says what is happening while Polyth
 * closes; the installer then runs silently (NSIS `/S`, no wizard windows) and
 * starts Polyth again, whose next start reports the outcome (`reportPendingUpdate`).
 */
const installUpdate = async (): Promise<void> => {
  if (updateState.phase !== "downloaded") return;
  const updater = autoUpdater;
  if (!updater) throw new Error("Updater is not configured");
  const version = updateState.version;
  setUpdateState({ phase: "installing", message: `Installing Polyth ${version ?? "update"}…`, ...(version ? { version } : {}) });
  let progressShown = false;
  try {
    await showUpdateWindow();
    progressShown = updateWindowOpen();
  } catch (error) {
    log("Could not open the update window", error);
  }
  // Keep the main window (and its installing notice) if the progress window
  // could not be created; otherwise the handover would hide the only sign
  // that work is still in progress.
  if (progressShown && mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  if (version) writePendingUpdate(version);
  quitting = true;
  await shutdownServer();
  updater.quitAndInstall(true, true);
};

/** First start after an install this app handed over: say how it went. */
const reportPendingUpdate = (): void => {
  if (!updatePendingPath || !existsSync(updatePendingPath)) return;
  let raw = "";
  try {
    raw = readFileSync(updatePendingPath, "utf8");
    rmSync(updatePendingPath, { force: true });
  } catch (error) {
    log("Could not read the pending update", error);
    return;
  }
  const outcome = pendingUpdateOutcome(parsePendingUpdate(raw), app.getVersion());
  if (!outcome) return;
  setUpdateState(outcome);
  void showUpdateWindow();
  if (outcome.phase === "installed") closeUpdateWindowLater(8_000);
};

const installIpc = (): void => {
  trustedHandle("desktop:info", (): DesktopInfo => ({
    appVersion: app.getVersion(), opencodeVersion: __POLYTH_OPENCODE_VERSION__, platform: process.platform, arch: process.arch,
    dataDir, logPath, packaged: app.isPackaged, trayAvailable: tray !== null,
    canLaunchAtLogin: app.isPackaged && ["darwin", "linux", "win32"].includes(process.platform),
    keepAwakeActive: keepAwakeActive(), lowResourceMode: startupLowResourceMode,
    softwareRendering: startupSoftwareRendering, macLegacyUpdates,
  }));
  trustedHandle("desktop:setup:claim", (_event, request: unknown) => desktopSetupClaims.request(request));
  trustedHandle("desktop:setup:restart", async () => { await restartDesktopSetupServer(); });
  trustedHandle("desktop:setup:local", completeLocalSetup);
  trustedHandle("desktop:session:renew", ensureDesktopOwnerSession);
  trustedHandle("desktop:session:confirm", confirmDesktopOwnerSession);
  trustedHandle("desktop:settings:get", () => settings);
  trustedHandle("desktop:settings:set", (_event, patch: unknown) => persistSettings(patch));
  trustedHandle("desktop:window:get", () => windowState());
  trustedHandle("desktop:window:titlebar", (_event, appearance: unknown) => {
    if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setTitleBarOverlay(normalizeTitleBarAppearance(appearance, mainWindow.webContents.getZoomFactor()));
  });
  trustedHandle("desktop:window", (_event, action: DesktopWindowAction) => {
    if (!mainWindow) return windowState();
    if (action === "minimize") mainWindow.minimize();
    else if (action === "toggle-maximize") { if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize(); }
    else if (action === "close") mainWindow.close();
    else throw new Error("Unknown window action");
    return windowState();
  });
  trustedHandle("desktop:path:reveal", async (_event, path: unknown) => {
    const target = await validateAbsoluteLocalPath(path);
    if (target.directory) { const error = await shell.openPath(target.path); if (error) throw new Error(error); }
    else shell.showItemInFolder(target.path);
    log(`Revealed path in native file manager: ${target.path}`);
  });
  trustedHandle("desktop:path:open", async (_event, path: unknown) => {
    const target = await validateAbsoluteLocalPath(path);
    const error = await shell.openPath(target.path);
    if (error) throw new Error(error);
  });
  trustedHandle("desktop:data:open", async () => { const error = await shell.openPath(dataDir); if (error) throw new Error(error); });
  trustedHandle("desktop:quit", () => { setImmediate(quitApp); });
  trustedHandle("desktop:update:get", () => publishedUpdateState());
  trustedHandle("desktop:update:check", checkForUpdates);
  trustedHandle("desktop:update:download", () => downloadUpdate({ showProgress: true }));
  trustedHandle("desktop:update:install", installUpdate);
  trustedHandle("desktop:update:show", showUpdateProgress);
  updateWindowHandle("desktop:update-window:get", () => publishedUpdateState());
  updateWindowHandle("desktop:update-window:act", (_event, action: unknown) => {
    if (!UPDATE_WINDOW_ACTIONS.includes(action as UpdateWindowAction)) throw new Error("Unknown update window action");
    return runUpdateWindowAction(action as UpdateWindowAction);
  });
  trustedHandle("desktop:keep-awake:get", keepAwakeState);
  trustedHandle("desktop:keep-awake:activity", (_event, working: unknown) => {
    const next = working === true;
    if (next !== agentsWorking) {
      agentsWorking = next;
      applyKeepAwakeSetting();
    }
    return keepAwakeState();
  });
};

/**
 * Points the updater at the chosen release channel. Switching to a channel
 * whose newest build is older never downgrades: the update arrives with that
 * channel's next release.
 */
function applyUpdateChannel(): void {
  const updater = autoUpdater;
  if (!updater) return;
  const config = resolveUpdaterConfig(settings.updateChannel, process.platform, process.arch, macLegacyUpdates);
  updater.allowPrerelease = config.allowPrerelease;
  updater.channel = config.channel;
  // Setting a channel turns downgrades on; a database never migrates backwards.
  updater.allowDowngrade = false;
  log(macLegacyUpdates
    ? `Updater follows the macOS 12 feed (${config.channel}, stable releases only)`
    : `Updater follows the ${settings.updateChannel} channel (${config.channel}, prereleases ${config.allowPrerelease ? "on" : "off"})`);
  if (updateState.phase === "available" || updateState.phase === "up-to-date" || updateState.phase === "error") {
    setUpdateState({ phase: "idle", message: `Following the ${settings.updateChannel} channel. Check for updates to look for its newest build.` });
  }
}

/** An ad-hoc signed macOS build cannot install in place; send the user to the release. */
const openUpdateReleasePage = async (): Promise<DesktopUpdateState> => {
  const version = updateState.version ?? "";
  let url: string | null = null;
  try { url = releasePageUrl(readFileSync(join(process.resourcesPath, "app-update.yml"), "utf8"), version); } catch {}
  if (!url) return setUpdateState({ phase: "error", message: "The update download page is unknown for this build." });
  await shell.openExternal(url);
  return setUpdateState({ ...updateState, message: `Opened the Polyth ${version} download page. Install it over this copy.` });
};

const readCodesignDetails = (): Promise<string | null> => new Promise((resolveDetails) => {
  if (process.platform !== "darwin" || !app.isPackaged) { resolveDetails(null); return; }
  execFile("codesign", ["-dv", app.getPath("exe")], { timeout: 10_000 }, (error, _stdout, stderr) =>
    resolveDetails(error ? null : String(stderr)));
});

const configureUpdater = async (): Promise<void> => {
  const updaterModule = await import("electron-updater") as typeof import("electron-updater") & {
    default?: { autoUpdater?: DesktopAutoUpdater } | DesktopAutoUpdater;
  };
  const defaultExport = updaterModule.default;
  const updater = updaterModule.autoUpdater
    ?? (defaultExport && typeof defaultExport === "object" && "autoUpdater" in defaultExport
      ? defaultExport.autoUpdater
      : defaultExport);
  if (!updater) throw new Error("electron-updater did not expose autoUpdater");
  autoUpdater = updater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updateInstallMode = resolveUpdateInstallMode(process.platform, await readCodesignDetails());
  if (updateInstallMode === "manual") updater.autoInstallOnAppQuit = false;
  applyUpdateChannel();
  updater.logger = {
    info: (message?: unknown) => log(`updater ${String(message ?? "")}`),
    warn: (message?: unknown) => log(`updater warning ${String(message ?? "")}`),
    error: (message?: unknown) => log(`updater error ${String(message ?? "")}`),
    debug: (message?: unknown) => log(`updater debug ${String(message ?? "")}`),
  };
  log(`Updater configured (${updateInstallMode} install)`);
  updater.on("checking-for-update", () => setUpdateState({ phase: "checking", message: "Checking GitHub Releases…" }));
  updater.on("update-available", (info) => {
    if (updateInstallMode === "manual") {
      setUpdateState({
        phase: "available", version: info.version,
        message: `Polyth ${info.version} is available. This build installs updates by hand: download it from the release page.`,
      });
      return;
    }
    setUpdateState({ phase: "available", message: `Polyth ${info.version} is available.`, version: info.version });
    const retried = downloadWhenFound;
    downloadWhenFound = false;
    if (retried || settings.automaticUpdates) void downloadUpdate({ showProgress: retried });
  });
  updater.on("update-not-available", (info) => {
    downloadWhenFound = false;
    setUpdateState({ phase: "up-to-date", message: `Polyth ${info.version} is current.`, version: info.version });
  });
  updater.on("download-progress", (progress) => setUpdateState({
    phase: "downloading", message: `Downloading Polyth ${updateState.version ?? "update"}…`,
    ...(updateState.version ? { version: updateState.version } : {}),
    percent: progress.percent, transferred: progress.transferred, total: progress.total, bytesPerSecond: progress.bytesPerSecond,
  }));
  updater.on("update-downloaded", (info) => {
    setUpdateState({ phase: "downloaded", message: "Update ready. Restart Polyth to install it.", version: info.version });
    // The restart prompt comes back even if the progress was hidden.
    if (downloadWatched) void showUpdateWindow();
    downloadWatched = false;
  });
  updater.on("error", (error) => {
    downloadWhenFound = false;
    const handingOver = updateState.phase === "installing";
    setUpdateState({ phase: "error", message: error.message });
    // The installer never started and the server is already down: start this
    // copy again, whose next start reports that the update did not install.
    if (handingOver && !quitStarted) {
      app.relaunch();
      app.exit(0);
      return;
    }
    if (downloadWatched) void showUpdateWindow();
    downloadWatched = false;
  });
  refreshAutomaticUpdateSchedule();
};

const startServer = async (preferredPort?: number): Promise<void> => {
  const binary = opencodePath();
  const webDist = webDistPath();
  const bundledOpenCode = existsSync(binary);
  if (app.isPackaged && !bundledOpenCode) {
    throw new Error(`Packaged OpenCode ${__POLYTH_OPENCODE_VERSION__} is missing at ${binary}`);
  }
  if (!bundledOpenCode) log(`Bundled OpenCode ${__POLYTH_OPENCODE_VERSION__} is missing at ${binary}; looking for an installed OpenCode instead`);
  // The availability probe resolves OpenCode without boot options; publish the
  // bundle so a machine with no OpenCode installed still reports it runnable
  // (backend-opencode POLYTH_OPENCODE_BUNDLED_BIN_ENV).
  if (bundledOpenCode) process.env.POLYTH_OPENCODE_BUNDLED_BIN = binary;
  else delete process.env.POLYTH_OPENCODE_BUNDLED_BIN;
  if (!existsSync(join(webDist, "index.html"))) throw new Error(`Polyth web bundle is missing at ${webDist}`);
  // The port is part of the window's origin: keeping it keeps the shell's
  // origin storage from one launch to the next (serverPort.ts).
  const savedPort = readSavedServerPort(serverPortPath);
  const port = preferredPort ?? await reserveServerPort(savedPort);
  baseUrl = `http://127.0.0.1:${port}`;
  process.env.POLYTH_DESKTOP = "1";
  const linkHost = linkHostPath();
  if (linkHost && existsSync(linkHost)) process.env.POLYTH_LINK_HOST = linkHost;
  if (app.isPackaged) process.env.POLYTH_RESOURCES_DIR ??= process.resourcesPath;
  const bundledChromium = stagedChromiumExecutable(process.resourcesPath, process.platform, process.arch);
  if (app.isPackaged) {
    if (!bundledChromium) {
      throw new Error(`Packaged Chromium is missing for ${process.platform}-${process.arch}`);
    }
    process.env.POLYTH_REQUIRE_BUNDLED_CHROMIUM = "1";
    process.env.POLYTH_CHROMIUM_PATH = bundledChromium;
  }
  desktopSetupClaims.reset();
  serverLifecycle = await boot({
    port, hostname: "127.0.0.1", dataDir, webDist, webPackagesDir: webPackagesPath(), serverPackages: desktopServerPackages,
    desktopOwnerChannel: true,
    ...(bundledOpenCode ? { opencode: { bin: binary, binarySource: "bundled" as const } } : {}),
  });
  log(`Polyth server started at ${baseUrl}`);
  await ensureDesktopOwnerSession().catch((error: unknown) => log("Could not open the owner session", error));
  if (savedPort !== null && port !== savedPort) log(`Port ${savedPort} was taken; the window opens on a new origin`);
  if (port !== savedPort) {
    await saveServerPort(serverPortPath, port).catch((error: unknown) => log("Could not save the server port", error));
  }
  if (bundledOpenCode) log(`Bundled OpenCode ${__POLYTH_OPENCODE_VERSION__}: ${binary}`);
};

async function restartDesktopSetupServer(): Promise<void> {
  const lifecycle = serverLifecycle;
  if (!lifecycle || !("setup" in lifecycle) || lifecycle.setup !== true) return;
  const port = Number(new URL(baseUrl).port);
  await lifecycle.shutdown();
  if (serverLifecycle === lifecycle) serverLifecycle = null;
  desktopSetupClaims.reset();
  await startServer(port);
  if (serverLifecycle && "setup" in serverLifecycle && serverLifecycle.setup === true) {
    throw new Error("Polyth setup did not reach the ready state");
  }
  log("Polyth server restarted automatically after desktop setup");
}

const showFatalStartupError = (error: unknown): void => {
  log("Desktop startup failed", error);
  dialog.showErrorBox("Polyth could not start", `${error instanceof Error ? error.message : String(error)}\n\nSee ${logPath}`);
};

async function start(): Promise<void> {
  bootstrapTrace("start() entered");
  dataDir = resolve(process.env.POLYTH_DATA_DIR ?? join(app.getPath("userData"), "data"));
  const desktopDir = join(app.getPath("userData"), "desktop");
  logPath = join(desktopDir, "polyth-desktop.log");
  log("Desktop start begin");
  settingsPath = join(desktopDir, "settings.json");
  windowStatePath = join(desktopDir, "window-state.json");
  serverPortPath = join(desktopDir, "server-port.json");
  updatePendingPath = join(desktopDir, "update-pending.json");
  settings = await readDesktopSettings(settingsPath, desktopSettingsDefaults);
  if (startupLowResourceMode) log("Low-resource mode active");
  if (startupSoftwareRendering) log("Software rendering active (GPU acceleration disabled)");
  await applyLoginSetting();
  applyKeepAwakeSetting();
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const trusted = isLocalNavigation(webContents.getURL());
    const mediaTypes = "mediaTypes" in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    callback(trusted && (permission === "notifications" || (permission === "media" && mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio"))));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    !!webContents && isLocalNavigation(webContents.getURL()) && (permission === "notifications" || (permission === "media" && details.mediaType === "audio")));
  // Cookies ignore ports: Polyth's session never leaves for another local port.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    const name = Object.keys(headers).find((key) => key.toLowerCase() === "cookie");
    const next = name && baseUrl ? withoutForeignSessionCookies(headers[name] ?? "", details.url, baseUrl) : null;
    if (name && next !== null) {
      if (next) headers[name] = next;
      else delete headers[name];
    }
    callback({ requestHeaders: headers });
  });
  log("Starting Polyth server");
  await startServer();
  if (startupSmoke) {
    log("Desktop startup smoke passed");
    quitting = true;
    await shutdownServer();
    app.exit(0);
    return;
  }
  installIpc();
  await configureUpdater();
  createTray();
  installApplicationMenu();
  await createWindow();
  if (app.isPackaged) reportPendingUpdate();
}

bootstrapTrace("before requestSingleInstanceLock");
const instanceLock = app.requestSingleInstanceLock();
bootstrapTrace(`after requestSingleInstanceLock: ${instanceLock}`);
if (!instanceLock) app.quit();
else {
  app.on("ready", () => {
    bootstrapTrace("ready event");
    void start().catch(async (error) => {
      showFatalStartupError(error);
      quitting = true;
      await shutdownServer();
      app.exit(1);
    });
  });
  app.on("second-instance", (_event, argv) => openFromSecondInstance(argv));
  app.on("activate", showWindow);
  app.on("before-quit", (event) => {
    quitting = true;
    quitStarted = true;
    if (serverStopped) return;
    event.preventDefault();
    void shutdownServer().finally(() => app.quit());
  });
  app.on("window-all-closed", () => { if (!settings?.closeToTray && process.platform !== "darwin") quitApp(); });
}

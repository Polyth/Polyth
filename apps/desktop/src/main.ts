import {
  app,
  BrowserWindow,
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
  type IpcMainInvokeEvent,
  type Rectangle,
} from "electron";
import electronUpdater from "electron-updater";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { boot } from "@polyth/server";
import { setLinuxAutostartEnabled } from "./linuxAutostart.ts";
import { validateAbsoluteLocalPath } from "./localPath.ts";
import { desktopServerPackages } from "./serverPackages.ts";
import {
  normalizeDesktopSettings,
  readDesktopSettings,
  readDesktopSettingsSync,
  writeDesktopSettings,
} from "./settings.ts";
import type {
  DesktopInfo,
  DesktopSettings,
  DesktopUpdateState,
  DesktopWindowAction,
  DesktopWindowState,
} from "./types.ts";
import { assertUpdaterCapability } from "./updaterCapability.ts";
import { resolveUpdaterChannel } from "./updaterChannel.ts";
import { stagedChromiumExecutable } from "./chromiumResource.ts";
import {
  startDesktopChatWorkspaceRemoteCoordinator,
  type DesktopChatWorkspaceRemoteCoordinator,
} from "./chatWorkspaceRemoteCoordinator.ts";

declare const __POLYTH_OPENCODE_VERSION__: string;
const { autoUpdater } = electronUpdater;
const backgroundStart = process.argv.includes("--background");

interface SavedWindowState {
  bounds?: Rectangle;
  maximized?: boolean;
}

const isE2e = process.env.POLYTH_DESKTOP_E2E === "1";
const startupSmoke = process.env.POLYTH_DESKTOP_STARTUP_SMOKE === "1";
if (process.env.POLYTH_DESKTOP_USER_DATA) {
  app.setPath("userData", resolve(process.env.POLYTH_DESKTOP_USER_DATA));
}
const startupSettings = readDesktopSettingsSync(join(app.getPath("userData"), "desktop", "settings.json"));
const startupLowResourceMode = startupSettings.lowResourceMode;
if (startupLowResourceMode) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disk-cache-size", String(32 * 1024 * 1024));
  process.env.POLYTH_TERM_REPLAY_BYTES ??= String(64 * 1024);
  process.env.POLYTH_MAX_TERMINALS ??= "4";
}
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-transparent-visuals");
}
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let settings: DesktopSettings;
let baseUrl = "";
let dataDir = "";
let logPath = "";
let settingsPath = "";
let windowStatePath = "";
let serverLifecycle: Awaited<ReturnType<typeof boot>> | null = null;
let chatWorkspaceRemoteCoordinator: DesktopChatWorkspaceRemoteCoordinator | null = null;
let updateState: DesktopUpdateState = { phase: "idle", message: "Updates are ready to check." };
let quitting = false;
let serverStopped = false;
let keepAwakeBlockerId: number | null = null;
let updateStartupTimer: NodeJS.Timeout | null = null;
let updateTimer: NodeJS.Timeout | null = null;
let saveBoundsTimer: NodeJS.Timeout | null = null;

app.setName("Polyth");

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

const reservePort = (): Promise<number> => new Promise((resolvePort, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      reject(new Error("Could not reserve a local port"));
      return;
    }
    const port = address.port;
    server.close((error) => error ? reject(error) : resolvePort(port));
  });
});

const packagedResource = (name: string): string => join(process.resourcesPath, name);

const appIconPath = (): string => app.isPackaged
  ? packagedResource("icon.png")
  : join(app.getAppPath(), "build", "icon.png");

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

const linkClientPath = (): string | undefined => {
  if (process.env.POLYTH_LINK_CLIENT) return process.env.POLYTH_LINK_CLIENT;
  if (process.platform === "win32") return undefined;
  const executable = "polyth-link-client";
  return app.isPackaged
    ? packagedResource(join("polyth-link", executable))
    : join(app.getAppPath(), "resources", "polyth-link", executable);
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
    maximized: mainWindow.isMaximized(),
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
  visible: mainWindow?.isVisible() ?? false,
  focused: mainWindow?.isFocused() ?? false,
});

const sendToRenderer = (channel: string, value: unknown): void => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, value);
};

const broadcastWindowState = (): void => sendToRenderer("desktop:window:state", windowState());

const showWindow = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
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

const applyKeepAwakeSetting = (): void => {
  const active = keepAwakeBlockerId !== null && powerSaveBlocker.isStarted(keepAwakeBlockerId);
  if (settings.keepAwake && !active) {
    keepAwakeBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    log("Keep-awake enabled");
  } else if (!settings.keepAwake && active && keepAwakeBlockerId !== null) {
    powerSaveBlocker.stop(keepAwakeBlockerId);
    keepAwakeBlockerId = null;
    log("Keep-awake disabled");
  }
};

const persistSettings = async (patch: unknown): Promise<DesktopSettings> => {
  const requested = patch && typeof patch === "object" && !Array.isArray(patch)
    ? patch as Partial<DesktopSettings>
    : {};
  const next = normalizeDesktopSettings({ ...settings, ...requested });
  settings = next;
  nativeTheme.themeSource = settings.controlsTheme;
  await applyLoginSetting();
  applyKeepAwakeSetting();
  refreshAutomaticUpdateSchedule();
  await writeDesktopSettings(settingsPath, settings);
  sendToRenderer("desktop:settings:changed", settings);
  rebuildTrayMenu();
  return settings;
};

const setUpdateState = (next: DesktopUpdateState): DesktopUpdateState => {
  updateState = next;
  sendToRenderer("desktop:update:state", next);
  rebuildTrayMenu();
  log(`Updater: ${next.phase} — ${next.message}`);
  return next;
};

const checkForUpdates = async (): Promise<DesktopUpdateState> => {
  if (!app.isPackaged || isE2e) {
    return setUpdateState({
      phase: "disabled",
      message: app.isPackaged ? "Update checks are disabled in the desktop test harness." : "Update checks are available in packaged builds.",
    });
  }
  try {
    assertUpdaterCapability({ packaged: app.isPackaged });
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setUpdateState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
  }
  return updateState;
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

const downloadUpdate = async (): Promise<DesktopUpdateState> => {
  if (updateState.phase !== "available") return updateState;
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    setUpdateState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
  }
  return updateState;
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
  await chatWorkspaceRemoteCoordinator?.close().catch((error) => log("Chat Workspace remote worker shutdown failed", error));
  chatWorkspaceRemoteCoordinator = null;
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
    { label: "Close to tray", type: "checkbox", checked: settings.closeToTray, click: ({ checked }) => void persistSettings({ closeToTray: checked }) },
    { label: "Launch at login", type: "checkbox", visible: app.isPackaged && ["darwin", "linux", "win32"].includes(process.platform), checked: settings.launchAtLogin, click: ({ checked }) => void persistSettings({ launchAtLogin: checked }) },
    { label: "Keep awake while running", type: "checkbox", checked: settings.keepAwake, click: ({ checked }) => void persistSettings({ keepAwake: checked }) },
    { type: "separator" },
    {
      label: updateState.phase === "downloading"
        ? `Downloading update${updateState.percent === undefined ? "…" : ` ${Math.round(updateState.percent)}%`}`
        : updateState.phase === "downloaded" ? "Restart to update" : "Check for updates",
      enabled: updateState.phase !== "checking" && updateState.phase !== "downloading",
      click: () => { if (updateState.phase === "downloaded") void installUpdate(); else void checkForUpdates(); },
    },
    { type: "separator" },
    { label: "Quit Polyth", accelerator: "CommandOrControl+Q", click: quitApp },
  ]));
}

const createTray = (): void => {
  const icon = nativeImage.createFromPath(appIconPath()).resize({ width: 18, height: 18 });
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

const installApplicationMenu = (): void => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{
      label: "Polyth",
      submenu: [
        { role: "about" as const },
        { type: "separator" as const },
        { label: "Check for Updates…", click: () => void checkForUpdates() },
        { type: "separator" as const },
        { role: "hide" as const }, { role: "hideOthers" as const }, { role: "unhide" as const },
        { type: "separator" as const }, { role: "quit" as const },
      ],
    }] : []),
    { label: "File", submenu: [
      { label: "Show Polyth", accelerator: "CommandOrControl+Shift+P", click: showWindow },
      { label: "Open Data Folder", click: () => void shell.openPath(dataDir) },
      { type: "separator" }, { role: process.platform === "darwin" ? "close" : "quit" },
    ] },
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ] },
    { label: "View", submenu: [
      { role: "reload" }, ...(isE2e || !app.isPackaged ? [{ role: "toggleDevTools" as const }] : []),
      { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      { type: "separator" }, { role: "togglefullscreen" },
    ] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "front" }] },
  ]));
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
  const window = new BrowserWindow({
    width: bounds?.width ?? (startupLowResourceMode ? 1100 : 1360),
    height: bounds?.height ?? (startupLowResourceMode ? 720 : 860),
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 760,
    minHeight: 520,
    frame: false,
    roundedCorners: true,
    show: false,
    title: "Polyth",
    // Linux CSD does not round a frameless window. A transparent host lets
    // renderer CSS clip .app to --radius-sheet. Other platforms keep an
    // opaque color so the first paint matches the shell. Disable the native
    // shadow on Linux so it cannot paint a square halo around the clip.
    transparent: process.platform === "linux",
    hasShadow: process.platform !== "linux",
    backgroundColor: process.platform === "linux" ? "#00000000" : "#121110",
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
  if (saved.maximized) window.maximize();
  window.webContents.setWindowOpenHandler(({ url }) => { if (safeExternalUrl(url)) void shell.openExternal(url); return { action: "deny" }; });
  window.webContents.on("will-navigate", (event, url) => { if (isLocalNavigation(url)) return; event.preventDefault(); if (safeExternalUrl(url)) void shell.openExternal(url); });
  window.webContents.on("render-process-gone", (_event, details) => log(`Renderer stopped: ${details.reason} (${details.exitCode})`));
  window.on("resize", scheduleWindowStateSave);
  window.on("move", scheduleWindowStateSave);
  window.on("maximize", broadcastWindowState);
  window.on("unmaximize", broadcastWindowState);
  window.on("show", () => { broadcastWindowState(); rebuildTrayMenu(); });
  window.on("hide", () => { broadcastWindowState(); rebuildTrayMenu(); });
  window.on("focus", broadcastWindowState);
  window.on("blur", broadcastWindowState);
  window.on("close", (event) => {
    if (!quitting && settings.closeToTray) { event.preventDefault(); window.hide(); broadcastWindowState(); log("Window hidden to tray"); }
  });
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; rebuildTrayMenu(); });
  window.once("ready-to-show", () => {
    if (!settings.startMinimized && !backgroundStart) { window.show(); window.focus(); }
    else log(backgroundStart ? "Started in background from login item" : "Started hidden in system tray");
    log("Desktop renderer ready");
  });
  for (let attempt = 1; ; attempt += 1) {
    try { await window.loadURL(baseUrl); break; }
    catch (error) {
      if (attempt >= 3 || window.isDestroyed()) throw error;
      log(`Renderer navigation attempt ${attempt} failed; retrying`, error);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 250));
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

const requireChatWorkspaceCoordinator = (): DesktopChatWorkspaceRemoteCoordinator => {
  if (!chatWorkspaceRemoteCoordinator) {
    throw Object.assign(new Error("Desktop Polyth Link client is unavailable"), { code: "link-client-unavailable" });
  }
  return chatWorkspaceRemoteCoordinator;
};

const installUpdate = async (): Promise<void> => {
  if (updateState.phase !== "downloaded") return;
  quitting = true;
  await shutdownServer();
  autoUpdater.quitAndInstall(false, true);
};

const installIpc = (): void => {
  trustedHandle("desktop:info", (): DesktopInfo => ({
    appVersion: app.getVersion(), opencodeVersion: __POLYTH_OPENCODE_VERSION__, platform: process.platform, arch: process.arch,
    dataDir, logPath, packaged: app.isPackaged, trayAvailable: tray !== null,
    canLaunchAtLogin: app.isPackaged && ["darwin", "linux", "win32"].includes(process.platform),
    keepAwakeActive: keepAwakeBlockerId !== null && powerSaveBlocker.isStarted(keepAwakeBlockerId), lowResourceMode: startupLowResourceMode,
  }));
  trustedHandle("desktop:settings:get", () => settings);
  trustedHandle("desktop:settings:set", (_event, patch: unknown) => persistSettings(patch));
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
  trustedHandle("desktop:chat-workspace:connections", async () => ({
    activeConnectionId: chatWorkspaceRemoteCoordinator?.activeConnectionId() ?? null,
    connections: await chatWorkspaceRemoteCoordinator?.listConnections() ?? [],
  }));
  trustedHandle("desktop:chat-workspace:connect", async (_event, rawConnectionId: unknown) => {
    const connectionId = typeof rawConnectionId === "string" ? rawConnectionId.trim() : "";
    if (!connectionId || connectionId.length > 200) throw new Error("Invalid Polyth Link connection id");
    return requireChatWorkspaceCoordinator().connect(connectionId);
  });
  trustedHandle("desktop:chat-workspace:pairing:preview", async (_event, rawTicket: unknown) => {
    const ticket = typeof rawTicket === "string" ? rawTicket.trim() : "";
    if (!ticket || ticket.length > 32_768) throw new Error("Invalid Polyth Link pairing ticket");
    return requireChatWorkspaceCoordinator().parsePairingTicket(ticket);
  });
  trustedHandle("desktop:chat-workspace:pairing:begin", async (_event, rawTicket: unknown, rawLabel: unknown) => {
    const ticket = typeof rawTicket === "string" ? rawTicket.trim() : "";
    const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
    if (!ticket || ticket.length > 32_768) throw new Error("Invalid Polyth Link pairing ticket");
    if (!label || label.length > 120) throw new Error("Invalid pairing device label");
    return requireChatWorkspaceCoordinator().beginPairing(ticket, label);
  });
  trustedHandle("desktop:chat-workspace:pairing:confirm", async (_event, rawAttemptId: unknown) => {
    const attemptId = typeof rawAttemptId === "string" ? rawAttemptId.trim() : "";
    if (!attemptId || attemptId.length > 200) throw new Error("Invalid pairing attempt id");
    return requireChatWorkspaceCoordinator().confirmPairing(attemptId);
  });
  trustedHandle("desktop:chat-workspace:pairing:cancel", async (_event, rawAttemptId: unknown) => {
    const attemptId = typeof rawAttemptId === "string" ? rawAttemptId.trim() : "";
    if (!attemptId || attemptId.length > 200) throw new Error("Invalid pairing attempt id");
    await requireChatWorkspaceCoordinator().cancelPairing(attemptId);
    return { ok: true };
  });
  trustedHandle("desktop:chat-workspace:disconnect", async () => { await chatWorkspaceRemoteCoordinator?.disconnect(); return { ok: true }; });
  trustedHandle("desktop:quit", () => { setImmediate(quitApp); });
  trustedHandle("desktop:update:check", checkForUpdates);
  trustedHandle("desktop:update:download", downloadUpdate);
  trustedHandle("desktop:update:install", installUpdate);
};

const configureUpdater = (): void => {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  const updateChannel = resolveUpdaterChannel();
  if (updateChannel) autoUpdater.channel = updateChannel;
  autoUpdater.logger = {
    info: (message?: unknown) => log(`updater ${String(message ?? "")}`),
    warn: (message?: unknown) => log(`updater warning ${String(message ?? "")}`),
    error: (message?: unknown) => log(`updater error ${String(message ?? "")}`),
    debug: (message?: unknown) => log(`updater debug ${String(message ?? "")}`),
  };
  log(`Updater configured for ${updateChannel ?? "latest"} channel`);
  autoUpdater.on("checking-for-update", () => setUpdateState({ phase: "checking", message: "Checking GitHub Releases…" }));
  autoUpdater.on("update-available", (info) => {
    setUpdateState({ phase: "available", message: `Polyth ${info.version} is available.`, version: info.version });
    if (settings.automaticUpdates) void downloadUpdate();
  });
  autoUpdater.on("update-not-available", (info) => setUpdateState({ phase: "up-to-date", message: `Polyth ${info.version} is current.`, version: info.version }));
  autoUpdater.on("download-progress", (progress) => setUpdateState({
    phase: "downloading", message: `Downloading Polyth ${updateState.version ?? "update"}…`,
    ...(updateState.version ? { version: updateState.version } : {}), percent: progress.percent,
  }));
  autoUpdater.on("update-downloaded", (info) => setUpdateState({ phase: "downloaded", message: "Update ready. Restart Polyth to install it.", version: info.version }));
  autoUpdater.on("error", (error) => setUpdateState({ phase: "error", message: error.message }));
  refreshAutomaticUpdateSchedule();
};

const startServer = async (): Promise<void> => {
  const binary = opencodePath();
  const webDist = webDistPath();
  const bundledOpenCode = existsSync(binary);
  if (app.isPackaged && !bundledOpenCode) {
    throw new Error(`Packaged OpenCode ${__POLYTH_OPENCODE_VERSION__} is missing at ${binary}`);
  }
  if (!bundledOpenCode) log(`Bundled OpenCode ${__POLYTH_OPENCODE_VERSION__} is missing at ${binary}; looking for an installed OpenCode instead`);
  if (!existsSync(join(webDist, "index.html"))) throw new Error(`Polyth web bundle is missing at ${webDist}`);
  const port = await reservePort();
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
  serverLifecycle = await boot({
    port, hostname: "127.0.0.1", dataDir, webDist, webPackagesDir: webPackagesPath(), serverPackages: desktopServerPackages,
    ...(bundledOpenCode ? { opencode: { bin: binary, binarySource: "bundled" as const } } : {}),
  });
  log(`Polyth server started at ${baseUrl}`);
  if (bundledOpenCode) log(`Bundled OpenCode ${__POLYTH_OPENCODE_VERSION__}: ${binary}`);
};

const startChatWorkspaceRemoteCoordinator = async (): Promise<void> => {
  const binary = linkClientPath();
  if (!binary || !existsSync(binary)) {
    log(process.platform === "win32" ? "Desktop Chat Workspace remote worker is disabled on Windows until Link client named-pipe IPC lands" : "Polyth Link client binary is unavailable; remote Chat Workspace device worker disabled");
    return;
  }
  const desktopDir = join(app.getPath("userData"), "desktop");
  chatWorkspaceRemoteCoordinator = await startDesktopChatWorkspaceRemoteCoordinator({
    linkClientBinary: binary, dataDir, runtimeDir: join(desktopDir, "runtime"), webDist: webDistPath(), deviceName: app.getName(), log,
  });
  log("Desktop Chat Workspace remote coordinator ready");
};

const showFatalStartupError = (error: unknown): void => {
  log("Desktop startup failed", error);
  dialog.showErrorBox("Polyth could not start", `${error instanceof Error ? error.message : String(error)}\n\nSee ${logPath}`);
};

async function start(): Promise<void> {
  dataDir = resolve(process.env.POLYTH_DATA_DIR ?? join(app.getPath("userData"), "data"));
  const desktopDir = join(app.getPath("userData"), "desktop");
  logPath = join(desktopDir, "polyth-desktop.log");
  settingsPath = join(desktopDir, "settings.json");
  windowStatePath = join(desktopDir, "window-state.json");
  settings = await readDesktopSettings(settingsPath);
  nativeTheme.themeSource = settings.controlsTheme;
  if (startupLowResourceMode) log("Low-resource mode active");
  await applyLoginSetting();
  applyKeepAwakeSetting();
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const trusted = isLocalNavigation(webContents.getURL());
    const mediaTypes = "mediaTypes" in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    callback(trusted && (permission === "notifications" || (permission === "media" && mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio"))));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    !!webContents && isLocalNavigation(webContents.getURL()) && (permission === "notifications" || (permission === "media" && details.mediaType === "audio")));
  await startServer();
  if (startupSmoke) {
    log("Desktop startup smoke passed");
    quitting = true;
    await shutdownServer();
    app.exit(0);
    return;
  }
  await startChatWorkspaceRemoteCoordinator().catch((error) => log("Could not start Desktop Chat Workspace remote coordinator", error));
  installIpc();
  configureUpdater();
  createTray();
  installApplicationMenu();
  await createWindow();
}

const instanceLock = app.requestSingleInstanceLock();
if (!instanceLock) app.quit();
else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", (event) => {
    quitting = true;
    if (serverStopped) return;
    event.preventDefault();
    void shutdownServer().finally(() => app.quit());
  });
  app.on("window-all-closed", () => { if (!settings?.closeToTray && process.platform !== "darwin") quitApp(); });
  void app.whenReady().then(start).catch(async (error) => {
    showFatalStartupError(error);
    quitting = true;
    await shutdownServer();
    app.exit(1);
  });
}

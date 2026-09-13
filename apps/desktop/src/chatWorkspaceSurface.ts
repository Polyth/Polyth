import {
  BrowserWindow,
  WebContentsView,
  ipcMain,
  type IpcMainInvokeEvent,
  type Rectangle,
} from "electron";

export interface ChatWorkspaceSurfaceBounds extends Rectangle {
  visible: boolean;
  claimed: boolean;
}

const IPC_CHANNEL = "desktop:chat-workspace:surface";
const FALLBACK_DELAY_MS = 350;
let hostWindow: BrowserWindow | null = null;
let fallbackWindow: BrowserWindow | null = null;
let activeView: WebContentsView | null = null;
let attachedView: WebContentsView | null = null;
let installed = false;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
let surface: ChatWorkspaceSurfaceBounds = { x: 0, y: 0, width: 0, height: 0, visible: false, claimed: false };

const cancelFallbackTimer = (): void => {
  if (!fallbackTimer) return;
  clearTimeout(fallbackTimer);
  fallbackTimer = null;
};

const detach = (): void => {
  if (!attachedView) return;
  if (hostWindow && !hostWindow.isDestroyed()) {
    try { hostWindow.contentView.removeChildView(attachedView); } catch {}
  }
  attachedView = null;
};

const closeFallback = (): void => {
  cancelFallbackTimer();
  const fallback = fallbackWindow;
  fallbackWindow = null;
  if (!fallback) return;
  if (hostWindow === fallback) {
    detach();
    hostWindow = null;
  }
  if (!fallback.isDestroyed()) fallback.destroy();
};

const attach = (window: BrowserWindow, view: WebContentsView, bounds: Rectangle): void => {
  if (hostWindow !== window || attachedView !== view) {
    detach();
    hostWindow = window;
    window.contentView.addChildView(view);
    attachedView = view;
  }
  view.setBounds(bounds);
};

const ensureFallback = (): void => {
  if (surface.claimed || !activeView || fallbackWindow) return;
  const fallback = new BrowserWindow({
    width: 1060,
    height: 780,
    minWidth: 560,
    minHeight: 420,
    show: false,
    title: "Chat Workspace",
    backgroundColor: "#ffffff",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  fallbackWindow = fallback;
  fallback.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const syncFallbackBounds = () => {
    if (!activeView || fallback.isDestroyed() || fallbackWindow !== fallback) return;
    const content = fallback.getContentBounds();
    attach(fallback, activeView, { x: 0, y: 0, width: content.width, height: content.height });
  };
  fallback.on("resize", syncFallbackBounds);
  fallback.on("closed", () => {
    if (fallbackWindow === fallback) fallbackWindow = null;
    if (hostWindow === fallback) {
      attachedView = null;
      hostWindow = null;
    }
  });
  syncFallbackBounds();
  fallback.show();
  fallback.focus();
};

const scheduleFallback = (): void => {
  cancelFallbackTimer();
  if (surface.claimed || !activeView) return;
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    ensureFallback();
  }, FALLBACK_DELAY_MS);
  fallbackTimer.unref?.();
};

const sync = (): void => {
  if (!activeView) {
    detach();
    closeFallback();
    return;
  }
  const canEmbed = surface.claimed
    && hostWindow
    && hostWindow !== fallbackWindow
    && !hostWindow.isDestroyed()
    && surface.visible
    && surface.width > 0
    && surface.height > 0;
  if (canEmbed) {
    closeFallback();
    attach(hostWindow!, activeView, { x: surface.x, y: surface.y, width: surface.width, height: surface.height });
    return;
  }
  if (surface.claimed) {
    closeFallback();
    detach();
    return;
  }
  if (fallbackWindow && !fallbackWindow.isDestroyed()) {
    const content = fallbackWindow.getContentBounds();
    attach(fallbackWindow, activeView, { x: 0, y: 0, width: content.width, height: content.height });
    return;
  }
  detach();
  scheduleFallback();
};

const senderWindow = (event: IpcMainInvokeEvent): BrowserWindow => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || window.isDestroyed() || event.sender !== window.webContents) {
    throw new Error("Untrusted Chat Workspace surface IPC sender");
  }
  let url: URL;
  try { url = new URL(event.senderFrame?.url ?? event.sender.getURL()); }
  catch { throw new Error("Untrusted Chat Workspace surface IPC sender"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Untrusted Chat Workspace surface IPC sender");
  }
  return window;
};

const normalizeFromRenderer = (event: IpcMainInvokeEvent, raw: unknown): ChatWorkspaceSurfaceBounds => {
  const window = senderWindow(event);
  const input = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
  const numbers = [Number(input?.x), Number(input?.y), Number(input?.width), Number(input?.height)];
  if (!numbers.every(Number.isFinite)) throw new Error("Invalid Chat Workspace surface bounds");
  const content = window.getContentBounds();
  const x = Math.max(0, Math.min(Math.round(numbers[0]!), content.width));
  const y = Math.max(0, Math.min(Math.round(numbers[1]!), content.height));
  const width = Math.max(0, Math.min(Math.round(numbers[2]!), content.width - x));
  const height = Math.max(0, Math.min(Math.round(numbers[3]!), content.height - y));
  const claimed = Boolean(input?.claimed);
  if (claimed) {
    if (hostWindow !== window) {
      detach();
      hostWindow = window;
    }
  } else if (hostWindow === window) {
    detach();
    hostWindow = null;
  }
  return { x, y, width, height, visible: Boolean(input?.visible), claimed };
};

export function installChatWorkspaceSurfaceIpc(): void {
  if (installed) return;
  installed = true;
  ipcMain.handle(IPC_CHANNEL, (event, raw: unknown) => {
    surface = normalizeFromRenderer(event, raw);
    sync();
    return { ok: true as const };
  });
}

export function uninstallChatWorkspaceSurfaceIpc(): void {
  if (!installed) return;
  installed = false;
  ipcMain.removeHandler(IPC_CHANNEL);
  clearChatWorkspaceSurface();
}

export function showChatWorkspaceView(view: WebContentsView): void {
  if (activeView !== view) {
    detach();
    activeView = view;
  }
  sync();
}

export function hideChatWorkspaceView(view: WebContentsView): void {
  if (activeView !== view) return;
  activeView = null;
  detach();
  closeFallback();
}

export function clearChatWorkspaceSurface(): void {
  cancelFallbackTimer();
  detach();
  activeView = null;
  hostWindow = null;
  surface = { x: 0, y: 0, width: 0, height: 0, visible: false, claimed: false };
  closeFallback();
}

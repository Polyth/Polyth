// Native web views: the real Chromium pages behind Polyth's browser on this
// computer. The in-process server's browser package drives each page over its
// own DevTools Protocol session (SERVER_NATIVE_WEB_VIEWS); the local window
// shows a page live by giving it a place (`desktop:webviews:place`).
//
// A view always lives in a window: a page outside every window paints nothing
// and never answers a screenshot. While no window shows it, it waits in one
// hidden parking window, painting and running as if it were on screen.
import { BrowserWindow, WebContentsView, app, session as electronSession, type ContextMenuParams, type Session, type WebContents } from "electron";
import { randomBytes } from "node:crypto";
import type {
  NativeWebView,
  NativeWebViewCreateOptions,
  NativeWebViewGoneReason,
  NativeWebViewHost,
  NativeWebViewRequest,
} from "@polyth/plugins";
import {
  ALLOWED_PERMISSIONS,
  MAX_SIDE,
  confinedProfileDir,
  parseViewRect,
  plainChromeUserAgent,
  schemeVerdict,
  type NativeWebViewRect,
} from "./nativeWebViewPolicy.ts";

export type { NativeWebViewRect } from "./nativeWebViewPolicy.ts";

const MAX_VIEWS = 32;
const invalid = (): Error => Object.assign(new Error("invalid-request"), { code: "invalid-request" });

export interface DesktopNativeWebViews extends NativeWebViewHost {
  /** Show a view in `window` at `rect` (CSS px of that window), or park it
   * with `null`. Unknown ids and malformed rects are refused. */
  place(window: BrowserWindow, id: unknown, rect: unknown): void;
  /** Park every view `window` shows: its page navigated, reloaded or closed. */
  parkFrom(window: BrowserWindow): void;
  /** The view whose page `contents` is, for context menus and the like. */
  viewOf(contents: WebContents): { id: string; contents: WebContents; bounds: NativeWebViewRect } | null;
  closeAll(): Promise<void>;
}

export interface DesktopNativeWebViewsOptions {
  /** Persistent profiles must lie inside this directory. */
  dataDir: string;
  log: (message: string, error?: unknown) => void;
  /** Right click on a page; `window` is the one showing it, null while parked. */
  onContextMenu?: (window: BrowserWindow | null, contents: WebContents, params: ContextMenuParams, bounds: NativeWebViewRect) => void;
}

interface ViewRecord {
  id: string;
  view: WebContentsView;
  contents: WebContents;
  session: Session;
  ephemeral: boolean;
  guard: NativeWebViewCreateOptions["guardRequest"];
  parked: { width: number; height: number };
  host: BrowserWindow | null;
  bounds: NativeWebViewRect;
  shown: boolean;
  gone: boolean;
  listeners: {
    windowOpen: Set<(url: string) => void>;
    gone: Set<(reason: NativeWebViewGoneReason) => void>;
    download: Set<(url: string) => void>;
    shown: Set<(shown: boolean) => void>;
    cdp: Set<(method: string, params: unknown) => void>;
  };
}

export function createDesktopNativeWebViews(opts: DesktopNativeWebViewsOptions): DesktopNativeWebViews {
  const views = new Map<string, ViewRecord>();
  const byContents = new Map<number, ViewRecord>();
  const hardened = new WeakSet<Session>();
  let parking: BrowserWindow | null = null;

  const emit = <T>(set: Set<(value: T) => void>, value: T) => {
    for (const listener of [...set]) {
      try { listener(value); } catch (error) { opts.log("Native web view listener failed", error); }
    }
  };

  const parkingWindow = (): BrowserWindow => {
    if (parking && !parking.isDestroyed()) return parking;
    parking = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      paintWhenInitiallyHidden: true,
      skipTaskbar: true,
      focusable: false,
      title: "Polyth browser pages",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    parking.on("closed", () => { parking = null; });
    return parking;
  };

  const fitParking = () => {
    const window = parkingWindow();
    let width = 320;
    let height = 240;
    for (const record of views.values()) {
      if (record.host) continue;
      width = Math.max(width, record.parked.width);
      height = Math.max(height, record.parked.height);
    }
    const [w, h] = window.getContentSize();
    if (w !== width || h !== height) window.setContentSize(width, height);
  };

  const setShown = (record: ViewRecord, shown: boolean) => {
    if (record.shown === shown) return;
    record.shown = shown;
    emit(record.listeners.shown, shown);
  };

  const park = (record: ViewRecord) => {
    if (record.gone) return;
    const window = parkingWindow();
    if (record.host && !record.host.isDestroyed() && record.host !== window) {
      // The page keeps the size it was shown at: stepping back behind a menu
      // must not reflow it or change the frames' geometry.
      record.parked = { width: record.bounds.width, height: record.bounds.height };
      const hadFocus = record.contents.isFocused();
      record.host.contentView.removeChildView(record.view);
      if (hadFocus) record.host.webContents.focus();
    }
    record.host = null;
    record.bounds = { x: 0, y: 0, ...record.parked };
    window.contentView.addChildView(record.view);
    record.view.setBounds(record.bounds);
    fitParking();
    setShown(record, false);
  };

  const finish = (record: ViewRecord, reason: NativeWebViewGoneReason) => {
    if (record.gone) return;
    record.gone = true;
    views.delete(record.id);
    byContents.delete(record.contents.id);
    emit(record.listeners.gone, reason);
    for (const set of Object.values(record.listeners)) set.clear();
  };

  const destroy = async (record: ViewRecord, reason: NativeWebViewGoneReason) => {
    const ses = record.session;
    const ephemeral = record.ephemeral;
    finish(record, reason);
    try {
      if (record.host && !record.host.isDestroyed()) record.host.contentView.removeChildView(record.view);
      else if (parking && !parking.isDestroyed()) parking.contentView.removeChildView(record.view);
    } catch { /* window already gone */ }
    try { if (record.contents.debugger.isAttached()) record.contents.debugger.detach(); } catch { /* gone */ }
    if (!record.contents.isDestroyed()) record.contents.close();
    // An in-memory storage outlives its last page in Electron: empty it.
    if (ephemeral) await ses.clearData().catch(() => {});
    if (views.size === 0 && parking && !parking.isDestroyed()) {
      parking.destroy();
      parking = null;
    }
  };

  const harden = (ses: Session) => {
    if (hardened.has(ses)) return;
    hardened.add(ses);
    ses.setUserAgent(plainChromeUserAgent(ses.getUserAgent(), app.getName()));
    ses.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
    ses.setDevicePermissionHandler(() => false);
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    ses.on("will-download", (event, item, contents) => {
      event.preventDefault();
      const record = contents ? byContents.get(contents.id) : undefined;
      if (record) emit(record.listeners.download, item.getURL());
    });
    ses.webRequest.onBeforeRequest((details, callback) => {
      const mainFrame = details.resourceType === "mainFrame";
      const verdict = schemeVerdict(details.url, mainFrame);
      if (verdict !== "guard") { callback({ cancel: verdict === "deny" }); return; }
      // A worker's request has no page: it answers to the newest page of
      // this storage, the same person's browser.
      const record = details.webContentsId !== undefined
        ? byContents.get(details.webContentsId)
        : [...views.values()].reverse().find((candidate) => candidate.session === ses);
      if (!record?.guard || record.gone) { callback({ cancel: true }); return; }
      const request: NativeWebViewRequest = { url: details.url, kind: mainFrame ? "navigation" : "subresource" };
      record.guard(request).then(
        (ok) => callback({ cancel: ok !== true }),
        () => callback({ cancel: true }),
      );
    });
  };

  const sessionFor = (profileDir: string | undefined): { session: Session; ephemeral: boolean } => {
    if (profileDir) return { session: electronSession.fromPath(confinedProfileDir(opts.dataDir, profileDir)), ephemeral: false };
    return { session: electronSession.fromPartition(`polyth-page-${randomBytes(12).toString("hex")}`, { cache: false }), ephemeral: true };
  };

  const host: DesktopNativeWebViews = {
    async create(createOpts) {
      if (views.size >= MAX_VIEWS) throw Object.assign(new Error("too many native pages"), { code: "limit" });
      const width = Math.min(Math.max(Math.round(createOpts.width), 1), MAX_SIDE);
      const height = Math.min(Math.max(Math.round(createOpts.height), 1), MAX_SIDE);
      const { session: ses, ephemeral } = sessionFor(createOpts.profileDir);
      harden(ses);
      const view = new WebContentsView({
        webPreferences: {
          session: ses,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          backgroundThrottling: false,
          navigateOnDragDrop: false,
          safeDialogs: true,
          spellcheck: true,
        },
      });
      const contents = view.webContents;
      const record: ViewRecord = {
        id: randomBytes(18).toString("base64url"),
        view,
        contents,
        session: ses,
        ephemeral,
        guard: createOpts.guardRequest,
        parked: { width, height },
        host: null,
        bounds: { x: 0, y: 0, width, height },
        shown: false,
        gone: false,
        listeners: { windowOpen: new Set(), gone: new Set(), download: new Set(), shown: new Set(), cdp: new Set() },
      };
      views.set(record.id, record);
      byContents.set(contents.id, record);
      contents.setBackgroundThrottling(false);
      contents.setWindowOpenHandler(({ url }) => {
        emit(record.listeners.windowOpen, url);
        return { action: "deny" };
      });
      contents.on("will-attach-webview", (event) => event.preventDefault());
      contents.on("context-menu", (_event, params) => opts.onContextMenu?.(record.host, contents, params, record.bounds));
      contents.on("render-process-gone", () => { void destroy(record, "crashed"); });
      contents.on("destroyed", () => finish(record, "closed"));
      const cdp = contents.debugger;
      try {
        cdp.attach("1.3");
      } catch (error) {
        await destroy(record, "debugger-detached");
        throw error;
      }
      cdp.on("message", (_event, method, params, sessionId) => {
        if (sessionId) return;
        for (const listener of [...record.listeners.cdp]) {
          try { listener(method, params); } catch (error) { opts.log("Native web view CDP listener failed", error); }
        }
      });
      cdp.on("detach", () => { void destroy(record, "debugger-detached"); });
      park(record);
      // A view that never loaded a document leaves the first DevTools
      // command (Page.enable) unanswered (seen on Electron 45, Linux): give it
      // an empty page before anyone drives it.
      try {
        await contents.loadURL("about:blank");
      } catch (error) {
        await destroy(record, "crashed");
        throw error;
      }
      const page: NativeWebView = {
        id: record.id,
        cdp: {
          send: (method, params) => record.gone
            ? Promise.reject(Object.assign(new Error("page closed"), { code: "closed" }))
            : cdp.sendCommand(method, params ?? {}),
          onEvent(listener) {
            record.listeners.cdp.add(listener);
            return () => { record.listeners.cdp.delete(listener); };
          },
        },
        onWindowOpen(listener) { record.listeners.windowOpen.add(listener); return () => { record.listeners.windowOpen.delete(listener); }; },
        onGone(listener) { record.listeners.gone.add(listener); return () => { record.listeners.gone.delete(listener); }; },
        onDownloadBlocked(listener) { record.listeners.download.add(listener); return () => { record.listeners.download.delete(listener); }; },
        setParkedSize(w, h) {
          record.parked = {
            width: Math.min(Math.max(Math.round(w), 1), MAX_SIDE),
            height: Math.min(Math.max(Math.round(h), 1), MAX_SIDE),
          };
          if (!record.host && !record.gone) {
            record.bounds = { x: 0, y: 0, ...record.parked };
            record.view.setBounds(record.bounds);
            fitParking();
          }
        },
        async capture(clip) {
          if (record.gone) throw Object.assign(new Error("page closed"), { code: "closed" });
          // DevTools' screenshot waits for a new frame, which a parked page
          // that does not change never draws; the host's copy does not wait.
          const area = clip && {
            x: Math.max(0, Math.floor(clip.x)),
            y: Math.max(0, Math.floor(clip.y)),
            width: Math.max(1, Math.floor(clip.width)),
            height: Math.max(1, Math.floor(clip.height)),
          };
          const image = await record.contents.capturePage(area, { stayHidden: true });
          if (image.isEmpty()) throw Object.assign(new Error("nothing painted yet"), { code: "not-painted" });
          const width = area?.width ?? record.bounds.width;
          const sized = image.getSize().width > width ? image.resize({ width, quality: "best" }) : image;
          return { data: new Uint8Array(sized.toJPEG(70)), mime: "image/jpeg" };
        },
        shown: () => record.shown,
        onShownChange(listener) { record.listeners.shown.add(listener); return () => { record.listeners.shown.delete(listener); }; },
        close: () => destroy(record, "closed"),
      };
      return page;
    },

    place(window, id, rawRect) {
      if (typeof id !== "string" || id.length > 64) throw invalid();
      const css = parseViewRect(rawRect);
      // The window's page may be zoomed: its CSS px are not the window's.
      const zoom = window.webContents.getZoomFactor() || 1;
      const rect = css && {
        x: Math.round(css.x * zoom),
        y: Math.round(css.y * zoom),
        width: Math.max(1, Math.round(css.width * zoom)),
        height: Math.max(1, Math.round(css.height * zoom)),
      };
      const record = views.get(id);
      if (!record || record.gone) throw Object.assign(new Error("no such page"), { code: "not-found" });
      if (!rect) {
        if (record.host === window) park(record);
        return;
      }
      if (record.host !== window) {
        const from = record.host ?? parkingWindow();
        if (!from.isDestroyed()) from.contentView.removeChildView(record.view);
        window.contentView.addChildView(record.view);
        record.host = window;
        fitParking();
      }
      record.bounds = rect;
      record.view.setBounds(rect);
      setShown(record, true);
    },

    parkFrom(window) {
      for (const record of views.values()) if (record.host === window) park(record);
    },

    viewOf(contents) {
      const record = byContents.get(contents.id);
      return record && !record.gone ? { id: record.id, contents: record.contents, bounds: record.bounds } : null;
    },

    async closeAll() {
      await Promise.all([...views.values()].map((record) => destroy(record, "closed")));
    },
  };
  return host;
}

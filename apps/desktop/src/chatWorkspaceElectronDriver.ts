import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  type IpcMainEvent,
  type Session,
  type WebContents,
} from "electron";
import type {
  ManualHandoffActionEvent,
  ManualHandoffActionId,
  ManualHandoffControlsOptions,
  ManualHandoffExtraction,
  ManualHandoffScope,
  NavigationKind,
  ProfileContext,
  ProfileDriver,
  ProfileDriverOpenOptions,
  ProfileNav,
  ProfilePage,
  ProfilePageEvent,
  ScreencastFrame,
} from "@polyth/browser";
import { MANUAL_ONLY_POLICY, isInternalBrowserUrl } from "@polyth/browser";
import { hideChatWorkspaceView, showChatWorkspaceView } from "./chatWorkspaceSurface.ts";

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const SAFE_PROFILE = /^[A-Za-z0-9._-]{1,200}$/;
const PROVIDER_CONFIG_CHANNEL = "polyth-chat-workspace:configure";
const PROVIDER_ACTION_CHANNEL = "polyth-chat-workspace:provider-action";
const MAX_HANDOFF_CHARS = 120_000;
const providerActionHandlers = new Map<number, (payload: {
  action: ManualHandoffActionId;
  text: string;
  responseId?: string;
}) => void>();
let providerActionIpcInstalled = false;

const installProviderActionIpc = (): void => {
  if (providerActionIpcInstalled) return;
  providerActionIpcInstalled = true;
  ipcMain.on(PROVIDER_ACTION_CHANNEL, (event: IpcMainEvent, raw: unknown) => {
    const handler = providerActionHandlers.get(event.sender.id);
    if (!handler || !raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const value = raw as Record<string, unknown>;
    const action = String(value.action ?? "") as ManualHandoffActionId;
    if (!["add-to-agent", "ask-agent", "new-agent-chat"].includes(action)) return;
    const text = typeof value.text === "string" ? value.text.trim().slice(0, MAX_HANDOFF_CHARS) : "";
    if (!text) return;
    const responseId = typeof value.responseId === "string"
      ? value.responseId.trim().slice(0, 200)
      : undefined;
    handler({ action, text, ...(responseId ? { responseId } : {}) });
  });
};
installProviderActionIpc();

const MODIFIER_NAMES = { Alt: "alt", Control: "control", Meta: "meta", Shift: "shift" } as const;
const modifiers = (
  items: Array<"Alt" | "Control" | "Meta" | "Shift"> | undefined,
): Array<(typeof MODIFIER_NAMES)[keyof typeof MODIFIER_NAMES]> =>
  (items ?? []).map((item) => MODIFIER_NAMES[item]);

const policyUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    return url.href;
  } catch {
    return raw;
  }
};

const navigationKind = (resourceType: string): NavigationKind => {
  if (resourceType === "mainFrame") return "top-level";
  if (resourceType === "subFrame") return "nested";
  return "subresource";
};

const partitionFor = (opts: ProfileDriverOpenOptions): string => {
  const runtimeScope = createHash("sha256").update(opts.userDataDir).digest("hex").slice(0, 24);
  return `persist:polyth-chat-workspace-${runtimeScope}-${opts.profileId}`;
};

export function createChatWorkspaceElectronProfileDriver(): ProfileDriver {
  return {
    engine: "chromium",
    async openProfile(opts) {
      if (!SAFE_PROFILE.test(opts.profileId)) throw err("invalid-input", "unsafe Chat Workspace profile id");
      const ses = session.fromPartition(partitionFor(opts), { cache: true });
      const pages = new Map<string, ElectronProfilePage>();
      const pageByWebContents = new Map<number, ElectronProfilePage>();
      const contextListeners = new Set<(event: { profileId: string; kind: string; message?: string }) => void>();
      let closed = false;

      ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      ses.setPermissionCheckHandler(() => false);
      ses.on("will-download", (_event, item) => item.cancel());

      ses.webRequest.onBeforeRequest((details, callback) => {
        const raw = details.url;
        if (isInternalBrowserUrl(raw) || raw.startsWith("data:") || raw.startsWith("blob:")) {
          callback({ cancel: false });
          return;
        }
        const normalized = policyUrl(raw);
        const page = typeof details.webContentsId === "number"
          ? pageByWebContents.get(details.webContentsId)
          : undefined;
        void opts.guardNavigation(normalized, navigationKind(details.resourceType))
          .then(() => callback({ cancel: false }))
          .catch((failure: Error & { code?: string }) => {
            if (navigationKind(details.resourceType) === "top-level") page?.emitApprovalRequired(normalized, failure.message);
            callback({ cancel: true });
          });
      });

      const context: ProfileContext = {
        profileId: opts.profileId,
        userDataDir: opts.userDataDir,
        async newPage(tabId) {
          if (closed) throw err("unavailable", "Chat Workspace profile is closed");
          if (pages.has(tabId)) throw err("conflict", `tab ${tabId} already exists`);
          const page = new ElectronProfilePage({
            tabId,
            session: ses,
            profileOptions: opts,
            onWebContents(contents) { pageByWebContents.set(contents.id, page); },
            onWebContentsGone(contents) { pageByWebContents.delete(contents.id); },
            onClose() { pages.delete(tabId); },
          });
          pages.set(tabId, page);
          return page;
        },
        pages: () => [...pages.values()],
        onEvent(cb) {
          contextListeners.add(cb);
          return () => { contextListeners.delete(cb); };
        },
        async close() {
          if (closed) return;
          closed = true;
          await Promise.all([...pages.values()].map((page) => page.close()));
          pages.clear();
          pageByWebContents.clear();
          contextListeners.clear();
        },
      };
      return context;
    },
  };
}

interface ElectronProfilePageInput {
  tabId: string;
  session: Session;
  profileOptions: ProfileDriverOpenOptions;
  onWebContents(contents: WebContents): void;
  onWebContentsGone(contents: WebContents): void;
  onClose(): void;
}

class ElectronProfilePage implements ProfilePage {
  readonly tabId: string;
  readonly contentAccess = MANUAL_ONLY_POLICY;
  onPopupFrame?: (popupId: string, frame: ScreencastFrame) => void;

  private view: WebContentsView | null = null;
  private nav: ProfileNav = { url: "about:blank", title: "", loading: false };
  private closed = false;
  private hibernated = false;
  private visible = false;
  private controls: ManualHandoffControlsOptions | null = null;
  private controlsAction: ((event: ManualHandoffActionEvent) => void) | null = null;
  private readonly eventListeners = new Set<(event: ProfilePageEvent) => void>();
  private readonly frameListeners = new Set<(frame: ScreencastFrame) => void>();
  private readonly popups = new Map<string, BrowserWindow>();
  private readonly input: ElectronProfilePageInput;

  constructor(input: ElectronProfilePageInput) {
    this.input = input;
    this.tabId = input.tabId;
    this.createView();
  }

  emitApprovalRequired(url: string, reason: string): void {
    let origin: string | undefined;
    try { origin = new URL(url).origin; } catch {}
    this.emit({ kind: "approval-required", url, origin, reason, message: reason });
  }

  private emit(event: ProfilePageEvent): void {
    for (const cb of [...this.eventListeners]) cb(event);
  }

  private registerProviderActions(contents: WebContents): void {
    providerActionHandlers.delete(contents.id);
    if (!this.controls || !this.controlsAction) return;
    providerActionHandlers.set(contents.id, (payload) => {
      if (contents.isDestroyed() || this.closed || this.hibernated || !this.controlsAction) return;
      this.syncNav();
      this.controlsAction({
        action: payload.action,
        text: payload.text,
        scope: "response",
        url: this.nav.url,
        title: this.nav.title,
        ...(payload.responseId ? { responseId: payload.responseId } : {}),
      });
    });
    contents.send(PROVIDER_CONFIG_CHANNEL, {
      assistantMessageSelectors: [...this.controls.assistantMessageSelectors],
      streamingSelectors: [...(this.controls.streamingSelectors ?? [])],
      actions: this.controls.actions.map((action) => ({ id: action.id, label: action.label })),
    });
  }

  private createView(): WebContentsView {
    if (this.closed) throw err("unavailable", "Chat Workspace tab is closed");
    const view = new WebContentsView({
      webPreferences: {
        session: this.input.session,
        preload: join(import.meta.dirname, "chatWorkspaceProviderPreload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: true,
        backgroundThrottling: true,
      },
    });
    this.view = view;
    const contents = view.webContents;
    this.input.onWebContents(contents);

    contents.setWindowOpenHandler(() => ({
      action: "allow",
      overrideBrowserWindowOptions: {
        show: true,
        webPreferences: {
          session: this.input.session,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      },
    }));
    contents.on("did-create-window", (popup, details) => {
      const popupId = `popup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.popups.set(popupId, popup);
      this.input.onWebContents(popup.webContents);
      this.emit({ kind: "popup-opened", popupId, url: details.url });
      popup.once("closed", () => {
        this.input.onWebContentsGone(popup.webContents);
        this.popups.delete(popupId);
        this.emit({ kind: "popup-closed", popupId });
      });
    });
    contents.on("did-start-loading", () => {
      this.nav.loading = true;
      this.emit({ kind: "loading" });
    });
    contents.on("did-finish-load", () => this.registerProviderActions(contents));
    contents.on("did-stop-loading", () => {
      this.syncNav();
      this.nav.loading = false;
      this.emit({ kind: "loading" });
      this.emit({ kind: "navigation", url: this.nav.url });
    });
    contents.on("did-navigate", (_event, url) => {
      this.nav.url = url;
      this.nav.title = contents.getTitle();
      this.emit({ kind: "navigation", url });
    });
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.nav.url = url;
      this.nav.title = contents.getTitle();
      this.emit({ kind: "navigation", url });
    });
    contents.on("page-title-updated", (_event, title) => { this.nav.title = title; });
    contents.on("render-process-gone", (_event, details) => this.emit({ kind: "crash", message: `renderer ${details.reason}` }));
    contents.once("destroyed", () => {
      providerActionHandlers.delete(contents.id);
      this.input.onWebContentsGone(contents);
      if (this.view === view) this.view = null;
    });

    if (this.visible) {
      showChatWorkspaceView(view);
      contents.focus();
    }
    return view;
  }

  private contents(): WebContents {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) throw err("unavailable", "Chat Workspace tab is not active");
    return contents;
  }

  private syncNav(): void {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    this.nav.url = contents.getURL() || this.nav.url;
    this.nav.title = contents.getTitle() || this.nav.title;
    this.nav.loading = contents.isLoading();
  }

  async goto(url: string): Promise<ProfileNav> {
    if (this.closed || this.hibernated) throw err("unavailable", "Chat Workspace tab is not active");
    if (!isInternalBrowserUrl(url)) await this.input.profileOptions.guardNavigation(url, "top-level");
    await this.contents().loadURL(url);
    this.syncNav();
    return this.current();
  }

  async back(): Promise<ProfileNav> {
    const history = this.contents().navigationHistory;
    if (history.canGoBack()) history.goBack();
    return this.current();
  }

  async forward(): Promise<ProfileNav> {
    const history = this.contents().navigationHistory;
    if (history.canGoForward()) history.goForward();
    return this.current();
  }

  async reload(): Promise<ProfileNav> {
    this.contents().reload();
    return this.current();
  }

  async stop(): Promise<void> {
    this.contents().stop();
    this.nav.loading = false;
  }

  current(): ProfileNav {
    this.syncNav();
    return { ...this.nav };
  }

  async mouse(input: {
    kind: "move" | "down" | "up" | "click" | "dblclick";
    x: number;
    y: number;
    button?: "left" | "middle" | "right";
    modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
  }): Promise<void> {
    const contents = this.contents();
    const button = input.button ?? "left";
    const base = { x: Math.round(input.x), y: Math.round(input.y), button, modifiers: modifiers(input.modifiers) };
    if (input.kind === "move") contents.sendInputEvent({ type: "mouseMove", ...base });
    else if (input.kind === "down") contents.sendInputEvent({ type: "mouseDown", ...base, clickCount: 1 });
    else if (input.kind === "up") contents.sendInputEvent({ type: "mouseUp", ...base, clickCount: 1 });
    else if (input.kind === "dblclick") {
      contents.sendInputEvent({ type: "mouseDown", ...base, clickCount: 2 });
      contents.sendInputEvent({ type: "mouseUp", ...base, clickCount: 2 });
    } else {
      contents.sendInputEvent({ type: "mouseDown", ...base, clickCount: 1 });
      contents.sendInputEvent({ type: "mouseUp", ...base, clickCount: 1 });
    }
  }

  async wheel(dx: number, dy: number, x: number, y: number): Promise<void> {
    this.contents().sendInputEvent({ type: "mouseWheel", x: Math.round(x), y: Math.round(y), deltaX: dx, deltaY: dy });
  }

  async key(input: {
    kind: "down" | "up" | "press";
    key: string;
    modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
  }): Promise<void> {
    const contents = this.contents();
    const mods = modifiers(input.modifiers);
    if (input.kind === "down") contents.sendInputEvent({ type: "keyDown", keyCode: input.key, modifiers: mods });
    else if (input.kind === "up") contents.sendInputEvent({ type: "keyUp", keyCode: input.key, modifiers: mods });
    else {
      contents.sendInputEvent({ type: "keyDown", keyCode: input.key, modifiers: mods });
      if (input.key.length === 1) contents.sendInputEvent({ type: "char", keyCode: input.key, modifiers: mods });
      contents.sendInputEvent({ type: "keyUp", keyCode: input.key, modifiers: mods });
    }
  }

  async insertText(text: string): Promise<void> {
    this.contents().insertText(text);
  }

  async resize(): Promise<void> {
    // The renderer-owned embedded surface supplies the actual native bounds.
  }

  async copySelection(): Promise<string> {
    return this.contents().executeJavaScript("window.getSelection()?.toString() ?? ''", true) as Promise<string>;
  }

  async extractManualHandoff(input: {
    scope: ManualHandoffScope;
    assistantMessageSelectors: readonly string[];
    responseId?: string;
  }): Promise<ManualHandoffExtraction> {
    const result = await this.contents().executeJavaScript(`(() => {
      const selectors = ${JSON.stringify(input.assistantMessageSelectors)};
      const responseId = ${JSON.stringify(input.responseId ?? null)};
      const selected = window.getSelection()?.toString()?.trim() ?? "";
      if (${JSON.stringify(input.scope)} === "selection") return selected;
      const elements = [];
      const seen = new Set();
      for (const selector of selectors) {
        try {
          for (const element of document.querySelectorAll(selector)) {
            if (seen.has(element)) continue;
            seen.add(element);
            elements.push(element);
          }
        } catch {}
      }
      let target = responseId
        ? elements.find((element) => element.getAttribute("data-polyth-chat-response") === responseId)
        : elements.at(-1);
      if (!target) return "";
      const clone = target.cloneNode(true);
      clone.querySelectorAll?.("[data-polyth-chat-actions]").forEach((node) => node.remove());
      return (clone.innerText || clone.textContent || "").trim();
    })()`, true) as string;
    const text = String(result ?? "").trim().slice(0, MAX_HANDOFF_CHARS);
    if (!text) throw err("empty-selection", "no external chat content is available for handoff");
    this.syncNav();
    return {
      text,
      scope: input.scope,
      url: this.nav.url,
      title: this.nav.title,
      ...(input.responseId ? { responseId: input.responseId } : {}),
    };
  }

  async installManualHandoffControls(
    options: ManualHandoffControlsOptions,
    onAction: (event: ManualHandoffActionEvent) => void,
  ): Promise<void> {
    this.controls = {
      assistantMessageSelectors: [...options.assistantMessageSelectors],
      ...(options.streamingSelectors ? { streamingSelectors: [...options.streamingSelectors] } : {}),
      actions: options.actions.map((action) => ({ id: action.id, label: action.label })),
    };
    this.controlsAction = onAction;
    this.registerProviderActions(this.contents());
  }

  async startScreencast(): Promise<void> {}
  async stopScreencast(): Promise<void> {}

  onFrame(cb: (frame: ScreencastFrame) => void): () => void {
    this.frameListeners.add(cb);
    return () => { this.frameListeners.delete(cb); };
  }

  onEvent(cb: (event: ProfilePageEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => { this.eventListeners.delete(cb); };
  }

  async hibernate(): Promise<{ url: string; title: string }> {
    this.syncNav();
    const snapshot = { url: this.nav.url, title: this.nav.title };
    this.hibernated = true;
    this.closePresentation(false);
    return snapshot;
  }

  async restore(url: string): Promise<ProfileNav> {
    if (this.closed) throw err("unavailable", "Chat Workspace tab is closed");
    this.hibernated = false;
    if (!this.view) this.createView();
    const nav = await this.goto(url);
    if (this.visible && this.view) {
      showChatWorkspaceView(this.view);
      this.view.webContents.focus();
    }
    return nav;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controls = null;
    this.controlsAction = null;
    this.closePresentation(true);
    this.eventListeners.clear();
    this.frameListeners.clear();
    this.input.onClose();
  }

  touchActivity(): void {}

  setStreamVisible(visible: boolean): void {
    this.visible = visible;
    const view = this.view;
    if (!view || view.webContents.isDestroyed()) return;
    if (visible) {
      showChatWorkspaceView(view);
      view.webContents.focus();
    } else {
      hideChatWorkspaceView(view);
    }
  }

  async popupInput(popupId: string, input: Record<string, unknown>): Promise<void> {
    const popup = this.popups.get(popupId);
    if (!popup || popup.isDestroyed()) throw err("not-found", `popup ${popupId} not found`);
    if (input.inputType === "key") {
      popup.webContents.sendInputEvent({ type: String(input.kind) === "up" ? "keyUp" : "keyDown", keyCode: String(input.key ?? "") });
    }
  }

  async closePopup(popupId: string): Promise<void> {
    const popup = this.popups.get(popupId);
    if (!popup) return;
    this.popups.delete(popupId);
    if (!popup.isDestroyed()) popup.close();
  }

  private closePresentation(final: boolean): void {
    for (const popup of this.popups.values()) {
      if (!popup.isDestroyed()) {
        this.input.onWebContentsGone(popup.webContents);
        popup.destroy();
      }
    }
    this.popups.clear();
    const view = this.view;
    this.view = null;
    if (view) {
      hideChatWorkspaceView(view);
      const contents = view.webContents;
      providerActionHandlers.delete(contents.id);
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    }
    if (final) this.visible = false;
  }
}

// In-memory profile driver for tests and POLYTH_FAKE_BROWSER=1.
import type { BrowserColorScheme } from "@polyth/contracts";
import type {
  ProfileContext,
  ProfileDriver,
  ProfileDriverOpenOptions,
  ProfileNav,
  ProfilePage,
  ProfilePageEvent,
  ScreencastFrame,
} from "./profileDriver.ts";
import { MANUAL_ONLY_POLICY } from "./profileDriver.ts";
import { isInternalBrowserUrl } from "./policy.ts";
import {
  createScreencastPacing,
  markScreencastFrameEmitted,
  noteScreencastActivity,
  setScreencastVisible,
  shouldEmitScreencastFrame,
} from "./screencastPacing.ts";

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

const activeDirs = new Set<string>();

export function createFakeProfileDriver(): ProfileDriver {
  return {
    engine: "fake",
    async openProfile(opts: ProfileDriverOpenOptions): Promise<ProfileContext> {
      if (activeDirs.has(opts.userDataDir)) {
        throw err("profile-locked", `profile data directory is already in use: ${opts.profileId}`);
      }
      activeDirs.add(opts.userDataDir);
      const pages = new Map<string, FakeProfilePage>();
      const ctxListeners = new Set<(ev: { profileId: string; kind: string; message?: string }) => void>();
      const emitCtx = (kind: string, message?: string) => {
        for (const cb of [...ctxListeners]) cb({ profileId: opts.profileId, kind, message });
      };

      const context: ProfileContext = {
        profileId: opts.profileId,
        userDataDir: opts.userDataDir,
        async newPage(tabId) {
          if (pages.has(tabId)) throw err("conflict", `tab ${tabId} already exists`);
          const page = new FakeProfilePage(tabId, opts, emitCtx, () => { pages.delete(tabId); });
          pages.set(tabId, page);
          return page;
        },
        pages() {
          return [...pages.values()];
        },
        onEvent(cb) {
          ctxListeners.add(cb);
          return () => { ctxListeners.delete(cb); };
        },
        async close() {
          for (const page of pages.values()) await page.close();
          pages.clear();
          activeDirs.delete(opts.userDataDir);
        },
      };
      return context;
    },
  };
}

class FakeProfilePage implements ProfilePage {
  readonly tabId: string;
  readonly contentAccess = MANUAL_ONLY_POLICY;
  private url = "about:blank";
  private title = "";
  private loading = false;
  private selection = "";
  private closed = false;
  private hibernated = false;
  private viewport = { width: 1280, height: 800 };
  private pacing = createScreencastPacing();
  private screencastOn = false;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private frameCbs = new Set<(frame: ScreencastFrame) => void>();
  private eventCbs = new Set<(ev: ProfilePageEvent) => void>();
  private popups = new Map<string, {
    url: string;
    timer: ReturnType<typeof setInterval> | null;
    pacing: ReturnType<typeof createScreencastPacing>;
  }>();
  onPopupFrame?: (popupId: string, frame: ScreencastFrame) => void;
  private pendingChooser: { resolve: (files: Array<{ name: string; mimeType: string; buffer: Buffer }>) => void } | null = null;
  private opts: ProfileDriverOpenOptions;
  private emitCtx: (kind: string, message?: string) => void;
  private onClose: () => void;

  constructor(
    tabId: string,
    opts: ProfileDriverOpenOptions,
    emitCtx: (kind: string, message?: string) => void,
    onClose: () => void,
  ) {
    this.tabId = tabId;
    this.opts = opts;
    this.emitCtx = emitCtx;
    this.onClose = onClose;
  }

  private emit(ev: ProfilePageEvent): void {
    for (const cb of [...this.eventCbs]) cb(ev);
  }

  touchActivity(): void {
    noteScreencastActivity(this.pacing);
  }

  setStreamVisible(visible: boolean): void {
    setScreencastVisible(this.pacing, visible);
    for (const popup of this.popups.values()) setScreencastVisible(popup.pacing, visible);
    if (!visible) this.stopFrameLoop();
    else if (this.screencastOn) this.startFrameLoop();
  }

  private startFrameLoop(): void {
    if (this.frameTimer) return;
    this.frameTimer = setInterval(() => {
      if (!shouldEmitScreencastFrame(this.pacing)) return;
      markScreencastFrameEmitted(this.pacing);
      const frame: ScreencastFrame = {
        data: new TextEncoder().encode(`fake:${this.tabId}:${this.url}:${Date.now()}`),
        mime: "image/jpeg",
        width: this.viewport.width,
        height: this.viewport.height,
      };
      for (const cb of [...this.frameCbs]) cb(frame);
    }, 50);
    this.frameTimer.unref?.();
  }

  private stopFrameLoop(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
  }

  private nav(): ProfileNav {
    return { url: this.url, title: this.title, loading: this.loading };
  }

  private async guard(url: string): Promise<void> {
    try {
      await this.opts.guardNavigation(url);
    } catch (e) {
      const failure = e as Error & { code?: string };
      if (failure.code === "approval-required") {
        let origin: string | undefined;
        try { origin = new URL(url).origin; } catch { /* invalid */ }
        this.emit({ kind: "approval-required", url, origin, reason: failure.message });
      }
      throw e;
    }
  }

  async goto(url: string): Promise<ProfileNav> {
    if (this.closed || this.hibernated) throw err("unavailable", "page not active");
    this.loading = true;
    if (!isInternalBrowserUrl(url)) {
      await this.guard(url);
    }
    this.url = url;
    this.title = new URL(url).hostname || "Page";
    this.loading = false;
    this.emit({ kind: "navigation", url });
    if (url.includes("polyth-test-popup")) {
      this.openTestPopup("test-popup", url);
    }
    this.touchActivity();
    return this.nav();
  }

  private openTestPopup(popupId: string, url: string): void {
    if (this.popups.has(popupId)) return;
    const pacing = createScreencastPacing();
    setScreencastVisible(pacing, this.pacing.visible);
    const timer = setInterval(() => {
      const popup = this.popups.get(popupId);
      if (!this.onPopupFrame || !popup || !shouldEmitScreencastFrame(popup.pacing)) return;
      markScreencastFrameEmitted(popup.pacing);
      this.onPopupFrame(popupId, {
        data: new TextEncoder().encode(`fake-popup:${popupId}:${Date.now()}`),
        mime: "image/jpeg",
        width: this.viewport.width,
        height: this.viewport.height,
      });
    }, 50);
    timer.unref?.();
    this.popups.set(popupId, { url, timer, pacing });
    this.emit({ kind: "popup-opened", popupId, url });
  }

  async popupInput(popupId: string, input: Record<string, unknown>): Promise<void> {
    const popup = this.popups.get(popupId);
    if (!popup) throw err("not-found", `popup ${popupId} not found`);
    this.touchActivity();
    noteScreencastActivity(popup.pacing);
    if (input.inputType === "key" && input.kind === "press" && input.key === "Escape") {
      await this.closePopup(popupId);
    }
  }

  async closePopup(popupId: string): Promise<void> {
    const popup = this.popups.get(popupId);
    if (!popup) return;
    if (popup.timer) clearInterval(popup.timer);
    this.popups.delete(popupId);
    this.emit({ kind: "popup-closed", popupId });
  }

  async back(): Promise<ProfileNav> {
    this.touchActivity();
    return this.nav();
  }

  async forward(): Promise<ProfileNav> {
    this.touchActivity();
    return this.nav();
  }

  async reload(): Promise<ProfileNav> {
    this.touchActivity();
    this.emit({ kind: "navigation", url: this.url });
    return this.nav();
  }

  async stop(): Promise<void> {
    this.loading = false;
  }

  current(): ProfileNav {
    return this.nav();
  }

  async mouse(): Promise<void> {
    this.touchActivity();
  }

  async wheel(): Promise<void> {
    this.touchActivity();
  }

  async key(input: { kind: string; key: string }): Promise<void> {
    this.touchActivity();
    if (input.kind === "press" && input.key.length === 1) {
      this.selection += input.key;
    }
  }

  async insertText(text: string): Promise<void> {
    this.selection += text;
    this.touchActivity();
  }

  async resize(viewport: { width: number; height: number }): Promise<void> {
    this.viewport = { ...viewport };
    this.touchActivity();
  }

  async copySelection(): Promise<string> {
    return this.selection;
  }

  async startScreencast(): Promise<void> {
    if (this.screencastOn) {
      await this.stopScreencast();
    }
    this.screencastOn = true;
    if (this.pacing.visible) this.startFrameLoop();
  }

  async stopScreencast(): Promise<void> {
    this.screencastOn = false;
    this.stopFrameLoop();
  }

  onFrame(cb: (frame: ScreencastFrame) => void): () => void {
    this.frameCbs.add(cb);
    return () => { this.frameCbs.delete(cb); };
  }

  onEvent(cb: (ev: ProfilePageEvent) => void): () => void {
    this.eventCbs.add(cb);
    return () => { this.eventCbs.delete(cb); };
  }

  async hibernate(): Promise<{ url: string; title: string }> {
    this.hibernated = true;
    for (const popupId of [...this.popups.keys()]) await this.closePopup(popupId);
    await this.stopScreencast();
    return { url: this.url, title: this.title };
  }

  async restore(url: string): Promise<ProfileNav> {
    this.hibernated = false;
    return this.goto(url);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const popupId of [...this.popups.keys()]) await this.closePopup(popupId);
    await this.stopScreencast();
    this.frameCbs.clear();
    this.eventCbs.clear();
    this.onClose();
  }

  /** Test helper: simulate file chooser */
  simulateFileChooser(): void {
    this.pendingChooser = {
      resolve: () => {},
    };
    this.emit({ kind: "file-chooser-opened" });
  }

  async setFiles(files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void> {
    if (!this.pendingChooser) throw err("invalid-input", "no pending file chooser");
    this.pendingChooser.resolve(files);
    this.pendingChooser = null;
  }
}

/** Release fake profile locks between tests. */
export function resetFakeProfileLocks(): void {
  activeDirs.clear();
}

// Persistent-profile Chromium driver for chat-workspace (manual-only pages).
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { findChromiumExecutable } from "./chromium.ts";
import type {
  NavigationKind,
  ProfileContext,
  ProfileDriver,
  ProfileDriverOpenOptions,
  ProfileNav,
  ProfilePage,
  ProfilePageEvent,
  ScreencastFrame,
} from "./profileDriver.ts";
import { MANUAL_ONLY_POLICY } from "./profileDriver.ts";
import { isInternalBrowserUrl, originAliases } from "./policy.ts";
import {
  createScreencastPacing,
  markScreencastFrameEmitted,
  noteScreencastActivity,
  setScreencastVisible,
  shouldEmitScreencastFrame,
} from "./screencastPacing.ts";

const err = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/** Map a page WebSocket URL onto the HTTP(S) policy surface (same host/port
 *  /path). Direct `ws:`/`wss:` navigation stays a blocked scheme. */
export function webSocketUrlAsHttp(raw: string): string {
  const url = new URL(raw);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else throw err("blocked-scheme", `scheme ${url.protocol} is not a websocket`);
  return url.href;
}

type PlaywrightPage = import("playwright-core").Page;
type PlaywrightRequest = import("playwright-core").Request;

/** True for main-frame / popup document navigation. Nested iframes are false.
 *  A missing/unattached frame is treated conservatively as top-level so a
 *  popup's first request cannot slip through before Playwright binds it. */
export function isTopLevelNavigationRequest(req: {
  isNavigationRequest(): boolean;
  frame(): { parentFrame(): unknown | null } | null;
}): boolean {
  if (!req.isNavigationRequest()) return false;
  let frame: { parentFrame(): unknown | null } | null = null;
  try {
    frame = req.frame();
  } catch {
    return true;
  }
  if (!frame) return true;
  try {
    return frame.parentFrame() === null;
  } catch {
    return true;
  }
}

export type TopLevelRequestClass = "resident" | "known-popup" | "initial-popup";

export interface TopLevelOwnerLookup {
  isResident(page: unknown): boolean;
  isOwnedTab(page: unknown): boolean;
  isKnownPopup(page: unknown): boolean;
}

/** Classify THIS request's page. An unrelated popup elsewhere in the context
 *  must not change a resident tab's class. A missing/unattached frame is
 *  treated as an initial popup document so the first popup hop stays guarded. */
export function classifyTopLevelRequest(
  req: {
    isNavigationRequest(): boolean;
    frame(): { parentFrame(): unknown | null; page?: () => unknown } | null;
  },
  lookup: TopLevelOwnerLookup,
): TopLevelRequestClass {
  if (!isTopLevelNavigationRequest(req)) return "resident";
  let page: unknown;
  try {
    const frame = req.frame();
    if (!frame) return "initial-popup";
    page = typeof frame.page === "function" ? frame.page() : undefined;
  } catch {
    return "initial-popup";
  }
  if (page == null) return "initial-popup";
  if (lookup.isOwnedTab(page) || lookup.isResident(page)) return "resident";
  if (lookup.isKnownPopup(page)) return "known-popup";
  return "initial-popup";
}

const openDirs = new Map<string, Promise<unknown>>();

export async function createProfileChromiumDriver(
  executablePath?: string,
): Promise<ProfileDriver | null> {
  const bin = executablePath ?? await findChromiumExecutable();
  if (!bin) return null;
  return {
    engine: "chromium",
    async openProfile(opts) {
      const key = opts.userDataDir;
      if (openDirs.has(key)) {
        throw err("profile-locked", `profile data directory is already in use: ${opts.profileId}`);
      }
      const { chromium } = await import("playwright-core");
      let context: import("playwright-core").BrowserContext;
      try {
        const launch = chromium.launchPersistentContext(opts.userDataDir, {
          executablePath: bin,
          headless: true,
          viewport: {
            width: opts.viewport.width,
            height: opts.viewport.height,
          },
          deviceScaleFactor: opts.viewport.deviceScaleFactor ?? 1,
          colorScheme: opts.colorScheme,
          acceptDownloads: false,
          javaScriptEnabled: true,
          // Chat Workspace V1: Service Workers are not reliably interceptable
          // by BrowserContext.route, so they must not become a policy bypass.
          serviceWorkers: "block",
          ...(opts.chromiumArgs && opts.chromiumArgs.length > 0 ? { args: opts.chromiumArgs } : {}),
        });
        openDirs.set(key, launch);
        context = await launch;
      } catch (e) {
        openDirs.delete(key);
        const msg = String((e as Error).message ?? e);
        if (/already in use|profile.*lock|singleton/i.test(msg)) {
          throw err("profile-locked", `profile data directory is already in use: ${opts.profileId}`);
        }
        throw e;
      }

      const ctxListeners = new Set<(ev: { profileId: string; kind: string; message?: string }) => void>();
      const pages = new Map<string, ChromiumProfilePage>();
      const popups = new Map<string, { page: PlaywrightPage; parentTabId: string }>();
      const pageOwners = new Map<PlaywrightPage, ChromiumProfilePage>();
      const popupOpeners = new Map<PlaywrightPage, ChromiumProfilePage>();
      type PendingApproval = {
        url: string;
        reason: string;
        at: number;
        page?: PlaywrightPage;
        opener?: PlaywrightPage;
      };
      const pendingApprovals = new Map<string, PendingApproval>();
      const PENDING_APPROVAL_TTL_MS = 5_000;
      const PENDING_APPROVAL_LIMIT = 8;
      let pendingApprovalSeq = 0;

      const prunePendingApprovals = (): void => {
        const now = Date.now();
        for (const [id, item] of pendingApprovals) {
          if (now - item.at > PENDING_APPROVAL_TTL_MS) pendingApprovals.delete(id);
        }
      };

      const rememberPendingApproval = (item: PendingApproval): void => {
        prunePendingApprovals();
        while (pendingApprovals.size >= PENDING_APPROVAL_LIMIT) {
          const oldest = pendingApprovals.keys().next().value;
          if (oldest === undefined) break;
          pendingApprovals.delete(oldest);
        }
        pendingApprovals.set(`p${++pendingApprovalSeq}`, item);
      };

      const flushPendingApproval = (owner: ChromiumProfilePage): void => {
        prunePendingApprovals();
        for (const [id, item] of pendingApprovals) {
          const pageMatch = item.page
            ? pageOwners.get(item.page) === owner || popupOpeners.get(item.page) === owner
            : false;
          const openerMatch = item.opener ? pageOwners.get(item.opener) === owner : false;
          if (!pageMatch && !openerMatch) continue;
          owner.emitApprovalRequired(item.url, item.reason);
          pendingApprovals.delete(id);
        }
      };

      // Must stay synchronous: awaiting Page.opener() (or any API that waits
      // on the current navigation) inside a route handler deadlocks Playwright.
      const ownerForRequestSync = (req: PlaywrightRequest): ChromiumProfilePage | undefined => {
        let pwPage: PlaywrightPage | undefined;
        try {
          pwPage = req.frame()?.page();
        } catch {
          pwPage = undefined;
        }
        if (pwPage) {
          const direct = pageOwners.get(pwPage);
          if (direct) return direct;
          const mapped = popupOpeners.get(pwPage);
          if (mapped) return mapped;
        }
        return undefined;
      };

      const requestPage = (req: PlaywrightRequest): PlaywrightPage | undefined => {
        try {
          return req.frame()?.page();
        } catch {
          return undefined;
        }
      };

      const residentPages = new WeakSet<PlaywrightPage>(context.pages());
      const topLevelLookup: TopLevelOwnerLookup = {
        isResident: (page) => residentPages.has(page as PlaywrightPage),
        isOwnedTab: (page) => pageOwners.has(page as PlaywrightPage),
        isKnownPopup: (page) => popupOpeners.has(page as PlaywrightPage),
      };

      let lastInputPage: ChromiumProfilePage | undefined;

      const emitApproval = (req: PlaywrightRequest, url: string, reason: string): void => {
        const owner = ownerForRequestSync(req) ?? lastInputPage;
        if (owner) {
          owner.emitApprovalRequired(url, reason);
          return;
        }
        let page = requestPage(req);
        if (!page) {
          const unmatched = context.pages().filter((p) => !pageOwners.has(p));
          if (unmatched.length === 1) page = unmatched[0];
        }
        if (page) {
          const mapped = popupOpeners.get(page);
          if (mapped) {
            mapped.emitApprovalRequired(url, reason);
            return;
          }
        }
        rememberPendingApproval({ url, reason, at: Date.now(), page });
        for (const mapped of new Set([...popupOpeners.values(), ...pageOwners.values()])) {
          flushPendingApproval(mapped);
        }
      };

      context.on("page", (page) => {
        page.on("close", () => {
          popupOpeners.delete(page);
          for (const [id, item] of pendingApprovals) {
            if (item.page === page) pendingApprovals.delete(id);
          }
        });
      });

      type PlaywrightRoute = import("playwright-core").Route;
      const BLOCKED_DOCUMENT = "<!DOCTYPE html><html><body></body></html>";
      const fulfillBlockedDocument = async (route: PlaywrightRoute): Promise<void> => {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: BLOCKED_DOCUMENT,
        }).catch(() => {});
      };

      const emitApprovalForPage = (page: PlaywrightPage | undefined, url: string, reason: string): void => {
        if (page) {
          const owner = pageOwners.get(page) ?? popupOpeners.get(page) ?? lastInputPage;
          if (owner) {
            owner.emitApprovalRequired(url, reason);
            return;
          }
        }
        if (lastInputPage) {
          lastInputPage.emitApprovalRequired(url, reason);
          return;
        }
        rememberPendingApproval({ url, reason, at: Date.now(), page });
      };

      const redirectTarget = (from: string, location: string | undefined): string | undefined => {
        if (!location) return undefined;
        try {
          return new URL(location, from).href;
        } catch {
          return undefined;
        }
      };

      // Playwright 1.62 auto-continues redirect hops after route.continue(), so
      // a Request-stage route handler never sees hop 2. CDP Fetch at Response
      // stage sees the 3xx Location and failRequest's it before Chromium contacts
      // that hop. Allowed bodies still stream through Chromium after continueRequest.
      const cdpInstalled = new WeakMap<PlaywrightPage, Promise<void>>();
      const installCdpHopGuard = (page: PlaywrightPage): Promise<void> => {
        const existing = cdpInstalled.get(page);
        if (existing) return existing;
        const installed = (async () => {
          let cdp: import("playwright-core").CDPSession;
          try {
            cdp = await context.newCDPSession(page);
          } catch {
            return;
          }
          let mainFrameId: string | undefined;
          const finish = (requestId: string, blocked: boolean): void => {
            if (blocked) {
              void cdp.send("Fetch.failRequest", {
                requestId,
                errorReason: "BlockedByClient",
              }).catch(() => {});
              return;
            }
            void cdp.send("Fetch.continueRequest", { requestId }).catch(() => {});
          };
          const onPaused = async (ev: {
            requestId: string;
            request: { url: string };
            resourceType?: string;
            frameId?: string;
            responseStatusCode?: number;
            responseHeaders?: Array<{ name: string; value: string }>;
          }): Promise<void> => {
            const status = ev.responseStatusCode;
            if (!(status && status >= 300 && status < 400)) {
              finish(ev.requestId, false);
              return;
            }
            const location = ev.responseHeaders?.find((h) => h.name.toLowerCase() === "location")?.value;
            const next = redirectTarget(ev.request.url, location);
            if (!next) {
              finish(ev.requestId, false);
              return;
            }
            if (!(next.startsWith("http://") || next.startsWith("https://"))) {
              if (!isInternalBrowserUrl(next)) {
                finish(ev.requestId, true);
                return;
              }
              finish(ev.requestId, false);
              return;
            }
            const resourceType = ev.resourceType ?? "";
            const kind: NavigationKind = resourceType !== "Document"
              ? "subresource"
              : (ev.frameId && mainFrameId && ev.frameId !== mainFrameId ? "nested" : "top-level");
            try {
              await opts.guardNavigation(next, kind);
              finish(ev.requestId, false);
            } catch (e) {
              const failure = e as Error & { code?: string };
              if (kind === "top-level" && failure.code === "approval-required") {
                emitApprovalForPage(page, next, failure.message);
              }
              finish(ev.requestId, true);
            }
          };
          cdp.on("Fetch.requestPaused", (ev) => { void onPaused(ev); });
          try {
            await cdp.send("Page.enable");
            const tree = await cdp.send("Page.getFrameTree") as {
              frameTree: { frame: { id: string } };
            };
            mainFrameId = tree.frameTree.frame.id;
          } catch { /* page may already be gone */ }
          cdp.on("Page.frameNavigated", (ev: { frame: { id: string; parentId?: string } }) => {
            if (!ev.frame.parentId) mainFrameId = ev.frame.id;
          });
          try {
            await cdp.send("Fetch.enable", {
              patterns: [{ urlPattern: "*", requestStage: "Response" }],
            });
          } catch {
            return;
          }
          page.on("close", () => { void cdp.detach().catch(() => {}); });
        })();
        cdpInstalled.set(page, installed);
        return installed;
      };

      // Context-level routing intercepts a popup's first request before it
      // contacts the network. Nested documents and subresources are continued
      // in Chromium so cookies, auth, redirects where applicable, streaming,
      // SSE, and same-origin WebSockets stay Chromium-owned. Playwright
      // auto-continues redirect hops after continue(); tab pages policy-check
      // those Locations via CDP Fetch at Response stage. HTTP cache is
      // disabled while context routing is enabled (V1 limitation).
      //
      // Resident tab (and already-wired popup) top-level documents
      // continue() in Chromium. Only THIS request's initial unattached popup
      // document uses route.fetch({ maxRedirects: 0 }): a new popup page
      // cannot take a Response-stage Fetch session without deadlocking. An
      // unrelated popup elsewhere must not change a resident tab's path.
      const handleRoute = async (route: PlaywrightRoute): Promise<void> => {
        const req = route.request();
        const url = req.url();
        if (!(url.startsWith("http://") || url.startsWith("https://"))) {
          if (isTopLevelNavigationRequest(req) && !isInternalBrowserUrl(url)) {
            await route.abort("blockedbyclient").catch(() => {});
            return;
          }
          await route.continue().catch(() => {});
          return;
        }
        const nav = req.isNavigationRequest();
        const topLevel = nav && isTopLevelNavigationRequest(req);
        const kind: NavigationKind = !nav ? "subresource" : topLevel ? "top-level" : "nested";
        try {
          await opts.guardNavigation(url, kind);
        } catch (e) {
          const failure = e as Error & { code?: string };
          if (kind === "top-level") {
            if (failure.code === "approval-required") emitApproval(req, url, failure.message);
            await route.abort("blockedbyclient").catch(() => {});
          } else if (kind === "nested") {
            await fulfillBlockedDocument(route);
          } else {
            await route.fulfill({ status: 204, body: "" }).catch(() => {});
          }
          return;
        }
        if (kind !== "top-level") {
          await route.continue().catch(() => {});
          return;
        }
        if (classifyTopLevelRequest(req, topLevelLookup) !== "initial-popup") {
          await route.continue().catch(() => {});
          return;
        }
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: 10_000 });
          const location = response.headers()["location"];
          if (location && response.status() >= 300 && response.status() < 400) {
            const next = redirectTarget(url, location);
            if (next && (next.startsWith("http://") || next.startsWith("https://"))) {
              try {
                await opts.guardNavigation(next, kind);
              } catch (e) {
                const failure = e as Error & { code?: string };
                if (failure.code === "approval-required") emitApproval(req, next, failure.message);
                await route.abort("blockedbyclient").catch(() => {});
                return;
              }
            } else if (next && !isInternalBrowserUrl(next)) {
              await route.abort("blockedbyclient").catch(() => {});
              return;
            }
          }
          await route.fulfill({ response });
          const after = requestPage(req);
          if (after) void installCdpHopGuard(after);
        } catch {
          await route.abort("blockedbyclient").catch(() => {});
        }
      };

      const listedOrigins = new Set(
        (opts.listedOrigins ?? []).flatMap((origin) => originAliases(origin)),
      );
      const websocketNeedsIntercept = (url: URL): boolean => {
        try {
          const httpOrigin = new URL(webSocketUrlAsHttp(url.href)).origin.toLowerCase();
          return !listedOrigins.has(httpOrigin);
        } catch {
          return true;
        }
      };

      const handleWebSocket = async (ws: import("playwright-core").WebSocketRoute): Promise<void> => {
        let httpUrl: string;
        try {
          httpUrl = webSocketUrlAsHttp(ws.url());
        } catch {
          await ws.close({ code: 3000, reason: "blocked" }).catch(() => {});
          return;
        }
        try {
          await opts.guardNavigation(httpUrl, "subresource");
        } catch {
          await ws.close({ code: 3000, reason: "blocked" }).catch(() => {});
          return;
        }
        // Public / listed sockets stay Chromium NativeWebSocket (not a Node proxy).
        ws.connectToServer();
      };

      await context.route("**/*", (route) => handleRoute(route));
      await context.routeWebSocket((url) => websocketNeedsIntercept(url), (ws) => { void handleWebSocket(ws); });

      await context.addInitScript(() => {
        const native = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async (text: string) => {
          await native(text);
          // @ts-expect-error exposed binding
          await window.__polythClipboardWrite(text);
        };
      });

      try {
        await context.exposeBinding("__polythClipboardWrite", (_source, text: string) => {
          for (const page of pages.values()) {
            page.handleClipboardWrite(String(text));
          }
        });
      } catch {
        // binding may already exist on profile restart
      }

      const profileContext: ProfileContext = {
        profileId: opts.profileId,
        userDataDir: opts.userDataDir,
        async newPage(tabId) {
          if (pages.has(tabId)) throw err("conflict", `tab ${tabId} already exists`);
          const pwPage = await context.newPage();
          residentPages.add(pwPage);
          await installCdpHopGuard(pwPage);
          const profilePage = new ChromiumProfilePage(
            tabId,
            pwPage,
            context,
            opts,
            popups,
            pageOwners,
            popupOpeners,
            flushPendingApproval,
            (page) => { lastInputPage = page; },
            () => pages.delete(tabId),
            installCdpHopGuard,
            (page) => { residentPages.add(page); },
          );
          pages.set(tabId, profilePage);
          return profilePage;
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
          popups.clear();
          await context.close().catch(() => {});
          openDirs.delete(key);
        },
      };
      return profileContext;
    },
  };
}

class ChromiumProfilePage implements ProfilePage {
  readonly tabId: string;
  readonly contentAccess = MANUAL_ONLY_POLICY;
  private url = "about:blank";
  private title = "";
  private loading = false;
  private closed = false;
  private hibernated = false;
  private pacing = createScreencastPacing();
  private screencastOn = false;
  private cdp: import("playwright-core").CDPSession | null = null;
  private frameCbs = new Set<(frame: ScreencastFrame) => void>();
  private eventCbs = new Set<(ev: ProfilePageEvent) => void>();
  private pendingChooser: import("playwright-core").FileChooser | null = null;
  private lastGestureAt = 0;
  private popups = new Map<string, {
    page: import("playwright-core").Page;
    cdp: import("playwright-core").CDPSession | null;
    screencastOn: boolean;
    pacing: ReturnType<typeof createScreencastPacing>;
  }>();
  onPopupFrame?: (popupId: string, frame: ScreencastFrame) => void;
  private page!: PlaywrightPage;
  private context: import("playwright-core").BrowserContext;
  private opts: ProfileDriverOpenOptions;
  private onClose: () => void;
  private globalPopups: Map<string, { page: PlaywrightPage; parentTabId: string }>;
  private pageOwners: Map<PlaywrightPage, ChromiumProfilePage>;
  private popupOpeners: Map<PlaywrightPage, ChromiumProfilePage>;
  private onPendingApproval: (owner: ChromiumProfilePage) => void;
  private onTouch: (page: ChromiumProfilePage) => void;
  private installHopGuard: (page: PlaywrightPage) => Promise<void>;
  private markResident: (page: PlaywrightPage) => void;

  constructor(
    tabId: string,
    page: PlaywrightPage,
    context: import("playwright-core").BrowserContext,
    opts: ProfileDriverOpenOptions,
    globalPopups: Map<string, { page: PlaywrightPage; parentTabId: string }>,
    pageOwners: Map<PlaywrightPage, ChromiumProfilePage>,
    popupOpeners: Map<PlaywrightPage, ChromiumProfilePage>,
    onPendingApproval: (owner: ChromiumProfilePage) => void,
    onTouch: (page: ChromiumProfilePage) => void,
    onClose: () => void,
    installHopGuard: (page: PlaywrightPage) => Promise<void>,
    markResident: (page: PlaywrightPage) => void,
  ) {
    this.tabId = tabId;
    this.context = context;
    this.opts = opts;
    this.onClose = onClose;
    this.globalPopups = globalPopups;
    this.pageOwners = pageOwners;
    this.popupOpeners = popupOpeners;
    this.onPendingApproval = onPendingApproval;
    this.onTouch = onTouch;
    this.installHopGuard = installHopGuard;
    this.markResident = markResident;
    this.bindUnderlyingPage(page);
  }

  emitApprovalRequired(url: string, reason: string): void {
    let origin: string | undefined;
    try { origin = new URL(url).origin; } catch { /* invalid */ }
    this.emit({ kind: "approval-required", url, origin, reason });
  }

  private bindUnderlyingPage(page: PlaywrightPage): void {
    if (this.page) this.pageOwners.delete(this.page);
    this.page = page;
    this.pageOwners.set(page, this);
    this.wirePageEvents();
    this.page.on("popup", (popup) => {
      const popupId = `popup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pacing = createScreencastPacing();
      setScreencastVisible(pacing, this.pacing.visible);
      this.popupOpeners.set(popup, this);
      this.globalPopups.set(popupId, { page: popup, parentTabId: this.tabId });
      this.popups.set(popupId, { page: popup, cdp: null, screencastOn: false, pacing });
      this.emit({ kind: "popup-opened", popupId, url: popup.url() });
      this.onPendingApproval(this);
      if (this.pacing.visible) void this.startPopupScreencast(popupId).catch(() => {});
      popup.once("framenavigated", () => { void this.installHopGuard(popup); });
      popup.on("close", () => { this.finalizePopup(popupId); });
    });
  }

  private finalizePopup(popupId: string): void {
    const session = this.popups.get(popupId);
    if (!session) return;
    this.popups.delete(popupId);
    this.globalPopups.delete(popupId);
    session.screencastOn = false;
    if (session.cdp) {
      void session.cdp.send("Page.stopScreencast").catch(() => {});
      session.cdp = null;
    }
    this.emit({ kind: "popup-closed", popupId });
  }

  private async closeAllPopups(): Promise<void> {
    for (const popupId of [...this.popups.keys()]) {
      const session = this.popups.get(popupId);
      await session?.page.close().catch(() => {});
      this.finalizePopup(popupId);
    }
  }


  private async startPopupScreencast(popupId: string): Promise<void> {
    const session = this.popups.get(popupId);
    if (!session || session.screencastOn || !this.pacing.visible) return;
    session.screencastOn = true;
    try {
      session.cdp = await session.page.context().newCDPSession(session.page);
      await session.cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        maxWidth: 960,
        maxHeight: 720,
        everyNthFrame: 1,
      });
    } catch {
      session.screencastOn = false;
      session.cdp = null;
      return;
    }
    session.cdp.on("Page.screencastFrame", (params: {
      data: string;
      metadata: { deviceWidth: number; deviceHeight: number };
      sessionId: number;
    }) => {
      if (!session.screencastOn || !shouldEmitScreencastFrame(session.pacing)) {
        void session.cdp?.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
        return;
      }
      markScreencastFrameEmitted(session.pacing);
      this.onPopupFrame?.(popupId, {
        data: Buffer.from(params.data, "base64"),
        mime: "image/jpeg",
        width: params.metadata.deviceWidth,
        height: params.metadata.deviceHeight,
      });
      void session.cdp?.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    });
  }

  private async stopPopupScreencast(popupId: string): Promise<void> {
    const session = this.popups.get(popupId);
    if (!session) return;
    session.screencastOn = false;
    if (session.cdp) {
      try { await session.cdp.send("Page.stopScreencast"); } catch { /* gone */ }
      session.cdp = null;
    }
  }

  async popupInput(popupId: string, input: Record<string, unknown>): Promise<void> {
    const session = this.popups.get(popupId);
    if (!session) throw err("not-found", `popup ${popupId} not found`);
    this.touchActivity();
    noteScreencastActivity(session.pacing);
    const popup = session.page;
    if (input.inputType === "mouse") {
      const x = Number(input.x ?? 0);
      const y = Number(input.y ?? 0);
      const kind = String(input.kind ?? "click");
      const button = input.button === "right" ? "right" : input.button === "middle" ? "middle" : "left";
      const mods = Array.isArray(input.modifiers)
        ? input.modifiers.filter((mod): mod is "Alt" | "Control" | "Meta" | "Shift" =>
          mod === "Alt" || mod === "Control" || mod === "Meta" || mod === "Shift")
        : [];
      for (const mod of mods) await popup.keyboard.down(mod);
      if (kind === "move") await popup.mouse.move(x, y);
      else if (kind === "down") await popup.mouse.down({ button });
      else if (kind === "up") await popup.mouse.up({ button });
      else if (kind === "dblclick") await popup.mouse.dblclick(x, y, { button });
      else await popup.mouse.click(x, y, { button });
      for (const mod of [...mods].reverse()) await popup.keyboard.up(mod);
      return;
    }
    if (input.inputType === "key") {
      const key = String(input.key ?? "");
      const kind = String(input.kind ?? "press");
      const mods = Array.isArray(input.modifiers)
        ? input.modifiers.filter((mod): mod is "Alt" | "Control" | "Meta" | "Shift" =>
          mod === "Alt" || mod === "Control" || mod === "Meta" || mod === "Shift")
        : [];
      for (const mod of mods) await popup.keyboard.down(mod);
      if (kind === "down") await popup.keyboard.down(key);
      else if (kind === "up") await popup.keyboard.up(key);
      else await popup.keyboard.press(key);
      for (const mod of [...mods].reverse()) await popup.keyboard.up(mod);
      return;
    }
    if (input.inputType === "wheel") {
      await popup.mouse.wheel(Number(input.dx ?? 0), Number(input.dy ?? 0));
    }
  }

  async closePopup(popupId: string): Promise<void> {
    const session = this.popups.get(popupId);
    if (!session) return;
    await session.page.close().catch(() => {});
    this.finalizePopup(popupId);
  }

  private wirePageEvents(): void {
    this.page.on("framenavigated", (frame) => {
      if (frame !== this.page.mainFrame()) return;
      this.url = frame.url();
      void this.refreshTitle().then(() => {
        this.emit({ kind: "navigation", url: this.url });
      });
    });
    this.page.on("load", () => {
      this.loading = false;
      void this.refreshTitle().then(() => { this.emit({ kind: "navigation", url: this.url }); });
      this.emit({ kind: "loading" });
    });
    this.page.on("domcontentloaded", () => {
      this.loading = true;
      void this.refreshTitle();
      this.emit({ kind: "loading" });
    });
    this.page.on("crash", () => this.emit({ kind: "crash", message: "page crashed" }));
    this.page.on("download", (dl) => {
      this.emit({ kind: "download-blocked", url: dl.url(), message: "downloads are blocked" });
      void dl.cancel().catch(() => {});
    });
    this.page.on("filechooser", (chooser) => {
      this.pendingChooser = chooser;
      this.emit({ kind: "file-chooser-opened" });
    });
  }

  handleClipboardWrite(text: string): void {
    if (Date.now() - this.lastGestureAt > 3000) return;
    this.emit({ kind: "clipboard-written", text });
    this.opts.onClipboardWrite?.(text);
  }

  private emit(ev: ProfilePageEvent): void {
    for (const cb of [...this.eventCbs]) cb(ev);
  }

  touchActivity(): void {
    this.lastGestureAt = Date.now();
    this.onTouch(this);
    noteScreencastActivity(this.pacing);
  }

  setStreamVisible(visible: boolean): void {
    setScreencastVisible(this.pacing, visible);
    for (const session of this.popups.values()) setScreencastVisible(session.pacing, visible);
    if (!visible) {
      if (this.screencastOn) void this.stopScreencast();
      for (const popupId of this.popups.keys()) void this.stopPopupScreencast(popupId);
      return;
    }
    for (const popupId of this.popups.keys()) void this.startPopupScreencast(popupId);
  }

  private async refreshTitle(): Promise<void> {
    try {
      this.title = await Promise.race([
        this.page.title(),
        new Promise<string>((resolve) => setTimeout(() => resolve(this.title), 1_000)),
      ]);
    } catch { /* navigating */ }
  }

  private nav(): ProfileNav {
    return { url: this.url, title: this.title, loading: this.loading };
  }

  async goto(url: string): Promise<ProfileNav> {
    if (this.closed || this.hibernated) throw err("unavailable", "page not active");
    this.touchActivity();
    if (!isInternalBrowserUrl(url)) {
      try {
        await this.opts.guardNavigation(url, "top-level");
      } catch (e) {
        const failure = e as Error & { code?: string };
        if (failure.code === "approval-required") this.emitApprovalRequired(url, failure.message);
        throw e;
      }
    }
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
    this.url = this.page.url();
    await this.refreshTitle();
    return this.nav();
  }

  async back(): Promise<ProfileNav> {
    this.touchActivity();
    await this.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    this.url = this.page.url();
    await this.refreshTitle();
    return this.nav();
  }

  async forward(): Promise<ProfileNav> {
    this.touchActivity();
    await this.page.goForward({ waitUntil: "domcontentloaded" }).catch(() => null);
    this.url = this.page.url();
    await this.refreshTitle();
    return this.nav();
  }

  async reload(): Promise<ProfileNav> {
    this.touchActivity();
    await this.page.reload({ waitUntil: "domcontentloaded" });
    return this.nav();
  }

  async stop(): Promise<void> {
    await this.page.evaluate(() => window.stop()).catch(() => {});
    this.loading = false;
  }

  current(): ProfileNav {
    this.url = this.page.url();
    return this.nav();
  }

  async mouse(input: {
    kind: import("./profileDriver.ts").ProfileMouseKind;
    x: number;
    y: number;
    button?: "left" | "middle" | "right";
    modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
  }): Promise<void> {
    this.touchActivity();
    const mods = input.modifiers ?? [];
    for (const mod of mods) await this.page.keyboard.down(mod);
    const btn = input.button ?? "left";
    if (input.kind === "move") await this.page.mouse.move(input.x, input.y);
    else if (input.kind === "down") await this.page.mouse.down({ button: btn });
    else if (input.kind === "up") await this.page.mouse.up({ button: btn });
    else if (input.kind === "click") await this.page.mouse.click(input.x, input.y, { button: btn });
    else if (input.kind === "dblclick") await this.page.mouse.dblclick(input.x, input.y, { button: btn });
    for (const mod of [...mods].reverse()) await this.page.keyboard.up(mod);
  }

  async wheel(dx: number, dy: number, x: number, y: number): Promise<void> {
    this.touchActivity();
    await this.page.mouse.move(x, y);
    await this.page.mouse.wheel(dx, dy);
  }

  async key(input: {
    kind: import("./profileDriver.ts").ProfileKeyKind;
    key: string;
    modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
  }): Promise<void> {
    this.touchActivity();
    const mods = input.modifiers ?? [];
    for (const mod of mods) await this.page.keyboard.down(mod);
    if (input.kind === "down") await this.page.keyboard.down(input.key);
    else if (input.kind === "up") await this.page.keyboard.up(input.key);
    else await this.page.keyboard.press(input.key);
    for (const mod of [...mods].reverse()) await this.page.keyboard.up(mod);
  }

  async insertText(text: string): Promise<void> {
    this.touchActivity();
    await this.page.keyboard.insertText(text);
  }

  async resize(viewport: { width: number; height: number }): Promise<void> {
    this.touchActivity();
    await this.page.setViewportSize(viewport);
  }

  async copySelection(): Promise<string> {
    return this.page.evaluate(() => window.getSelection()?.toString() ?? "");
  }

  async startScreencast(opts: { quality: number; maxWidth: number; maxHeight: number }): Promise<void> {
    if (this.screencastOn) {
      await this.stopScreencast();
    }
    this.screencastOn = true;
    this.cdp = await this.context.newCDPSession(this.page);
    await this.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: opts.quality,
      maxWidth: opts.maxWidth,
      maxHeight: opts.maxHeight,
      everyNthFrame: 1,
    });
    this.cdp.on("Page.screencastFrame", (params: {
      data: string;
      metadata: { deviceWidth: number; deviceHeight: number };
      sessionId: number;
    }) => {
      if (!this.screencastOn || !shouldEmitScreencastFrame(this.pacing)) {
        void this.cdp?.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
        return;
      }
      markScreencastFrameEmitted(this.pacing);
      const frame: ScreencastFrame = {
        data: Buffer.from(params.data, "base64"),
        mime: "image/jpeg",
        width: params.metadata.deviceWidth,
        height: params.metadata.deviceHeight,
      };
      for (const cb of [...this.frameCbs]) cb(frame);
      void this.cdp?.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    });
  }

  async stopScreencast(): Promise<void> {
    this.screencastOn = false;
    if (this.cdp) {
      try { await this.cdp.send("Page.stopScreencast"); } catch { /* gone */ }
      this.cdp = null;
    }
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
    await this.closeAllPopups();
    await this.stopScreencast();
    this.pageOwners.delete(this.page);
    const snap = { url: this.page.url(), title: this.title };
    await this.page.close().catch(() => {});
    return snap;
  }

  async restore(url: string): Promise<ProfileNav> {
    this.hibernated = false;
    const pwPage = await this.context.newPage();
    this.markResident(pwPage);
    await this.installHopGuard(pwPage);
    this.bindUnderlyingPage(pwPage);
    return this.goto(url);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.closeAllPopups();
    await this.stopScreencast();
    this.frameCbs.clear();
    this.eventCbs.clear();
    this.pageOwners.delete(this.page);
    await this.page.close().catch(() => {});
    this.onClose();
  }

  async setFiles(files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<void> {
    if (!this.pendingChooser) throw err("invalid-input", "no pending file chooser");
    await this.pendingChooser.setFiles(files.map((f) => ({
      name: f.name,
      mimeType: f.mimeType,
      buffer: f.buffer,
    })));
    this.pendingChooser = null;
  }
}

export async function profileChromiumAvailable(): Promise<{ available: boolean; reason?: string }> {
  const bin = await findChromiumExecutable();
  if (!bin) {
    return { available: false, reason: "browser engine unavailable: no Chromium executable found (set POLYTH_CHROMIUM_PATH)" };
  }
  try {
    await access(bin, constants.X_OK);
    return { available: true };
  } catch {
    return { available: false, reason: `Chromium not executable: ${bin}` };
  }
}

/** Test helper: clear in-memory open-dir tracking. */
export function resetProfileChromiumLocks(): void {
  openDirs.clear();
}

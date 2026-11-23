// A NativeWebViewHost on playwright-core + a real Chromium, for exercising the
// native driver without Electron. The CDP wrapper exposes the page's own
// target session; request policy runs through context.route like the Desktop
// host's guardRequest hook.
import type {
  NativeWebView,
  NativeWebViewCdp,
  NativeWebViewGoneReason,
  NativeWebViewHost,
} from "@polyth/plugins";

type Listener<T> = (value: T) => void;

export interface FixtureView extends NativeWebView {
  setShown(shown: boolean): void;
  readonly parkedSizes: Array<{ width: number; height: number }>;
  /** Fire the host-side "download blocked" notification. */
  blockDownload(url: string): void;
  crash(): Promise<void>;
  listenerCount(): number;
}

export interface Fixture {
  host: NativeWebViewHost;
  views: FixtureView[];
  dispose(): Promise<void>;
}

export async function createFixtureHost(executablePath: string): Promise<Fixture> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check"],
  });
  const views: FixtureView[] = [];
  const host: NativeWebViewHost = {
    async create(opts) {
      const context = await browser.newContext({
        viewport: { width: opts.width, height: opts.height },
        // A ratio-2 screen, as a Retina Mac: the page must keep it.
        deviceScaleFactor: 2,
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      await context.route("**/*", async (route) => {
        const request = route.request();
        if (!/^https?:\/\//i.test(request.url())) { await route.continue(); return; }
        let kind: "navigation" | "subresource" = "subresource";
        try {
          if (request.isNavigationRequest() && request.frame().parentFrame() === null) kind = "navigation";
        } catch { /* detached frame */ }
        const allowed = opts.guardRequest ? await opts.guardRequest({ url: request.url(), kind }).catch(() => false) : false;
        if (!allowed) { await route.abort("blockedbyclient"); return; }
        // Chromium follows redirects inside route.continue(); the Desktop host
        // guards every hop, so fetch one hop at a time here.
        try {
          const response = await route.fetch({ maxRedirects: 0 });
          const location = response.headers()["location"];
          if (location && response.status() >= 300 && response.status() < 400) {
            const next = new URL(location, request.url()).href;
            const nextAllowed = opts.guardRequest ? await opts.guardRequest({ url: next, kind }).catch(() => false) : false;
            if (!nextAllowed) { await route.abort("blockedbyclient"); return; }
          }
          await route.fulfill({ response });
        } catch {
          await route.abort("failed").catch(() => {});
        }
      });
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      const eventListeners = new Set<(method: string, params: unknown) => void>();
      const emitter = session as unknown as { emit: (name: string | symbol, ...args: unknown[]) => boolean };
      const originalEmit = emitter.emit.bind(session);
      emitter.emit = (name, ...args) => {
        if (typeof name === "string" && name.includes(".")) for (const l of [...eventListeners]) l(name, args[0]);
        return originalEmit(name, ...args);
      };
      const cdp: NativeWebViewCdp = {
        send: (method, params) => (session.send as (m: string, p?: unknown) => Promise<unknown>)(method, params),
        onEvent(listener) {
          eventListeners.add(listener);
          return () => { eventListeners.delete(listener); };
        },
      };
      const windowOpen = new Set<Listener<string>>();
      const gone = new Set<Listener<NativeWebViewGoneReason>>();
      const downloads = new Set<Listener<string>>();
      const shownListeners = new Set<Listener<boolean>>();
      let shown = false;
      let goneFired = false;
      const fireGone = (reason: NativeWebViewGoneReason) => {
        if (goneFired) return;
        goneFired = true;
        for (const l of [...gone]) l(reason);
      };
      context.on("page", (extra) => {
        if (extra === page) return;
        void (async () => {
          try { await extra.waitForURL((u) => u.toString() !== "about:blank", { timeout: 5000 }); } catch { /* blank popup */ }
          const url = extra.url();
          await extra.close().catch(() => {});
          for (const l of [...windowOpen]) l(url);
        })();
      });
      page.on("download", (download) => {
        const url = download.url();
        void download.cancel().catch(() => {});
        for (const l of [...downloads]) l(url);
      });
      page.on("crash", () => fireGone("crashed"));
      page.on("close", () => fireGone("closed"));
      const view: FixtureView = {
        id: `fixture-${views.length + 1}`,
        cdp,
        parkedSizes: [],
        onWindowOpen: (l) => { windowOpen.add(l); return () => { windowOpen.delete(l); }; },
        onGone: (l) => { gone.add(l); return () => { gone.delete(l); }; },
        onDownloadBlocked: (l) => { downloads.add(l); return () => { downloads.delete(l); }; },
        // The host resizes the parked view's bounds; Playwright's viewport is
        // that here. A shown view is sized by its window, not by this.
        setParkedSize(width, height) {
          view.parkedSizes.push({ width, height });
          if (!shown) void page.setViewportSize({ width, height }).catch(() => {});
        },
        async capture(clip) {
          const data = await page.screenshot({ type: "jpeg", quality: 70, ...(clip ? { clip } : {}) });
          return { data: new Uint8Array(data), mime: "image/jpeg" };
        },
        shown: () => shown,
        onShownChange: (l) => { shownListeners.add(l); return () => { shownListeners.delete(l); }; },
        async close() {
          await context.close().catch(() => {});
          fireGone("closed");
        },
        setShown(next) {
          shown = next;
          for (const l of [...shownListeners]) l(next);
        },
        blockDownload(url) { for (const l of [...downloads]) l(url); },
        async crash() {
          // The command never answers: the renderer dies first.
          void session.send("Page.crash").catch(() => {});
        },
        listenerCount: () => eventListeners.size + windowOpen.size + gone.size + downloads.size + shownListeners.size,
      };
      views.push(view);
      return view;
    },
  };
  return {
    host,
    views,
    async dispose() { await browser.close().catch(() => {}); },
  };
}

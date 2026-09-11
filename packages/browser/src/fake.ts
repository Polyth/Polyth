// In-memory fake driver: deterministic pages, redirects, downloads, password
// fields, console noise. Tests and the POLYTH_FAKE_BROWSER demo mode use it.
import type { BrowserTarget, JsonObject } from "@polyth/contracts";
import type { BrowserDriver, DriverFrame, DriverNav, DriverPage, DriverPageEvent, DriverObservation } from "./driver.ts";

export interface FakePage {
  title: string;
  text?: string;
  /** selector/role-name -> destination url for click targets */
  links?: Record<string, string>;
  /** navigating here 302s to this url before landing */
  redirectTo?: string;
  /** navigating here would trigger a download */
  download?: boolean;
  /** password inputs present on the page (values must never be observed) */
  passwordFields?: Record<string, string>;
  consoleOnLoad?: string[];
  /** Actual focused editable metadata for click/press — never a generic hit-test. */
  focused?: JsonObject;
}

export interface FakeWeb {
  pages: Record<string, FakePage>;
}

const targetKey = (t: BrowserTarget): string => {
  if ("selector" in t) return t.selector;
  if ("text" in t) return `text:${t.text}`;
  if ("role" in t) return `${t.role}:${t.name ?? ""}`;
  return `point:${t.point.x},${t.point.y}`;
};

export function createFakeDriver(web: FakeWeb): BrowserDriver {
  return {
    engine: "fake",
    close: async () => {},
    async open(opts) {
      const history: string[] = [];
      let index = -1;
      const typed = new Map<string, string>();
      const listeners = new Set<(ev: DriverPageEvent) => void>();
      let viewport = { width: opts.width, height: opts.height };
      let colorScheme = opts.colorScheme;
      let closed = false;
      let screencastOn = false;
      let frameTimer: ReturnType<typeof setInterval> | null = null;
      const frameCbs = new Set<(frame: DriverFrame) => void>();
      const emit = (ev: DriverPageEvent) => { for (const l of [...listeners]) l(ev); };

      const pageOf = (url: string): FakePage =>
        web.pages[url] ?? { title: "Not found", text: `No such page: ${url}` };

      const nav = (): DriverNav => {
        const url = history[index] ?? "about:blank";
        return { url, title: pageOf(url).title };
      };

      const land = async (url: string, pushHistory: boolean): Promise<DriverNav> => {
        if (closed) throw new Error("page closed");
        let hop = url;
        const seen = new Set<string>();
        for (;;) {
          await opts.guardNavigation(hop); // throws to block (policy)
          const page = pageOf(hop);
          if (page.download) {
            emit({ kind: "download-blocked", url: hop, message: "downloads are blocked" });
            throw Object.assign(new Error(`download blocked: ${hop}`), { code: "download-blocked" });
          }
          if (page.redirectTo && !seen.has(page.redirectTo)) {
            seen.add(hop);
            hop = page.redirectTo;
            continue;
          }
          if (pushHistory) {
            history.splice(index + 1);
            history.push(hop);
            index = history.length - 1;
          } else {
            history[index] = hop;
          }
          emit({ kind: "navigation", url: hop });
          for (const line of page.consoleOnLoad ?? []) emit({ kind: "console", message: line, level: "log" });
          return nav();
        }
      };

      const page: DriverPage = {
        goto: (url) => land(url, true),
        async back() {
          if (index > 0) index--;
          emit({ kind: "navigation", url: nav().url });
          return nav();
        },
        async forward() {
          if (index < history.length - 1) index++;
          emit({ kind: "navigation", url: nav().url });
          return nav();
        },
        reload: async () => land(nav().url, false),
        stop: async () => {},
        async click(target) {
          const cur = pageOf(nav().url);
          const dest = cur.links?.[targetKey(target)];
          if (dest) await land(dest, true);
          return { ...(pageOf(nav().url).focused ?? {}) } as JsonObject;
        },
        async point(point) {
          return {
            selector: "main",
            tag: "main",
            role: "main",
            name: pageOf(nav().url).title,
            text: pageOf(nav().url).text ?? "",
            rect: {
              x: Math.max(0, Math.min(point.x, viewport.width - 1)),
              y: Math.max(0, Math.min(point.y, viewport.height - 1)),
              width: Math.max(1, Math.min(240, viewport.width)),
              height: Math.max(1, Math.min(80, viewport.height)),
            },
            attributes: {},
            editable: false,
          };
        },
        async type(target, text) {
          typed.set(targetKey(target), text);
        },
        press: async () => ({ ...(pageOf(nav().url).focused ?? {}) } as JsonObject),
        async textRange(start, end) {
          const p = pageOf(nav().url);
          return {
            quote: (p.text ?? "").replace(/\s+/g, " ").trim().slice(0, 4_000),
            rect: {
              x: Math.round(Math.min(start.x, end.x)),
              y: Math.round(Math.min(start.y, end.y)),
              width: Math.max(1, Math.round(Math.abs(end.x - start.x))),
              height: Math.max(1, Math.round(Math.abs(end.y - start.y))),
            },
          };
        },
        scroll: async () => {},
        async select(target, value) {
          typed.set(targetKey(target), value);
        },
        wait: async () => {},
        async resize(next) {
          viewport = { ...next };
        },
        async emulateColorScheme(next) {
          colorScheme = next;
        },
        async inspect(selector) {
          return {
            selector,
            tag: selector.startsWith("input") ? "input" : "div",
            text: pageOf(nav().url).text ?? "",
            rect: { x: 0, y: 0, width: viewport.width, height: viewport.height },
            styles: { display: "block", position: "static", colorScheme },
          };
        },
        async targetRect(target) {
          if ("point" in target) {
            return { x: target.point.x, y: target.point.y, width: 1, height: 1 };
          }
          return { x: 0, y: 0, width: Math.min(240, viewport.width), height: Math.min(80, viewport.height) };
        },
        async screenshot() {
          // deterministic bytes derived from the current URL (no real pixels)
          const data = new TextEncoder().encode(`frame:${nav().url}:${index}`);
          return { data, mime: "image/webp" };
        },
        async startScreencast() {
          if (screencastOn) return;
          screencastOn = true;
          frameTimer = setInterval(() => {
            if (!screencastOn) return;
            const frame: DriverFrame = {
              data: new TextEncoder().encode(`stream:${nav().url}:${Date.now()}`),
              mime: "image/jpeg",
              width: viewport.width,
              height: viewport.height,
            };
            for (const cb of [...frameCbs]) cb(frame);
          }, 50);
          frameTimer.unref?.();
        },
        async stopScreencast() {
          screencastOn = false;
          if (frameTimer) clearInterval(frameTimer);
          frameTimer = null;
        },
        onFrame(cb) {
          frameCbs.add(cb);
          return () => { frameCbs.delete(cb); };
        },
        async screenshotClip(clip) {
          const data = new TextEncoder().encode(
            `clip:${nav().url}:${Math.round(clip.x)},${Math.round(clip.y)},${Math.round(clip.width)}x${Math.round(clip.height)}`,
          );
          return { data, mime: "image/webp" };
        },
        async queryRegion(region) {
          const p = pageOf(nav().url);
          return {
            elements: [{
              selector: "main",
              tag: "main",
              role: "main",
              name: p.title,
              text: (p.text ?? "").slice(0, 240),
              bounds: {
                x: Math.round(region.x),
                y: Math.round(region.y),
                width: Math.round(region.width),
                height: Math.round(region.height),
              },
            }],
            text: (p.text ?? "").slice(0, 4_000),
          };
        },
        async observe(): Promise<DriverObservation> {
          const url = nav().url;
          const p = pageOf(url);
          // Honest driver behavior: password field VALUES are never emitted;
          // typed values into non-password fields are (redaction runs above).
          const typedText = [...typed.entries()]
            .filter(([k]) => !(p.passwordFields && k in p.passwordFields))
            .map(([k, v]) => `${k}=${v}`)
            .join("\n");
          return {
            url,
            title: p.title,
            text: [p.text ?? "", typedText].filter(Boolean).join("\n"),
            accessibilityDigest: `page:${p.title}`,
          };
        },
        current: nav,
        onEvent(cb) {
          listeners.add(cb);
          return () => { listeners.delete(cb); };
        },
        close: async () => {
          closed = true;
          listeners.clear();
          frameCbs.clear();
          if (frameTimer) clearInterval(frameTimer);
          frameTimer = null;
        },
      };
      return page;
    },
  };
}

/** Small built-in site for demo mode (POLYTH_FAKE_BROWSER=1). */
export function demoWeb(previewUrl?: string): FakeWeb {
  const home = previewUrl ?? "http://127.0.0.1:0/";
  return {
    pages: {
      [home]: {
        title: "Demo app",
        text: "Welcome to the demo preview page.",
        links: { "a#about": `${home}about` },
        consoleOnLoad: ["demo app booted"],
      },
      [`${home}about`]: { title: "About", text: "About this demo." },
    },
  };
}

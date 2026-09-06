// Chromium driver on playwright-core. Requires an already-installed Chromium
// executable (POLYTH_CHROMIUM_PATH or a well-known path); never downloads a
// browser. Isolated context: no downloads, popups, permissions, or storage
// reuse. Navigation hops run through the manager's policy guard via routing.
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { BrowserTarget, JsonObject } from "@polyth/contracts";
import type { BrowserDriver, DriverNav, DriverPage, DriverPageEvent } from "./driver.ts";

export const CHROMIUM_CANDIDATE_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/local/bin/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/local/bin/google-chrome",
  "/opt/google/chrome/google-chrome",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const executable = async (path: string): Promise<string | null> => {
  try {
    await access(path, constants.X_OK);
    return path;
  } catch {
    return null;
  }
};

/** Configured or well-known Chromium executable, or null (fallback mode).
 *  Never downloads a browser; playwright-core's bundled Chrome is used only
 *  when that file is already on disk. */
export async function findChromiumExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configured = env.POLYTH_CHROMIUM_PATH?.trim();
  if (configured) return executable(configured);
  for (const path of CHROMIUM_CANDIDATE_PATHS) {
    const found = await executable(path);
    if (found) return found;
  }
  try {
    const { chromium } = await import("playwright-core");
    const bundled = chromium.executablePath();
    if (bundled) return executable(bundled);
  } catch {
    // playwright-core absent or no local browser install
  }
  return null;
}

/** Page-side hit-test / focus inspect. Must stay self-contained for evaluate(). */
function describeHit(args: { x?: number; y?: number; preferFocus?: boolean; focusedOnly?: boolean }): Record<string, unknown> {
  const quote = (value: string) =>
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  const unique = (selector: string) => {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const selectorFor = (node: Element): string => {
    const testId = node.getAttribute("data-testid");
    if (testId) {
      const candidate = `[data-testid="${testId.replace(/["\\]/g, "\\$&")}"]`;
      if (unique(candidate)) return candidate;
    }
    if (node.id) {
      const candidate = `#${quote(node.id)}`;
      if (unique(candidate)) return candidate;
    }
    const parts: string[] = [];
    let current: Element | null = node;
    while (current && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === current!.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (unique(candidate)) return candidate;
      current = parent;
    }
    return parts.join(" > ") || node.tagName.toLowerCase();
  };
  const isEditable = (node: Element): boolean => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.isContentEditable) return true;
    const tag = node.tagName.toLowerCase();
    if (tag === "textarea" || tag === "select") return true;
    if (tag === "input") {
      const type = (node.getAttribute("type") ?? "text").toLowerCase();
      return !["button", "submit", "reset", "checkbox", "radio", "file", "image", "hidden", "range", "color"].includes(type);
    }
    return false;
  };
  const active = document.activeElement instanceof Element ? document.activeElement : null;
  const hit = typeof args.x === "number" && typeof args.y === "number"
    ? document.elementFromPoint(args.x, args.y)
    : null;
  const focusedEditable = Boolean(
    active
    && active !== document.body
    && active !== document.documentElement
    && isEditable(active),
  );
  // Post-click/press typing state must not fall back to elementFromPoint on a
  // new document after navigation — a coincidental input at the old coordinates
  // is not the focused field.
  const element = args.focusedOnly
    ? (focusedEditable ? active : null)
    : (args.preferFocus && focusedEditable ? active : (hit ?? active));
  if (!(element instanceof Element) || element === document.body || element === document.documentElement) {
    return {};
  }
  const tag = element.tagName.toLowerCase();
  const implicitRole: Record<string, string> = {
    a: "link", button: "button", select: "combobox", textarea: "textbox",
    img: "img", nav: "navigation", main: "main", form: "form",
  };
  const role = element.getAttribute("role")
    ?? (tag === "input"
      ? ((element.getAttribute("type") ?? "text") === "checkbox" ? "checkbox" : "textbox")
      : implicitRole[tag]);
  const name = element.getAttribute("aria-label")
    ?? element.getAttribute("title")
    ?? (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 160);
  const rect = element.getBoundingClientRect();
  const attributes: Record<string, string> = Object.fromEntries(
    ["id", "class", "data-testid", "name", "type", "aria-label", "title", "contenteditable"]
      .map((key) => [key, element.getAttribute(key)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== null)
      .map(([key, value]) => [key, value.slice(0, 300)]),
  );
  const editable = isEditable(element);
  if (editable && !attributes.contenteditable && element instanceof HTMLElement && element.isContentEditable) {
    attributes.contenteditable = "true";
  }
  return {
    selector: selectorFor(element),
    tag,
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 500),
    editable,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    attributes,
  };
}

export function createChromiumDriver(executablePath: string): BrowserDriver {
  // Lazy import: the package loads and typechecks even where playwright-core
  // is pruned; the driver is only constructed when an executable exists.
  let browserP: Promise<import("playwright-core").Browser> | null = null;
  const launch = async (): Promise<import("playwright-core").Browser> => {
    if (!browserP) {
      browserP = import("playwright-core").then((pw) =>
        pw.chromium.launch({
          executablePath,
          headless: true,
          args: ["--disable-extensions", "--disable-background-networking", "--no-default-browser-check"],
        }),
      );
    }
    return browserP;
  };

  return {
    engine: "chromium",
    async close() {
      const active = browserP;
      browserP = null;
      if (active) {
        try { await (await active).close(); } catch { /* already gone */ }
      }
    },
    async open(opts) {
      const browser = await launch();
      const context = await browser.newContext({
        viewport: { width: opts.width, height: opts.height },
        deviceScaleFactor: opts.deviceScaleFactor,
        colorScheme: opts.colorScheme,
        acceptDownloads: false,
        javaScriptEnabled: true,
        serviceWorkers: "block",
      });
      // Popups (target=_blank) navigate the main tab instead of opening a second
      // window. The "page" event also fires for the initial page while
      // newPage() is still pending, so compare against a ref set once it resolves.
      let mainPage: import("playwright-core").Page | null = null;
      let refreshTitle = async (): Promise<void> => {};
      context.on("page", (extra) => {
        if (!mainPage || extra === mainPage) return;
        void (async () => {
          let target = extra.url();
          try {
            await extra.waitForURL((u) => u.toString() !== "about:blank", { timeout: 5000 });
            target = extra.url();
          } catch { /* timed out or navigated away */ }
          try { await extra.close(); } catch { /* already gone */ }
          if (target.startsWith("http://") || target.startsWith("https://")) {
            try {
              await mainPage!.goto(target, { waitUntil: "domcontentloaded" });
              await refreshTitle();
            } catch { /* policy or load failure */ }
          }
        })();
      });
      const page = await context.newPage();
      mainPage = page;
      const listeners = new Set<(ev: DriverPageEvent) => void>();
      const emit = (ev: DriverPageEvent) => { for (const l of [...listeners]) l(ev); };

      // Policy on every main-frame hop, including redirects: the guard throws
      // and the request aborts, so a rebinding redirect never connects.
      await page.route("**/*", async (route) => {
        const req = route.request();
        if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) {
          await route.continue();
          return;
        }
        try {
          await opts.guardNavigation(req.url());
          await route.continue();
        } catch (err) {
          emit({ kind: "navigation", url: req.url(), message: `blocked: ${String((err as Error).message)}` });
          await route.abort("blockedbyclient");
        }
      });
      page.on("console", (msg) => emit({ kind: "console", level: msg.type(), message: msg.text() }));
      page.on("pageerror", (e) => emit({ kind: "console", level: "error", message: String(e) }));
      page.on("download", (dl) => {
        emit({ kind: "download-blocked", url: dl.url(), message: "downloads are blocked" });
        void dl.cancel().catch(() => {});
      });
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) emit({ kind: "navigation", url: frame.url() });
      });
      page.on("crash", () => emit({ kind: "crash", message: "page crashed" }));

      const nav = (): DriverNav => ({ url: page.url(), title: lastTitle });
      let lastTitle = "";
      refreshTitle = async (): Promise<void> => {
        try { lastTitle = await page.title(); } catch { /* navigating */ }
      };

      const locate = (target: BrowserTarget) => {
        if ("selector" in target) return page.locator(target.selector).first();
        if ("text" in target) {
          return page.getByText(target.text, {
            ...(target.exact !== undefined ? { exact: target.exact } : {}),
          }).first();
        }
        if ("role" in target) {
          return page.getByRole(target.role as Parameters<typeof page.getByRole>[0], {
            ...(target.name !== undefined ? { name: target.name } : {}),
            ...(target.exact !== undefined ? { exact: target.exact } : {}),
          }).first();
        }
        return null;
      };

      const driverPage: DriverPage = {
        async goto(url) {
          await page.goto(url, { waitUntil: "domcontentloaded" });
          await refreshTitle();
          return nav();
        },
        async back() {
          await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
          await refreshTitle();
          return nav();
        },
        async forward() {
          await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => null);
          await refreshTitle();
          return nav();
        },
        async reload() {
          await page.reload({ waitUntil: "domcontentloaded" });
          await refreshTitle();
          return nav();
        },
        async stop() {
          // CDP "Page.stopLoading" equivalent: best effort via escape key nav abort
          await page.evaluate(() => window.stop()).catch(() => {});
        },
        async click(target) {
          const loc = locate(target);
          if (loc) { await loc.click(); }
          else if ("point" in target) { await page.mouse.click(target.point.x, target.point.y); }
          await refreshTitle();
          return await page.evaluate(describeHit, { focusedOnly: true }) as JsonObject;
        },
        async point(point) {
          return await page.evaluate(describeHit, { x: point.x, y: point.y }) as JsonObject;
        },
        async type(target, text, submit) {
          const loc = locate(target);
          if (loc) {
            await loc.fill(text);
            if (submit) await loc.press("Enter");
          } else if ("point" in target) {
            await page.mouse.click(target.point.x, target.point.y);
            await page.keyboard.type(text);
            if (submit) await page.keyboard.press("Enter");
          }
          await refreshTitle();
        },
        async press(key) {
          await page.keyboard.press(key);
          return await page.evaluate(describeHit, { focusedOnly: true }) as JsonObject;
        },
        async textRange(start, end) {
          return page.evaluate(({ a, b }) => {
            const caret = (x: number, y: number): Range | null => {
              const doc = document as Document & {
                caretRangeFromPoint?: (x: number, y: number) => Range | null;
                caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
              };
              if (typeof doc.caretRangeFromPoint === "function") return doc.caretRangeFromPoint(x, y);
              const pos = doc.caretPositionFromPoint?.(x, y);
              if (!pos) return null;
              const range = document.createRange();
              range.setStart(pos.offsetNode, pos.offset);
              range.collapse(true);
              return range;
            };
            const startRange = caret(a.x, a.y);
            const endRange = caret(b.x, b.y);
            if (!startRange || !endRange) return { quote: "" };
            const range = document.createRange();
            try {
              range.setStart(startRange.startContainer, startRange.startOffset);
              range.setEnd(endRange.startContainer, endRange.startOffset);
            } catch {
              return { quote: "" };
            }
            if (range.collapsed) {
              try {
                range.setStart(endRange.startContainer, endRange.startOffset);
                range.setEnd(startRange.startContainer, startRange.startOffset);
              } catch {
                return { quote: "" };
              }
            }
            const quote = range.toString().replace(/\s+/g, " ").trim().slice(0, 4_000);
            const rect = range.getBoundingClientRect();
            return {
              quote,
              ...(quote && rect.width + rect.height > 0
                ? {
                  rect: {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                  },
                }
                : {}),
            };
          }, { a: start, b: end });
        },
        async scroll(x, y, target) {
          const loc = target ? locate(target) : null;
          if (loc) await loc.scrollIntoViewIfNeeded();
          else await page.mouse.wheel(x, y);
        },
        async select(target, value) {
          const loc = locate(target);
          if (loc) await loc.selectOption(value);
        },
        async wait(condition, value, timeoutMs) {
          if (condition === "network-idle") await page.waitForLoadState("networkidle", { timeout: timeoutMs ?? 10_000 });
          else if (condition === "selector" && value) await page.waitForSelector(value, { timeout: timeoutMs ?? 10_000 });
        },
        async resize(viewport) {
          await page.setViewportSize(viewport);
        },
        async emulateColorScheme(colorScheme) {
          await page.emulateMedia({ colorScheme });
        },
        async inspect(selector) {
          const loc = page.locator(selector).first();
          await loc.waitFor({ state: "attached" });
          return loc.evaluate((element, queriedSelector) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              selector: queriedSelector,
              tag: element.tagName.toLowerCase(),
              text: (element.textContent ?? "").trim().slice(0, 500),
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
              styles: {
                display: style.display,
                position: style.position,
                color: style.color,
                backgroundColor: style.backgroundColor,
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
                margin: style.margin,
                padding: style.padding,
                border: style.border,
                borderRadius: style.borderRadius,
                opacity: style.opacity,
                overflow: style.overflow,
              },
            };
          }, selector);
        },
        async screenshot() {
          const data = await page.screenshot({ type: "jpeg", quality: 60 });
          return { data: new Uint8Array(data), mime: "image/jpeg" };
        },
        async screenshotClip(clip) {
          const safe = {
            x: Math.max(0, Math.floor(clip.x)),
            y: Math.max(0, Math.floor(clip.y)),
            width: Math.max(1, Math.floor(clip.width)),
            height: Math.max(1, Math.floor(clip.height)),
          };
          const data = await page.screenshot({ type: "jpeg", quality: 70, clip: safe });
          return { data: new Uint8Array(data), mime: "image/jpeg" };
        },
        async queryRegion(region) {
          return page.evaluate((box) => {
            const hits: Array<{
              selector?: string;
              tag?: string;
              role?: string;
              name?: string;
              text?: string;
              attributes?: Record<string, string>;
              bounds?: { x: number; y: number; width: number; height: number };
            }> = [];
            const all = Array.from(document.querySelectorAll("body *")) as HTMLElement[];
            const right = box.x + box.width;
            const bottom = box.y + box.height;
            for (const el of all) {
              const rect = el.getBoundingClientRect();
              if (rect.width < 2 || rect.height < 2) continue;
              if (rect.right < box.x || rect.left > right || rect.bottom < box.y || rect.top > bottom) continue;
              const tag = el.tagName.toLowerCase();
              if (["script", "style", "meta", "link", "noscript"].includes(tag)) continue;
              const role = el.getAttribute("role") || undefined;
              const name = (el.getAttribute("aria-label")
                || (el as HTMLInputElement).labels?.[0]?.textContent
                || el.getAttribute("title")
                || undefined)?.trim().slice(0, 200);
              const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 240);
              const attrs: Record<string, string> = {};
              for (const key of ["id", "name", "type", "href", "placeholder", "aria-label"]) {
                const value = el.getAttribute(key);
                if (value) attrs[key] = value.slice(0, 200);
              }
              let selector = tag;
              if (el.id) selector = `${tag}#${CSS.escape(el.id)}`;
              else if (attrs.class) selector = `${tag}.${CSS.escape(String(el.className).split(/\s+/).filter(Boolean)[0] ?? "")}`;
              hits.push({
                selector,
                tag,
                ...(role ? { role } : {}),
                ...(name ? { name } : {}),
                ...(text ? { text } : {}),
                ...(Object.keys(attrs).length ? { attributes: attrs } : {}),
                bounds: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
              });
              if (hits.length >= 24) break;
            }
            const textBits = hits
              .map((hit) => hit.text || hit.name || "")
              .filter(Boolean)
              .slice(0, 16);
            return {
              elements: hits.slice(0, 12),
              text: textBits.join("\n").slice(0, 4_000),
            };
          }, region);
        },
        async observe(selector) {
          await refreshTitle();
          // innerText excludes input values, so passwords cannot leak this way.
          const root = selector ? page.locator(selector).first() : page.locator("body");
          const text = await root.innerText().catch(() => "");
          let ax = "";
          try {
            ax = await root.ariaSnapshot();
          } catch { /* aria snapshot unsupported/failed */ }
          return { url: page.url(), title: lastTitle, text, accessibilityDigest: ax.slice(0, 4000) };
        },
        current: nav,
        onEvent(cb) {
          listeners.add(cb);
          return () => { listeners.delete(cb); };
        },
        async close() {
          listeners.clear();
          // context teardown wipes cookies/storage/temp state for this session
          await context.close().catch(() => {});
        },
      };
      return driverPage;
    },
  };
}

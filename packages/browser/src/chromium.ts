// Chromium driver on playwright-core. Requires an already-installed Chromium
// executable (POLYTH_CHROMIUM_PATH or a well-known path); never downloads a
// browser. Isolated context: no downloads, popups, permissions, or storage
// reuse. Navigation hops run through the manager's policy guard via routing.
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { BrowserTarget } from "@polyth/contracts";
import type { BrowserDriver, DriverNav, DriverPage, DriverPageEvent } from "./driver.ts";

const CANDIDATE_PATHS = [
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/** Configured or well-known Chromium executable, or null (fallback mode). */
export async function findChromiumExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configured = env.POLYTH_CHROMIUM_PATH;
  const candidates = configured ? [configured] : CANDIDATE_PATHS;
  for (const p of candidates) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch { /* keep looking */ }
  }
  return null;
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
      // No secondary windows: agent/user share exactly one visible page. The
      // "page" event also fires for the initial page while newPage() is still
      // pending, so compare against a ref that is only set once it resolves.
      let mainPage: import("playwright-core").Page | null = null;
      context.on("page", (extra) => {
        if (mainPage && extra !== mainPage) void extra.close().catch(() => {});
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
      const refreshTitle = async (): Promise<void> => {
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
        },
        async point(point) {
          return page.evaluate(({ x, y }) => {
            const element = document.elementFromPoint(x, y);
            if (!(element instanceof Element)) throw new Error(`no element at (${x}, ${y})`);

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
            const attributes = Object.fromEntries(
              ["id", "class", "data-testid", "name", "type", "aria-label", "title"]
                .map((key) => [key, element.getAttribute(key)] as const)
                .filter((entry): entry is readonly [string, string] => entry[1] !== null)
                .map(([key, value]) => [key, value.slice(0, 300)]),
            );
            return {
              selector: selectorFor(element),
              tag,
              ...(role ? { role } : {}),
              ...(name ? { name } : {}),
              text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 500),
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
              attributes,
            };
          }, point);
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

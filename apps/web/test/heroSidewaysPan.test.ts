// The phone's new-chat screen scrolls vertically only, in a real browser with
// the real stylesheets. Reported on an iPhone: a sideways finger drag moved
// the whole hero (title, apps, recent chats) off to the side. The hero's
// pencil is hidden at rest yet still laid out, and its 44px touch hit area
// reached 2px past the hero's inline edge; the vertical scroller around it
// computed `overflow-x: auto`, so that sliver made it scroll — and bounce —
// sideways.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { findChromium } from "./chromium.ts";
import { readWebStylesSync } from "./webStyles.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}

register("./tsxHooks.mjs", import.meta.url);
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { EditIcon, IconButton } = await import("../src/components/ui/index.ts");

const css = readWebStylesSync() + "\n" + readFileSync(resolve(import.meta.dirname, "../src/mobileViewport.css"), "utf8");
// The pencil exactly as HeroCustomizeButton renders it.
const pencil = renderToStaticMarkup(createElement(IconButton, {
  className: "hero-customize-trigger zone-customize-trigger",
  icon: EditIcon,
  size: "sm",
  variant: "ghost",
  label: "Customize new chat",
}));
const rows = ["Cat symptoms: possible causes", "Fix photo attachment issue", "Load is high on Polyth"]
  .map((title) => `<li><button type="button" class="hero-recent-row"><span class="hero-recent-title">${title}</span><span class="hero-recent-time">2h</span></button></li>`)
  .join("");
const apps = Array.from({ length: 6 }, (_, index) =>
  `<li><button type="button" class="hero-app" aria-label="App ${index}"><span class="hero-app-tile"></span></button></li>`).join("");

let browser: Browser | null = null;
before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    ...(process.getuid?.() === 0 ? { args: ["--no-sandbox"] } : {}),
  });
});
after(async () => { await browser?.close(); });

test("a sideways finger drag never pans the phone's new-chat screen", { skip: !CHROME }, async () => {
  assert.ok(browser);
  const page = await browser.newPage({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true });
  await page.route("**/*", (route) => route.abort());
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
      <style>${css}</style></head>
      <body data-keyboard="closed"><div id="root"><div class="app mode-chat view-session"><div class="app-shell"><div class="workspace"><main class="main">
        <div class="stage stage-new"><div class="hero">
          <div class="hero-body customize-zone">
            <h2>Let’s have some fun in <span class="polyth-gradient">Polyth</span>.</h2>
            <div class="hero-widget-host">
              <section class="hero-widget hero-widget-apps" style="order: 0"><ul class="hero-apps" data-labels="false">${apps}</ul></section>
              <section class="hero-widget hero-widget-recent" style="order: 1"><div class="hero-recent" data-size="md"><ul style="--hero-recent-rows: 3">${rows}</ul></div></section>
            </div>
            ${pencil}
          </div>
          <div class="hero-dock"><div class="composer composer-chat composer-mobile composer-collapsed"><div class="composer-card"></div></div></div>
        </div></div>
      </main></div></div></div></div></body></html>`);

    const scrollers = await page.evaluate(() => [".hero-body", ".hero-recent ul", ".hero-dock"].map((selector) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const style = getComputedStyle(element);
      return { selector, overflowX: style.overflowX, overflowY: style.overflowY };
    }));
    for (const { selector, overflowX, overflowY } of scrollers) {
      assert.equal(overflowY, "auto", `${selector} still scrolls vertically`);
      assert.equal(overflowX, "hidden", `${selector} never scrolls sideways`);
    }

    // A finger drags from right to left across the title, as on the phone.
    const title = await page.evaluate(() => {
      const rect = document.querySelector(".hero-body > h2")!.getBoundingClientRect();
      return { x: rect.right - 20, y: rect.top + rect.height / 2 };
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [title] });
    for (let step = 1; step <= 12; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: title.x - step * 15, y: title.y }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(100);
    const offsets = await page.evaluate(() => ({
      hero: document.querySelector<HTMLElement>(".hero-body")!.scrollLeft,
      document: document.scrollingElement!.scrollLeft,
    }));
    assert.deepEqual(offsets, { hero: 0, document: 0 }, "the screen stays where it is");
  } finally {
    await page.close();
  }
});

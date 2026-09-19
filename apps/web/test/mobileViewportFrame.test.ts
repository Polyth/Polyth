import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";

const read = (name: string) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
// Set POLYTH_CHROMIUM_PATH for a system browser. A local Playwright
// installation also works; this test never downloads a browser.
const executablePath = process.env.POLYTH_CHROMIUM_PATH || chromium.executablePath();
const available = await access(executablePath, constants.X_OK).then(() => true, () => false);
if (!available && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("Mobile viewport tests require an installed Chromium (POLYTH_CHROMIUM_PATH).");
}
let browser: Browser;
let css: string;
before(async () => {
  css = (await Promise.all([
    "tokens.css", "styles.css", "composerAdaptive.css", "mobileViewport.css",
  ].map(read))).join("\n").replace(/@import[^;]+;/g, "");
  if (available) browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); });

const composer = `<div class="composer composer-simple composer-chat composer-focus-light composer-mobile composer-collapsed">
  <div class="composer-card glass-dock">
    <div class="composer-input"><textarea class="composer-editor" rows="1" placeholder="Message Polyth…"></textarea></div>
    <div class="composer-rail">
      <span class="composer-leading-zone customize-zone">
        <div class="composer-add"><button class="composer-add-trigger" aria-label="Add">+</button></div>
        <span class="composer-extensions composer-mobile-extensions"><span class="placed-mini-widget"><button class="mic-btn" aria-label="Microphone">Mic</button></span></span>
      </span>
      <span class="composer-execution"><span class="picker picker-model"><span class="model-picker"><button class="config-chip model-picker-trigger"><span class="model-trigger-name">Cursor</span></button></span></span></span>
      <div class="composer-actions customize-zone"><span class="composer-extensions"></span><div class="composer-config"></div><span class="composer-primary"><button class="send" aria-label="Send">Send</button></span></div>
    </div>
  </div>
</div>`;

async function fixture(page: Page, session: boolean, desktop = false, standaloneCascade = false) {
  // Chromium cannot emulate an installed iOS WebView. Activate only the
  // existing WebKit/standalone CSS guards to test their cascade precedence,
  // not to claim WebKit engine or physical-device coverage.
  const sheet = standaloneCascade
    ? css.replaceAll("@supports (-webkit-touch-callout: none)", "@supports (display: block)")
      .replaceAll("@media (display-mode: standalone)", "@media screen")
    : css;
  const surface = session
    ? `<div class="focus-conversation"><div class="timeline-wrap"><div class="timeline">Conversation</div></div><div class="conversation-composer-dock">${composer}</div></div>`
    : `<div class="stage stage-new"><div class="hero"><div class="hero-body"><h2>New chat</h2></div><div class="hero-dock"><div class="session-context-bar">Polyth · master · Isolate</div>${composer}</div></div></div>`;
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${sheet}</style><body class="${desktop ? "desktop-app" : ""}"><div id="root"><div class="app mode-chat view-session"><div class="app-shell"><div class="workspace"><main class="main">${surface}</main></div></div></div></div></body>`);
  await page.evaluate(() => {
    const html = document.documentElement;
    html.dataset.background = "custom";
    html.style.setProperty("--bg", "#ffffff");
    html.style.setProperty("--text", "#222222");
    html.style.setProperty("--app-system-bar-color", "#00ff00");
    html.style.setProperty("--app-background-image", "linear-gradient(#112233, #445566)");
    html.style.setProperty("--safe-top", "47px");
    html.style.setProperty("--safe-bottom", "34px");
    document.body.dataset.keyboard = "closed";
    document.body.dataset.band = "tall";
  });
}

async function measure(page: Page, height: number, offset: number, keyboard: boolean) {
  await page.evaluate(({ height, offset, keyboard }) => {
    const root = document.documentElement;
    root.style.setProperty("--visual-vh", `${height}px`);
    root.style.setProperty("--visual-offset", `${offset}px`);
    root.style.setProperty("--visual-bottom", `${height + offset}px`);
    root.style.setProperty("--keyboard-inset", keyboard ? "300px" : "0px");
    document.body.dataset.keyboard = keyboard ? "open" : "closed";
    document.body.dataset.band = height < 420 ? "short" : "tall";
    document.querySelector(".composer")!.classList.toggle("composer-expanded", keyboard);
    document.querySelector(".composer")!.classList.toggle("composer-collapsed", !keyboard);
  }, { height, offset, keyboard });
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { top: r.top, bottom: r.bottom, height: r.height, reachable: hit === element || element.contains(hit) };
    };
    const paint = getComputedStyle(document.documentElement, "::before");
    return {
      app: rect(".app"), card: rect(".composer-card"), send: rect(".send"), editor: rect("textarea"),
      rootMinHeight: getComputedStyle(document.getElementById("root")!).minHeight,
      paintHeight: Number.parseFloat(paint.height), paintImage: paint.backgroundImage,
      paintPointerEvents: paint.pointerEvents, scrollHeight: document.documentElement.scrollHeight,
    };
  });
}

// Unlike CSS-string assertions, these cases run the real shell cascade with a
// measured viewport that disagrees with the browser's CSS viewport units.
for (const session of [false, true]) for (const standaloneCascade of [false, true]) {
  test(`${standaloneCascade ? "standalone cascade" : "browser"}: ${session ? "existing" : "new"} chat follows the visible bottom through keyboard and orientation changes`, { skip: !available }, async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      await fixture(page, session, false, standaloneCascade);
      for (const [height, offset, keyboard] of [
        [790, 0, false], [844, 0, false], [440, 0, true],
        [360, 150, true], [844, 0, false],
      ] as const) {
        const g = await measure(page, height, offset, keyboard);
        const bottom = height + offset;
        assert.equal(g.app.bottom, bottom, "viewport measurements, not 100vh/100dvh, own the flex frame");
        assert.equal(g.rootMinHeight, "0px", "a root min-height cannot undo the measured frame");
        assert.equal(bottom - g.card.bottom, keyboard ? (session ? 4 : 8) : 34, "one home-indicator clearance or the existing optical keyboard gap");
        assert.ok(g.editor.top >= offset && g.editor.bottom <= bottom, "the editor fits in the visible band");
        assert.ok(g.send.top >= offset && g.send.bottom <= bottom, "the complete Send target fits");
        assert.ok(g.send.reachable && g.editor.reachable, "the controls are not covered or clipped");
        assert.equal(g.paintHeight, 844, "keyboard geometry never resizes the wallpaper");
        assert.equal(g.paintPointerEvents, "none");
        assert.ok(g.paintImage.includes("linear-gradient"));
        assert.equal(g.scrollHeight, 844, "decorative paint must not extend document scroll range");
      }
      await page.setViewportSize({ width: 844, height: 390 });
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--safe-top", "0px");
        document.documentElement.style.setProperty("--safe-bottom", "21px");
      });
      const landscape = await measure(page, 390, 0, false);
      assert.equal(landscape.app.bottom, 390);
      assert.ok(landscape.send.reachable && landscape.send.bottom <= 390);
    } finally { await page.close(); }
  });
}

test("wallpaper paints the exposed bottom canvas, not a second app-sized image or theme tint", { skip: !available }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await fixture(page, false);
    await measure(page, 600, 0, false);
    await page.evaluate(() => {
      // The page canvas is taller than the flow/root box, as in the reported
      // standalone gap. A background on that box alone must not pass.
      for (const selector of ["html", "body", "#root"]) {
        document.querySelector<HTMLElement>(selector)!.style.height = "600px";
      }
    });
    const backgrounds = await page.evaluate(() => Object.fromEntries(["html", "body", ".app"].map((selector) => [selector, getComputedStyle(document.querySelector(selector)!).backgroundImage])));
    assert.deepEqual(backgrounds, { html: "none", body: "none", ".app": "none" });
    const before = await page.screenshot({ clip: { x: 20, y: 820, width: 1, height: 1 } });
    // Compare the actual bottom pixel against the exact same composed material
    // placed over it. Equality proves the exposed canvas is painted, not just
    // that a background-image string happens to be present in the stylesheet.
    await page.evaluate(() => {
      const reference = document.createElement("div");
      reference.id = "paint-reference";
      const paint = getComputedStyle(document.documentElement, "::before");
      reference.style.cssText = `position:fixed;inset:0;z-index:2147483647;pointer-events:none;background-color:${paint.backgroundColor};background-image:${paint.backgroundImage};background-size:${paint.backgroundSize};background-position:${paint.backgroundPosition};background-repeat:${paint.backgroundRepeat};`;
      document.body.append(reference);
    });
    const reference = await page.screenshot({ clip: { x: 20, y: 820, width: 1, height: 1 } });
    assert.deepEqual(before, reference, "the bottom pixel matches the wallpaper rather than the system-bar fallback");
    await page.evaluate(() => { document.getElementById("paint-reference")!.remove(); document.documentElement.dataset.background = "none"; });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement, "::before").content), "none", "None removes the decorative layer");
    await page.evaluate(() => { document.documentElement.dataset.background = "signal-bloom"; });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement, "::before").position), "fixed", "changing presets restores the same canvas");
  } finally { await page.close(); }
});

test("desktop and Electron keep their original frame and background ownership", { skip: !available }, async () => {
  for (const [width, desktop] of [[1280, false], [390, true]] as const) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    try {
      await fixture(page, false, desktop);
      const g = await measure(page, 600, 0, false);
      assert.equal(g.app.bottom, 844);
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement, "::before").content), "none");
    } finally { await page.close(); }
  }
});

test("the measured frame sheet is loaded after the base shell and composer styles", async () => {
  const entry = await read("main.tsx");
  const viewport = entry.indexOf('import "./mobileViewport.css"');
  assert.ok(viewport > entry.indexOf('import "./styles.css"'));
  assert.ok(viewport > entry.indexOf('import "./composerAdaptive.css"'));
  const geometry = await read("mobileViewport.css");
  assert.doesNotMatch(geometry, /height:\s*calc\([^;]*--keyboard-inset/, "already-visible height is not reduced twice");
});

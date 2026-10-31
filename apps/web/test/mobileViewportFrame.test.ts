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
  await page.evaluate((webkit) => {
    const html = document.documentElement;
    if (webkit) html.dataset.fixtureWebkit = "true";
    // desktop.tsx marks the document root with the body class.
    if (document.body.classList.contains("desktop-app")) html.dataset.desktopApp = "true";
    html.dataset.background = "custom";
    html.style.setProperty("--bg", "#ffffff");
    html.style.setProperty("--text", "#222222");
    html.style.setProperty("--app-system-bar-color", "#00ff00");
    html.style.setProperty("--app-background-image", "linear-gradient(#112233, #445566)");
    html.style.setProperty("--safe-top", "47px");
    html.style.setProperty("--safe-bottom", "34px");
    document.body.dataset.keyboard = "closed";
    document.body.dataset.band = "tall";
  }, standaloneCascade);
  // The dock's entrance has played out long before anyone opens the keyboard.
  // Sampling it mid-flight made the first measurement depend on host load;
  // only motion the keyboard itself starts (a replayed entrance) may show here.
  await page.evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
}

/** Read one rendered pixel: screenshot in Node, decode it with the browser's
 *  own PNG decoder. A root background IMAGE only paints inside the root box,
 *  so the exposed band below a short frame is a paint fact, not a computed
 *  style. */
async function samplePixel(page: Page, x: number, y: number): Promise<number[]> {
  const shot = (await page.screenshot({ clip: { x, y, width: 1, height: 1 }, type: "png" })).toString("base64");
  return page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
  }, shot);
}

async function measure(page: Page, height: number, offset: number, keyboard: boolean, pageTop = offset) {
  await page.evaluate(({ height, offset, keyboard, pageTop }) => {
    const root = document.documentElement;
    root.style.setProperty("--visual-vh", `${height}px`);
    root.style.setProperty("--visual-offset", `${offset}px`);
    // Closed-state browser chrome is a residual visual reduction, not a
    // covered frame. The runtime publishes layoutHeight in that state.
    // pageTop is a document-coordinate pan and must not become frame height.
    root.style.setProperty("--visual-frame-top", `${keyboard ? offset : 0}px`);
    root.style.setProperty("--visual-frame-height", `${keyboard ? height : window.innerHeight}px`);
    root.style.setProperty("--visual-frame-bottom", `${keyboard ? height + offset : window.innerHeight}px`);
    root.style.setProperty("--visual-bottom", `${keyboard ? height + offset : window.innerHeight}px`);
    root.style.setProperty("--keyboard-inset", keyboard ? "300px" : "0px");
    // mobileViewport.ts publishes the shared lower edge itself: the frame
    // bottom, plus WebKit's form-accessory band while the keyboard is open in
    // a compact Safari frame (never in the native shell). The fixture's
    // WebKit stand-in is the activated `@supports` guard; the band is the
    // token the runtime reads.
    const webkit = document.documentElement.dataset.fixtureWebkit === "true";
    const native = document.body.dataset.keyboardSource === "native";
    const band = webkit && keyboard && !native
      ? Number.parseFloat(getComputedStyle(root).getPropertyValue("--keyboard-accessory-band")) || 0
      : 0;
    root.style.setProperty("--layer-frame-bottom", `${(keyboard ? height + offset : window.innerHeight) + band}px`);
    root.dataset.keyboardFrame = keyboard ? "open" : "closed";
    document.body.dataset.keyboard = keyboard ? "open" : "closed";
    document.body.dataset.band = height < 420 ? "short" : "tall";
    document.querySelector(".composer")!.classList.toggle("composer-expanded", keyboard);
    document.querySelector(".composer")!.classList.toggle("composer-collapsed", !keyboard);
  }, { height, offset, keyboard, pageTop });
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const r = element.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { top: r.top, bottom: r.bottom, height: r.height, reachable: hit === element || element.contains(hit) };
    };
    const root = getComputedStyle(document.documentElement);
    return {
      root: rect("#root"), app: rect(".app"), card: rect(".composer-card"), send: rect(".send"), editor: rect("textarea"),
      rootMinHeight: getComputedStyle(document.getElementById("root")!).minHeight,
      rootPosition: getComputedStyle(document.getElementById("root")!).position,
      htmlOverflowY: getComputedStyle(document.documentElement).overflowY,
      htmlPosition: getComputedStyle(document.documentElement).position,
      bodyPosition: getComputedStyle(document.body).position,
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      innerHeight: window.innerHeight,
      rootBackgroundImage: root.backgroundImage, rootBackgroundColor: root.backgroundColor,
      scrollHeight: document.documentElement.scrollHeight,
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
      for (const [height, offset, keyboard, pageTop] of [
        [790, 0, false, 0], [844, 0, false, 0], [440, 0, true, 220],
        [360, 150, true, 210], [844, 0, false, 0],
      ] as const) {
        const g = await measure(page, height, offset, keyboard, pageTop);
        // The frame is an in-flow box at the document origin. It may grow to
        // the visual viewport's panned bottom edge (`offsetTop + height`) while
        // the keyboard is open — otherwise the band Safari pans to would paint
        // the canvas — but never from the document-level `pageTop`/scrollY.
        const viewportHeight = await page.evaluate(() => window.innerHeight);
        const frameBottom = keyboard ? height + offset : viewportHeight;
        // WebKit hides its own text-input accessory inside the keyboard frame it
        // reports, so on WebKit the open keyboard frame carries one accessory
        // band on top of the measured visual bottom. This fixture activates the
        // WebKit guard, so that band is expected here and only here.
        const accessoryBand = keyboard && standaloneCascade ? 48 : 0;
        const bottom = frameBottom + accessoryBand;
        assert.equal(g.root.top, 0, "the frame starts at the document origin, never at a pan offset");
        assert.equal(g.root.bottom, frameBottom + accessoryBand, "the mobile root follows the bounded visual frame");
        assert.equal(g.root.height, frameBottom + accessoryBand, "the mobile root cannot grow from document pan");
        assert.equal(g.app.height, frameBottom + accessoryBand, "the app shares the bounded visual frame");
        assert.equal(g.app.bottom, bottom, "viewport measurements, not 100vh/100dvh, own the flex frame");
        assert.equal(
          g.rootMinHeight,
          !keyboard && standaloneCascade ? `${viewportHeight}px` : "0px",
          standaloneCascade
            ? "the installed web app fills the layout viewport while the keyboard is closed"
            : "a root min-height cannot undo the measured frame",
        );
        assert.equal(g.htmlOverflowY, "clip", "the document cannot remain a Safari scroll container behind the keyboard");
        assert.equal(g.bodyOverflowY, "clip", "the body cannot become a second Safari scroll root");
        // Measured on iOS 26: Safari keeps the containing block of a fixed box
        // at the LARGE viewport, which the keyboard does not shrink. A fixed
        // html/body with `height: 100%` stayed 775px against a 428px keyboard
        // viewport, created 347px of scroll range and let Safari pan the whole
        // shell off the top. Every box in the frame chain stays in flow.
        assert.equal(g.htmlPosition, "static", "the document chain must not be position:fixed");
        assert.equal(g.bodyPosition, "static", "the document chain must not be position:fixed");
        assert.equal(g.rootPosition, "static", "the measured frame must not be position:fixed");
        assert.equal(bottom - g.card.bottom, keyboard ? (session ? 4 : 8) : 34, "one home-indicator clearance or the existing optical keyboard gap");
        assert.ok(g.editor.top >= 0 && g.editor.bottom <= bottom, "the editor fits in the visible band");
        assert.ok(g.send.top >= 0 && g.send.bottom <= bottom, "the complete Send target fits");
        assert.ok(g.send.reachable && g.editor.reachable, "the controls are not covered or clipped");
        assert.ok(g.rootBackgroundImage.includes("linear-gradient"), "the root keeps owning the selected wallpaper");
        assert.ok(g.scrollHeight <= g.innerHeight, `the document must have no scroll range for a focused editor to pan (${g.scrollHeight} > ${g.innerHeight})`);
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

test("wallpaper remains rooted on the HTML canvas when the app frame changes", { skip: !available }, async () => {
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
    const backgrounds = await page.evaluate(() => Object.fromEntries(["html", "body", ".app"].map((selector) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return [selector, { image: style.backgroundImage, color: style.backgroundColor }];
    })));
    assert.ok(backgrounds.html, "HTML background measurement is present");
    assert.ok(backgrounds.body, "body background measurement is present");
    assert.ok(backgrounds[".app"], "app background measurement is present");
    assert.match(backgrounds.html.image, /linear-gradient/);
    assert.equal(backgrounds.html.color, "rgb(0, 255, 0)", "the selected system-bar fallback remains painted by HTML");
    assert.equal(backgrounds.body.image, "none");
    assert.equal(backgrounds[".app"].image, "none");
  } finally { await page.close(); }
});

test("the wallpaper keeps painting the band below a keyboard-short measured frame", { skip: !available }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await fixture(page, true);
    await page.evaluate(() => {
      // Keep the tinted scrim out of the sample so the pixel is the wallpaper
      // itself; the canvas colour stays the system-bar fallback underneath.
      document.documentElement.style.setProperty("--bg", "transparent");
    });
    // A keyboard-open measured frame: the visible band ends well above the
    // page area the OS still leaves to the page, so the root box is shorter
    // than the viewport that has to be painted.
    const g = await measure(page, 440, 0, true, 0);
    assert.ok(g.app.bottom < 844 - 100, "the fixture runs a frame shorter than the viewport");
    const layer = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement, "::before");
      return {
        position: style.position, top: style.top, height: Number.parseFloat(style.height),
        zIndex: style.zIndex, pointerEvents: style.pointerEvents, image: style.backgroundImage,
        attachment: style.backgroundAttachment,
        rootImage: getComputedStyle(document.documentElement).backgroundImage,
        scrollHeight: document.documentElement.scrollHeight,
      };
    });
    // iOS WebKit ignores `background-attachment: fixed`, so the band must not
    // depend on it: the layer repaints the root's own wallpaper over a static
    // large-viewport box, scrolled-attachment like every WebKit paint.
    assert.equal(layer.position, "fixed");
    assert.equal(layer.top, "0px");
    assert.ok(layer.height >= 844, `the wallpaper layer covers the large viewport (got ${layer.height})`);
    assert.equal(layer.zIndex, "-1");
    assert.equal(layer.pointerEvents, "none");
    assert.equal(layer.image, layer.rootImage, "the layer repaints the root's own wallpaper");
    assert.ok(layer.attachment.split(", ").every((value) => value === "scroll"));
    assert.ok(layer.scrollHeight <= 844, "the layer adds no scrollable overflow");
    const bandY = Math.round(g.app.bottom) + 60;
    const band = await samplePixel(page, 195, bandY);
    assert.ok(
      band[1]! < 160 && band[2]! > band[0]!,
      `the exposed band paints the selected wallpaper (got ${band.join(", ")})`,
    );

    // Causal control: without the layer the same fixture falls back to the
    // flat canvas colour (with the keyboard open, the wallpaper's edge tone —
    // see the next test), which is exactly the strip reported from a phone.
    await page.addStyleTag({ content: "html[data-background]::before{display:none !important}" });
    const fallback = await samplePixel(page, 195, bandY);
    assert.ok(
      !(fallback[1]! < 160 && fallback[2]! > fallback[0]!),
      `without the wallpaper layer the band is not painted by the wallpaper (got ${fallback.join(", ")})`,
    );
  } finally { await page.close(); }
});

test("the band below the document takes the wallpaper's bottom-edge tone while the keyboard is open", { skip: !available }, async () => {
  // iOS Safari fills the band between the end of the document and the
  // keyboard (address bar + form assistant) with the root's flat colour; no
  // layer can paint there. Measured on a device as a system-bar strip.
  const rootColor = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await fixture(page, true);
    await page.evaluate(() => document.documentElement.style.setProperty("--app-background-edge-color", "#000000"));
    await measure(page, 440, 0, false);
    assert.equal(await rootColor(page), "rgb(0, 255, 0)", "closed: the system-bar colour stays for the status strip");
    await measure(page, 440, 0, true);
    // Tinted exactly as the wallpaper is: 76% of --bg over the image tone.
    assert.match(await rootColor(page), /^(rgb\(194, 194, 194\)|color\(srgb 0\.76 0\.76 0\.76\))$/);
    // The layer above inherits the colour but still paints the image itself.
    const layer = await page.evaluate(() => getComputedStyle(document.documentElement, "::before").backgroundImage);
    assert.match(layer, /linear-gradient/);
    // Without a sampled tone (a custom image that could not be read) the band
    // falls back to the theme colour, never the system-bar tint.
    await page.evaluate(() => document.documentElement.style.removeProperty("--app-background-edge-color"));
    assert.match(await rootColor(page), /^(rgb\(255, 255, 255\)|color\(srgb 1 1 1\))$/);
    // "None" keeps its own flat theme root.
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--app-background-edge-color", "#000000");
      document.documentElement.dataset.background = "none";
    });
    assert.doesNotMatch(await rootColor(page), /194|0\.76/);
  } finally { await page.close(); }
});

test("desktop and Electron keep their original frame and background ownership", { skip: !available }, async () => {
  for (const [width, desktop] of [[1280, false], [390, true]] as const) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    try {
      await fixture(page, false, desktop);
      const g = await measure(page, 600, 0, false);
      assert.equal(g.app.bottom, 844);
      const owner = await page.evaluate(() => ({
        html: getComputedStyle(document.documentElement).backgroundImage,
        app: getComputedStyle(document.querySelector(".app")!).backgroundImage,
      }));
      assert.ok((desktop ? owner.app : owner.html).includes("linear-gradient"));
    } finally { await page.close(); }
  }
});

test("tablet root and app share the measured keyboard frame", { skip: !available }, async () => {
  const page = await browser.newPage({ viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true });
  try {
    await fixture(page, true);
    for (const [height, offset, keyboard] of [[1024, 0, false], [620, 0, true], [520, 80, true]] as const) {
      const g = await measure(page, height, offset, keyboard);
      const frameBottom = keyboard ? height + offset : 1024;
      assert.equal(g.root.height, frameBottom);
      assert.equal(g.app.height, frameBottom);
      assert.equal(g.root.top, 0, "a pan offset never displaces the in-flow frame");
      assert.equal(g.root.bottom, g.app.bottom);
      assert.ok(g.scrollHeight <= 1024, "the measured frame does not create document overflow");
    }
  } finally { await page.close(); }
});

test("the measured frame sheet is loaded after the base shell and composer styles", async () => {
  const entry = await read("main.tsx");
  const viewport = entry.indexOf('import "./mobileViewport.css"');
  assert.ok(viewport > entry.indexOf('import "./styles.css"'));
  assert.ok(viewport > entry.indexOf('import "./composerAdaptive.css"'));
  const geometry = await read("mobileViewport.css");
  assert.doesNotMatch(geometry, /height:\s*calc\([^;]*--keyboard-inset/, "already-visible height is not reduced twice");
});

test("the WebKit text-input accessory band is added to the frame only on WebKit", { skip: !available }, async () => {
  // WebKit hides its own text-input accessory (the floating form assistant)
  // inside the keyboard frame iOS reports, so the measured visual band ends
  // above the space the OS still leaves visible and the composer floated that
  // difference above the keyboard. The band is added while the keyboard is open
  // and only where the WebKit guard is active: an engine that resizes the
  // layout viewport with the keyboard already ends the frame at the keyboard.
  const measured = 440;
  for (const [standaloneCascade, expected] of [[false, measured], [true, measured + 48]] as const) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      await fixture(page, true, false, standaloneCascade);
      const g = await measure(page, measured, 0, true);
      assert.equal(
        g.app.bottom,
        expected,
        standaloneCascade
          ? "the open keyboard frame carries one accessory band on WebKit"
          : "an engine outside the WebKit guard keeps the measured frame",
      );
      assert.equal(g.card.bottom, expected - 4, "the composer follows the extended frame");
      assert.ok(g.send.bottom <= expected, "the primary action stays inside the frame");
    } finally { await page.close(); }
  }
  // Causal control: the band is a single token the runtime reads, so it is
  // the knob to re-measure on a new iOS keyboard/accessory design.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await fixture(page, true, false, true);
    await page.evaluate(() => document.documentElement.style.setProperty("--keyboard-accessory-band", "0px"));
    const g = await measure(page, measured, 0, true);
    assert.equal(g.app.bottom, measured, "a zero band restores the plain measured frame");
  } finally { await page.close(); }
});

test("the native app's keyboard frame carries no accessory band", { skip: !available }, async () => {
  // The Capacitor shell is WebKit, but its keyboard plugin hides the form
  // accessory and resizes the WebView to end at the keyboard. The band pushed
  // the composer's lower rail under the iOS keyboard there.
  const measured = 504;
  const page = await browser.newPage({ viewport: { width: 430, height: measured }, isMobile: true, hasTouch: true });
  try {
    for (const session of [false, true]) {
      await fixture(page, session, false, true);
      await page.evaluate(() => { document.body.dataset.keyboardSource = "native"; });
      const g = await measure(page, measured, 0, true);
      assert.equal(g.app.bottom, measured, "the app ends at the native keyboard edge");
      assert.ok(g.send.bottom <= measured, "the send action stays above the keyboard");
      assert.ok(g.card.bottom <= measured, "the composer card stays above the keyboard");
      assert.equal(g.scrollHeight, measured, "no scroll range below the resized WebView");
      const layerBottom = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.cssText = "position:fixed;top:0;left:0;width:1px;height:var(--layer-frame-bottom)";
        document.body.append(probe);
        return probe.getBoundingClientRect().bottom;
      });
      assert.equal(layerBottom, measured, "full-height layers share the unextended frame");
    }
  } finally { await page.close(); }
});

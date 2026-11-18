import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";

// iOS 26+ Safari lays a soft blurred band under the status bar that reaches
// into the page; it blurred the top half of the phone shell's floating
// islands in the browser (the native app hides it in SceneDelegate.swift).
// Safari drops the band only when WebKit hands it a colour for a fixed top
// edge. This replays WebKit's search for that colour
// (LocalFrameView::fixedContainerEdges) on the real shell cascade in
// Chromium. It proves the page gives WebKit the signal; it is not a WebKit
// engine or device test.

const read = (name: string) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
const executablePath = process.env.POLYTH_CHROMIUM_PATH || chromium.executablePath();
const available = await access(executablePath, constants.X_OK).then(() => true, () => false);
if (!available && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("Phone top edge tests require an installed Chromium (POLYTH_CHROMIUM_PATH).");
}

const IOS_GATE = "@supports (-webkit-touch-callout: none)";
let browser: Browser;
let css: string;
before(async () => {
  css = (await Promise.all([
    "tokens.css", "styles.css", "composerAdaptive.css", "motion.css", "surfaceMotion.css", "mobileViewport.css",
    "fluentTheme.css", "macosTheme.css", "liquidGlassTheme.css", "shellLayout.css", "shellLooks.css",
  ].map(read))).join("\n").replace(/@import[^;]+;/g, "");
  if (available) browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => { await browser?.close(); });

const icon = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2"/></svg>`;
// The phone branch of Header.tsx: the strip, then MobileSessionHeader's row,
// as direct children of `.app`, above a conversation that scrolls under them.
const floats = `<div class="mobile-session-floats" data-title-mode="island">
  <div class="ui-glass-island ui-glass-chrome mobile-float-navigation"><button class="ui-icon-btn" aria-label="Open navigation">${icon}</button></div>
  <div class="ui-glass-island ui-glass-chrome mobile-session-title-island"><div class="mobile-session-title-row"><button class="mobile-session-selector"><span class="mobile-island-text"><span class="mobile-island-title-text">A chat</span></span></button></div></div>
  <div class="ui-glass-island ui-glass-chrome mobile-float-actions"><button class="ui-icon-btn" aria-label="New chat">${icon}</button><button class="ui-icon-btn" aria-label="Menu">${icon}</button></div>
</div>`;

type Fixture = { strip: boolean; look?: string; ios?: boolean; native?: boolean; wallpaper?: string };

async function fixture(page: Page, { strip, look, ios = true, native = false, wallpaper }: Fixture) {
  // Chromium has no -webkit-touch-callout; opening the gate stands in for iOS.
  const sheet = ios ? css.replaceAll(IOS_GATE, "@supports (display: block)") : css;
  assert.ok(!ios || sheet !== css, "styles.css still gates the strip on iOS WebKit");
  const lines = Array.from({ length: 60 }, (_, i) => `<p>Message line ${i + 1}: the conversation scrolls under the islands.</p>`).join("");
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${sheet}</style>`
    + `<body${look ? ` data-shell-look="${look}"` : ""}${native ? ` data-native-platform="ios"` : ""}><div id="root"><div class="app mode-chat view-session">`
    + `${strip ? `<div class="phone-top-edge" aria-hidden="true"></div>` : ""}${floats}`
    + `<div class="app-shell"><div class="workspace"><main class="main"><div class="focus-conversation"><div class="timeline-wrap"><div class="timeline-viewport"><div class="timeline">${lines}</div></div></div></div></main></div></div>`
    + `</div></div></body>`);
  await page.evaluate((systemBar) => {
    const html = document.documentElement;
    html.style.setProperty("--bg", "#ffffff");
    html.style.setProperty("--text", "#222222");
    if (systemBar) {
      html.dataset.background = "wallpaper";
      html.style.setProperty("--app-system-bar-color", systemBar);
    }
    // Portrait Safari exposes no top inset (WebKit bug 306465): the layout
    // viewport starts under the status bar, which is the obscured inset.
    html.style.setProperty("--safe-top", "0px");
    for (const animation of document.getAnimations()) animation.finish();
  }, wallpaper ?? null);
}

/** WebKit's fixed-edge search for the top side: hit-test the middle of the
 *  edge 4px down, ignoring `pointer-events`, then walk up to the first fixed
 *  or sticky box at least 90% of the viewport wide and under 105% of its
 *  height that is not hidden or transparent. A backdrop filter on that walk
 *  makes the edge "multiple colours", which hands Safari no colour, so it
 *  keeps its band; otherwise the edge takes the walk's solid fill (boxes over
 *  10px each way). `colour` is what Safari gets, null when it gets none. */
async function topEdge(page: Page) {
  return page.evaluate(() => {
    const ignorePointerEvents = document.createElement("style");
    ignorePointerEvents.textContent = "* { pointer-events: auto !important; }";
    document.head.append(ignorePointerEvents);
    const hit = document.elementFromPoint(window.innerWidth / 2, 4);
    ignorePointerEvents.remove();
    const visibleFill = (color: string) => color !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(color);
    let backdrop = false;
    let fill: string | null = null;
    for (let element = hit; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const hasBackdrop = style.backdropFilter !== "none";
      const hasFill = visibleFill(style.backgroundColor) && rect.width > 10 && rect.height > 10;
      const transparent = Number(style.opacity) < 0.1 || style.visibility === "hidden"
        || (!hasFill && style.backgroundImage === "none" && !hasBackdrop && element.children.length === 0 && !element.textContent);
      if (!transparent) {
        backdrop ||= hasBackdrop;
        if (hasFill && rect.width >= window.innerWidth * 0.9) fill ??= style.backgroundColor;
      }
      const fixed = style.position === "fixed" || style.position === "sticky";
      if (fixed && !transparent && rect.width >= window.innerWidth * 0.9 && rect.height < window.innerHeight * 1.05) {
        return { hit: hit?.className ?? null, container: String(element.className), colour: backdrop ? null : fill };
      }
    }
    return { hit: hit?.className ?? null, container: null, colour: null };
  });
}

const phone = () => browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test("without the strip WebKit finds no fixed top edge, so Safari keeps its blurred band over the islands", { skip: !available }, async () => {
  const page = await phone();
  try {
    await fixture(page, { strip: false });
    const islands = await page.evaluate(() => document.querySelector(".mobile-float-navigation")!.getBoundingClientRect().top);
    assert.ok(islands > 4, "the islands start below WebKit's sample point");
    const edge = await topEdge(page);
    assert.equal(edge.colour, null, `the top edge reads as scrolling content (${JSON.stringify(edge)})`);
  } finally { await page.close(); }
});

for (const look of [undefined, "obsidian", "air", "paper"]) {
  test(`the strip hands WebKit the page colour for the top edge${look ? ` (${look} look)` : ""}`, { skip: !available }, async () => {
    const page = await phone();
    try {
      await fixture(page, { strip: true, look });
      const edge = await topEdge(page);
      assert.match(edge.container ?? "", /\bphone-top-edge\b/, `the hit test lands in the strip (${JSON.stringify(edge)})`);
      assert.equal(edge.colour, "rgb(255, 255, 255)", "the strip's solid --bg fill is the edge colour");
    } finally { await page.close(); }
  });
}

test("over a wallpaper the strip takes the canvas colour Safari shows under the status bar", { skip: !available }, async () => {
  const page = await phone();
  try {
    await fixture(page, { strip: true, wallpaper: "#123456" });
    assert.equal((await topEdge(page)).colour, "rgb(18, 52, 86)");
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), "rgb(18, 52, 86)");
  } finally { await page.close(); }
});

test("the strip fills the gap down to the islands, takes no taps and stays under the islands", { skip: !available }, async () => {
  const page = await phone();
  try {
    await fixture(page, { strip: true });
    const facts = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>(".phone-top-edge")!;
      const rect = strip.getBoundingClientRect();
      const island = document.querySelector(".mobile-float-navigation .ui-icon-btn")!;
      const r = island.getBoundingClientRect();
      return {
        top: rect.top, width: rect.width, bottom: rect.bottom,
        islandsTop: document.querySelector(".mobile-session-floats")!.getBoundingClientRect().top,
        pointerEvents: getComputedStyle(strip).pointerEvents,
        tapAtEdge: document.elementFromPoint(window.innerWidth / 2, 4) === strip,
        islandReachable: island.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
      };
    });
    assert.equal(facts.top, 0);
    assert.equal(facts.width, 390);
    assert.ok(facts.bottom > 10, "taller than WebKit's 10px thin-box cut-off");
    assert.equal(facts.bottom, facts.islandsTop, "the strip ends where the islands start");
    assert.equal(facts.pointerEvents, "none");
    assert.equal(facts.tapAtEdge, false, "a tap at the top edge goes through the strip");
    assert.equal(facts.islandReachable, true, "the islands stay above the strip");
  } finally { await page.close(); }
});

for (const [name, options] of [["other engines", { ios: false }], ["the native app", { native: true }]] as const) {
  test(`no strip in ${name}`, { skip: !available }, async () => {
    const page = await phone();
    try {
      await fixture(page, { strip: true, ...options });
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".phone-top-edge")!).display), "none");
      assert.equal((await topEdge(page)).colour, null);
    } finally { await page.close(); }
  });
}

test("the phone header renders the strip on every phone surface", async () => {
  const header = await read("components/Header.tsx");
  const phoneBranch = header.slice(header.indexOf('if (mode === "phone")'));
  const branch = phoneBranch.slice(0, phoneBranch.indexOf("\n    );\n"));
  assert.match(branch, /\n\s*<div className="phone-top-edge" aria-hidden="true" \/>\n/, "outside the chat/view header switch, so a page or either header keeps it");
});

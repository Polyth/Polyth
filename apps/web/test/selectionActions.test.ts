// Selection quick actions: markdown quoting is bounded and block-shaped,
// the derived session title clips to its cap, and the floating menu never
// leaves the viewport. Glass coverage is Chromium-checked because the menu
// sits on transcript text.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  clampMenuPosition,
  dockDragDismisses,
  dockDragOffset,
  quoteForReply,
  selectionSurface,
  selectionTitle,
} from "../src/selectionActions.ts";
import { findChromium } from "./chromium.ts";

const stylesSource = () => readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const tokensSource = () => readFile(new URL("../src/tokens.css", import.meta.url), "utf8");
const dockSource = () => readFile(new URL("../src/components/SelectionDock.css", import.meta.url), "utf8");
const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}

let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  if (!CHROME) return;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 720, height: 480 } });
});

after(async () => {
  await browser?.close();
});

test("selection glass separates overlapping text while retaining user transparency and fallbacks", async () => {
  const css = await stylesSource();
  const base = css.slice(css.indexOf(".selection-menu {"), css.indexOf(".selection-menu-flash"));
  assert.match(base, /--selection-menu-glass-fill:\s*calc\(88% \+ var\(--material-glass-fill\) \* 0\.22\)/);
  assert.match(base, /--selection-menu-glass-edge:\s*calc\(72% \+ var\(--material-glass-edge\) \* 0\.5\)/);
  assert.match(base, /--selection-menu-glass-blur:\s*calc\(var\(--material-glass-blur\) \* 3\.2\)/);
  assert.match(base, /\.selection-menu \.ui-btn--ghost \{ color: var\(--text\); \}/);
  assert.doesNotMatch(base, /calc\(\(100% \+ var\(--material-glass-(?:fill|edge)\)\) \/ 2\)/);

  const selector = 'body:not([data-glass="off"]):not([data-desktop-low-resource="true"]) .selection-menu';
  // The touch selection dock shares this material rule.
  const start = css.indexOf(`${selector},\n    ${selector.replace(".selection-menu", ".selection-dock")} {`);
  assert.ok(start >= 0);
  const rule = css.slice(start, css.indexOf("}", start));
  assert.match(rule, /var\(--material-glass-strong\) var\(--selection-menu-glass-fill\)/);
  assert.match(rule, /var\(--material-glass-strong\) var\(--selection-menu-glass-edge\)/);
  assert.match(rule, /backdrop-filter: blur\(var\(--selection-menu-glass-blur\)\)/);
  assert.match(css, /body\[data-glass="off"\][^{]*\.selection-menu[^}]*backdrop-filter:\s*none !important/s);
  assert.match(css, /body\[data-desktop-low-resource="true"\][^{]*\.selection-menu[^}]*backdrop-filter:\s*none/s);
});

test("selection menu stays readable over transcript in Clear glass and still tracks user transparency", {
  skip: !CHROME,
}, async () => {
  assert.ok(page);
  const css = `${await tokensSource()}\n${await stylesSource()}`;
  const transcript = "the quick brown fox jumps over the lazy dog ".repeat(18);
  await page.setContent(`<style>${css}
    html, body { margin: 0; background: #f4f1ea; color: #1a1814; font: 16px/1.45 sans-serif; }
    .stage { position: relative; width: 640px; padding: 48px 24px; }
    .selection-menu { position: absolute; left: 48px; top: 72px; width: 270px; height: 34px; }
  </style>
    <div class="stage">
      <p>${transcript}</p>
      <div class="selection-menu" role="toolbar">
        <button type="button" class="ui-btn ui-btn--sm ui-btn--ghost">Quote in reply</button>
        <button type="button" class="ui-btn ui-btn--sm ui-btn--ghost">New session</button>
        <button type="button" class="ui-btn ui-btn--sm ui-btn--ghost">Copy</button>
      </div>
    </div>`);

  const sample = async (glass: "clear" | "matte" | "off") => page!.evaluate((mode) => {
    const body = document.body;
    if (mode === "matte") delete body.dataset.glass;
    else body.dataset.glass = mode;
    const menu = document.querySelector<HTMLElement>(".selection-menu")!;
    const button = menu.querySelector<HTMLElement>(".ui-btn--ghost")!;
    const style = getComputedStyle(menu);
    const filter = style.backdropFilter || (style as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter || "";
    const fill = getComputedStyle(menu).getPropertyValue("--selection-menu-glass-fill").trim();
    const blur = getComputedStyle(menu).getPropertyValue("--selection-menu-glass-blur").trim();
    const userFill = getComputedStyle(menu).getPropertyValue("--material-glass-fill").trim();
    return {
      filter,
      fill,
      blur,
      userFill,
      background: style.backgroundImage,
      buttonColor: getComputedStyle(button).color,
    };
  }, glass);

  const usedPercent = (expr: string) => {
    const mixed = expr.match(/calc\(([\d.]+)%\s*\+\s*([\d.]+)%\s*\*\s*([\d.]+)\)/);
    if (mixed) return Number(mixed[1]) + Number(mixed[2]) * Number(mixed[3]);
    return Number.parseFloat(expr);
  };
  const usedPx = (expr: string) => {
    const mixed = expr.match(/calc\(([\d.]+)px\s*\*\s*([\d.]+)\)/);
    if (mixed) return Number(mixed[1]) * Number(mixed[2]);
    return Number.parseFloat(expr);
  };
  const clear = await sample("clear");
  const matte = await sample("matte");
  const off = await sample("off");

  assert.match(clear.filter, /blur\(/);
  assert.match(matte.filter, /blur\(/);
  assert.match(off.filter, /none/);
  assert.match(clear.background, /radial-gradient/);
  assert.match(matte.background, /radial-gradient/);
  assert.equal(Number.parseFloat(clear.userFill), 30);
  assert.equal(Number.parseFloat(matte.userFill), 52);
  assert.notEqual(clear.fill, matte.fill, "Clear must keep a lighter fill than Matte");
  assert.ok(usedPercent(clear.fill) >= 90, `Clear fill floor must stay readable, got ${clear.fill}`);
  assert.ok(usedPercent(matte.fill) > usedPercent(clear.fill));
  assert.ok(usedPx(clear.blur) < usedPx(matte.blur), "Clear still uses a lighter blur than Matte");
  assert.match(clear.buttonColor, /^rgb\(/, "labels use solid primary ink");
  assert.equal(clear.buttonColor, matte.buttonColor);
});

test("quoteForReply prefixes every line and leaves the caret on a fresh line", () => {
  assert.equal(quoteForReply("one line"), "> one line\n\n");
  assert.equal(
    quoteForReply("first\nsecond"),
    "> first\n> second\n\n",
  );
  // blank interior lines stay part of the same quote block (bare ">")
  assert.equal(
    quoteForReply("para one\n\npara two"),
    "> para one\n>\n> para two\n\n",
  );
  // CRLF normalizes; leading/trailing whitespace trims before quoting
  assert.equal(quoteForReply("\r\n  a\r\nb  \r\n"), "> a\n> b\n\n");
  // interior indentation survives (only the string's edges trim)
  assert.equal(quoteForReply("head\n  indented"), "> head\n>   indented\n\n");
  assert.equal(quoteForReply("   \n  "), "");
});

test("quoteForReply caps a select-all so the draft cannot flood", () => {
  const out = quoteForReply("x".repeat(10_000));
  assert.ok(out.length < 4_200);
  assert.ok(out.includes("…"));
  assert.ok(out.startsWith("> "));
  assert.ok(out.endsWith("\n\n"));
});

test("selectionTitle takes the first non-empty line, clipped", () => {
  assert.equal(selectionTitle("Fix the bug\nmore detail"), "Fix the bug");
  assert.equal(selectionTitle("\n\n  indented lead  \nrest"), "indented lead");
  assert.equal(selectionTitle(""), "From selection");
  const long = selectionTitle(`${"t".repeat(100)}`);
  assert.equal(long.length, 60);
  assert.ok(long.endsWith("…"));
});

test("clampMenuPosition keeps the menu inside the viewport", () => {
  // fits: unchanged
  assert.deepEqual(clampMenuPosition(100, 50, 270, 34, 1280, 800), { x: 100, y: 50 });
  // off every edge: clamped with the 8px margin
  assert.deepEqual(clampMenuPosition(-40, -40, 270, 34, 1280, 800), { x: 8, y: 8 });
  assert.deepEqual(clampMenuPosition(2000, 2000, 270, 34, 1280, 800), { x: 1280 - 270 - 8, y: 800 - 34 - 8 });
});

test("touch and pen selections get the bottom dock; mouse keeps the floating toolbar", () => {
  assert.equal(selectionSurface("wide", "touch"), "dock");
  assert.equal(selectionSurface("wide", "pen"), "dock");
  assert.equal(selectionSurface("phone", "mouse"), "float");
  // No press seen yet (keyboard selection, first paint): the shell decides.
  assert.equal(selectionSurface("phone", null), "dock");
  assert.equal(selectionSurface("compact", null), "float");
  assert.equal(selectionSurface("wide", null), "float");
});

test("the dock follows a downward drag, resists upward, and dismisses on distance or flick", () => {
  assert.equal(dockDragOffset(0), 0);
  assert.equal(dockDragOffset(42), 42);
  assert.ok(dockDragOffset(-4) < 0);
  assert.equal(dockDragOffset(-10_000), -18, "upward travel is capped");
  // 160px card: 40% is 64px.
  assert.equal(dockDragDismisses(30, 0, 160), false);
  assert.equal(dockDragDismisses(70, 0, 160), true);
  assert.equal(dockDragDismisses(20, 0.8, 160), true, "a flick dismisses early");
  assert.equal(dockDragDismisses(8, 0.8, 160), false, "a twitch is not a flick");
  assert.equal(dockDragDismisses(-10, 2, 160), false);
  // Small cards still need a deliberate pull.
  assert.equal(dockDragDismisses(40, 0, 60), false);
});

test("the dock sits on the measured interaction frame, above the safe area, with shared glass", async () => {
  const dock = await dockSource();
  const frame = dock.slice(dock.indexOf(".selection-dock-frame {"), dock.indexOf("}", dock.indexOf(".selection-dock-frame {")));
  assert.match(frame, /height: var\(--layer-frame-bottom, var\(--visual-frame-bottom, 100dvh\)\)/);
  assert.match(frame, /max\(var\(--space-3\), var\(--safe-bottom\)\)/);
  assert.match(frame, /z-index: var\(--z-popover\)/);
  assert.match(frame, /pointer-events: none/);
  // Motion uses the shared surface duration/curve; no component-local timing.
  for (const m of dock.matchAll(/animation:\s*([^;]+);/g)) {
    assert.match(m[1]!, /var\(--motion-surface\) var\(--motion-ease\)/, m[0]);
  }
  assert.doesNotMatch(dock, /transition:[^;]*\b\d+m?s\b/, "transitions use motion tokens");
  // A drag owns `transform`; keyframes only touch the individual properties.
  for (const kf of dock.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)) {
    assert.doesNotMatch(kf[1]!, /transform:/, "keyframes must not fight the drag transform");
  }
  const css = await stylesSource();
  assert.match(css, /body\[data-glass="off"\][^{]*\.selection-dock[^}]*backdrop-filter:\s*none !important/s);
  assert.match(css, /body\[data-desktop-low-resource="true"\] :is\([^)]*\.selection-dock[^{]*\{\s*-webkit-backdrop-filter: none/s);
});

test("the dock renders as a bottom card over transcript on a phone viewport", {
  skip: !CHROME,
}, async () => {
  assert.ok(browser);
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  try {
    const css = `${await tokensSource()}\n${await stylesSource()}\n${await dockSource()}`;
    const transcript = "Polyth keeps one canonical history for every session. ".repeat(40);
    await phone.setContent(`<style>${css}
      html, body { margin: 0; background: #f4f1ea; color: #1a1814; font: 16px/1.45 sans-serif; }
      .stage { padding: 24px; }
    </style>
    <div class="stage"><p>${transcript}</p></div>
    <div class="selection-dock-frame">
      <div class="selection-dock" role="toolbar" data-phase="open">
        <span class="selection-dock-grabber"></span>
        <div class="selection-dock-preview"><p class="selection-dock-preview-text">${transcript}</p></div>
        <div class="selection-dock-actions">
          ${["Quote", "New session", "Copy", "Share"].map((label, i) => `
            <button type="button" class="selection-dock-action" style="--selection-dock-i:${i}" ${i === 0 ? "data-primary=\"true\"" : ""}>
              <span class="selection-dock-action-icon"><svg width="18" height="18"></svg></span>
              <span class="selection-dock-action-label">${label}</span>
            </button>`).join("")}
        </div>
      </div>
    </div>`);
    // Let the entrance finish before measuring.
    await phone.waitForTimeout(700);
    const box = await phone.evaluate(() => {
      const dock = document.querySelector<HTMLElement>(".selection-dock")!;
      const r = dock.getBoundingClientRect();
      const preview = document.querySelector<HTMLElement>(".selection-dock-preview-text")!;
      const actions = [...document.querySelectorAll<HTMLElement>(".selection-dock-action")].map((b) => b.getBoundingClientRect());
      return {
        left: r.left, right: r.right, bottom: r.bottom, height: r.height,
        opacity: getComputedStyle(dock).opacity,
        previewLines: Math.round(preview.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(preview).lineHeight)),
        minAction: Math.min(...actions.map((a) => Math.min(a.width, a.height))),
        sameRow: new Set(actions.map((a) => Math.round(a.top))).size,
      };
    });
    assert.equal(box.opacity, "1");
    assert.ok(Math.abs(844 - box.bottom - 12) <= 1, `docked above the bottom edge, got ${box.bottom}`);
    assert.ok(box.left >= 12 && 390 - box.right >= 12, "inline margins");
    assert.ok(box.height < 190, `compact enough to leave the transcript readable, got ${box.height}`);
    assert.equal(box.previewLines, 2, "preview clamps to two lines");
    assert.ok(box.minAction >= 44, `thumb-sized targets, got ${box.minAction}`);
    assert.equal(box.sameRow, 1, "actions share one row");
    if (process.env.SELECTION_DOCK_SHOT) await phone.screenshot({ path: process.env.SELECTION_DOCK_SHOT });
  } finally {
    await phone.close();
  }
});

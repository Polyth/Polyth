// F3 selection quick actions: markdown quoting is bounded and block-shaped,
// the derived session title clips to its cap, and the floating menu never
// leaves the viewport. Glass coverage is Chromium-checked because the menu
// sits on transcript text.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Browser, Page } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";
import { clampMenuPosition, quoteForReply, selectionTitle } from "../src/selectionActions.ts";

const stylesSource = () => readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const tokensSource = () => readFile(new URL("../src/tokens.css", import.meta.url), "utf8");
const CHROME = await findChromiumExecutable();

let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  if (!CHROME) return;
  const { chromium } = await import("playwright-core");
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
  const start = css.indexOf(`${selector} {`);
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

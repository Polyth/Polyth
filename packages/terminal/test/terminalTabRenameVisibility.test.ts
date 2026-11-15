// The terminal tab rename pencil is the coarse-pointer tap path; desktop
// renames by double-clicking the tab. This proves the pencil is hidden on a
// fine pointer and shown on a coarse one, with the real terminal stylesheet.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright-core";
import { findChromium } from "../../../apps/web/test/chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}

const css = [
  "../../../apps/web/src/tokens.css",
  "../../../apps/web/src/styles.css",
  "../widgets/styles.css",
].map((path) => readFileSync(resolve(import.meta.dirname, path), "utf8")).join("\n");

const tab = (active: boolean) => `<span class="term-tab-group${active ? " active" : ""}"><button class="term-tab${active ? " active" : ""}" role="tab" aria-selected="${active}"><span class="term-connection connected"></span>shell · 1</button><button class="ui-icon-btn term-tab-rename-btn" aria-label="Rename shell · 1" title="Rename">✎</button><button class="ui-icon-btn term-tab-x" aria-label="Close shell · 1" title="Close">×</button></span>`;

let browser: Browser | null = null;
before(async () => {
  if (!CHROME) return;
  browser = await import("playwright-core").then(({ chromium }) => chromium.launch({
    executablePath: CHROME,
    headless: true,
    ...(process.getuid?.() === 0 ? { args: ["--no-sandbox"] } : {}),
  }));
});
after(async () => { await browser?.close(); });

async function open(coarse: boolean) {
  assert.ok(browser);
  const context = await browser.newContext({
    viewport: { width: coarse ? 390 : 1440, height: coarse ? 844 : 900 },
    deviceScaleFactor: coarse ? 2 : 1,
    isMobile: coarse,
    hasTouch: coarse,
  });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}
    html, body { margin: 0; }
  </style></head><body><div class="term-view"><div class="term-tabs"><div class="term-tab-list ui-scroll-tabs" role="tablist">${tab(true)}${tab(false)}</div></div></div></body></html>`);
  await page.waitForTimeout(100);
  return page;
}

test("the rename pencil shows on a coarse pointer and hides on a fine one", { skip: !CHROME }, async () => {
  const phone = await open(true);
  try {
    const display = await phone.evaluate(() =>
      getComputedStyle(document.querySelector(".term-tab-rename-btn") as HTMLElement).display);
    assert.notEqual(display, "none", "the rename pencil is visible on a coarse pointer");
  } finally {
    await phone.close();
  }

  const desktop = await open(false);
  try {
    const display = await desktop.evaluate(() =>
      getComputedStyle(document.querySelector(".term-tab-rename-btn") as HTMLElement).display);
    assert.equal(display, "none", "the rename pencil is hidden on a fine pointer (dblclick renames)");
  } finally {
    await desktop.close();
  }
});

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Browser, Page } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";

const readCss = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const CHROME = await findChromiumExecutable();

let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  if (!CHROME) return;
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
});

after(async () => {
  await browser?.close();
});

test("the phone composer stays in visual-viewport flow and expands inside the visible band", async () => {
  const css = await readCss("../src/styles.css");
  const viewportCss = await readCss("../src/mobileViewport.css");

  // The side gutters may read the horizontal insets, but the block-end inset
  // belongs to the surrounding dock/nav alone.
  const phoneComposer = css.match(/\.composer-chat\.composer-mobile \{[^}]*\}/)?.[0] ?? "";
  assert.match(phoneComposer, /padding: var\(--space-1\)/,
    "the phone composer owns its own compact block padding");
  assert.doesNotMatch(
    phoneComposer,
    /--safe-bottom/,
    "the composer does not duplicate the dock or navigator safe-area inset",
  );
  assert.match(
    css,
    /\.composer-mobile\.composer-expanded \.composer-card textarea \{ min-height: calc\(var\(--tap\) \* 2\); \}/,
    "the expanded editor keeps two touch rows without a fixed card height",
  );
  assert.doesNotMatch(
    css,
    /body\[data-keyboard="open"\][\s\S]{0,180}\.composer-chat\.composer-mobile\s*\{[^}]*position:\s*fixed/s,
    "keyboard-open composition remains in visualViewport flow",
  );
  assert.match(
    css,
    /body\[data-keyboard="open"\] \.composer-chat\.composer-mobile,\s*body\[data-keyboard="open"\] \.hero-dock \{ padding-bottom: var\(--space-1\); \}/,
    "new-chat and in-session composers share the keyboard-open optical gap",
  );
  assert.match(
    viewportCss,
    /body\[data-keyboard="open"\] \.hero-dock\s*\{[^}]*padding-bottom:\s*var\(--space-1\)/s,
    "the viewport overlay targets the new-chat dock itself",
  );
  assert.doesNotMatch(
    viewportCss,
    /#app-canvas-root/,
    "the keyboard-open dock rule cannot depend on a host id that is never rendered",
  );
});

test("keyboard-open new chat drops the home-indicator gap that existing chats already drop", { skip: !CHROME }, async () => {
  assert.ok(page);
  const css = [
    await readCss("../src/tokens.css"),
    await readCss("../src/styles.css"),
    await readCss("../src/mobileViewport.css"),
  ].join("\n");
  await page.setContent(`<style>${css}</style>
    <div class="hero-dock" id="new-chat"><div class="composer composer-chat composer-mobile">draft</div></div>
    <div class="composer composer-chat composer-mobile" id="session">draft</div>`);
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-area-inset-bottom", "34px");
    document.documentElement.style.setProperty("--safe-bottom", "34px");
  });

  const resting = await page.evaluate(() => {
    const dock = getComputedStyle(document.getElementById("new-chat")!);
    const session = getComputedStyle(document.getElementById("session")!);
    return { dock: dock.paddingBottom, session: session.paddingBottom };
  });
  assert.equal(resting.dock, "34px", "new-chat dock keeps the home indicator while the keyboard is closed");

  await page.evaluate(() => { document.body.dataset.keyboard = "open"; });
  const open = await page.evaluate(() => {
    const dock = getComputedStyle(document.getElementById("new-chat")!);
    const session = getComputedStyle(document.getElementById("session")!);
    return { dock: dock.paddingBottom, session: session.paddingBottom };
  });
  assert.equal(open.session, "4px", "existing chats keep the compact keyboard-open gap");
  assert.equal(open.dock, "4px", "new chats use that same compact keyboard-open gap");
});

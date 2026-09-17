import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { browserBuildOptions, uiFontScalePlugin } from "../buildConfig.ts";
import { composerLayoutState } from "../src/composerLayout.ts";
import type { Browser, Page } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";

const readCss = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const CHROME = await findChromiumExecutable();

// Build the real entry graph in memory: CSS order includes dynamic bootstrap
// imports (not just the import lines in main.tsx). No app/server writes.
async function composerStyles() {
  const result = await build({
    ...browserBuildOptions,
    entryPoints: [new URL("../src/main.tsx", import.meta.url).pathname],
    outdir: "/tmp/opencode/composer-geometry-build",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  });
  return result.outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
}

function composerFixture(surface: string, phone: boolean, state: string, working: boolean, voice: boolean) {
  const layout = composerLayoutState({ phoneLayout: phone, inputFocused: state === "focus", shellMode: state === "shell", hasDraft: state === "draft" });
  const classes = phone ? `composer-mobile composer-${layout === "phone-resting" ? "collapsed" : "expanded"}` : "";
  const glyph = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14"/></svg>';
  const model = '<span class="picker picker-model"><span class="model-picker"><button class="config-chip model-picker-trigger"><span class="model-trigger-name">Union Alpha</span></button></span></span>';
  const action = working && state === "draft"
    ? `<div class="composer-send-split"><button class="composer-send-options" aria-label="More">…</button><button class="send composer-delivery composer-queue" aria-label="Queue">${glyph}</button></div>`
    : `<button class="${working ? "stop composer-stop-primary" : "send"}" aria-label="${working ? "Stop" : "Send"}"><span class="send-plane">${glyph}</span></button>`;
  return `<div class="${surface === "new" ? "stage-new" : surface === "widget" ? "widget-card-body" : "focus-conversation"}">
    <div class="${surface === "new" ? "hero-dock" : "conversation-composer-dock"}">
    <div class="composer composer-simple ${surface === "widget" ? "composer-widget" : "composer-chat composer-focus-light"} ${classes}">
      <div class="composer-card glass-dock">
        <div class="composer-input">${state === "shell" ? '<div class="composer-mode-label">Shell command</div>' : ''}<textarea class="composer-editor" rows="1" placeholder="Message Polyth…">${state === "draft" ? "Draft preserved after blur" : ""}</textarea></div>
        <div class="composer-rail">
          <span class="composer-leading-zone customize-zone"><div class="composer-add"><button class="composer-add-trigger" aria-label="Add"><span class="composer-add-icon">${glyph}</span></button></div>
            <span class="composer-extensions composer-mobile-extensions">${voice ? `<span class="placed-mini-widget"><button class="mic-btn" aria-label="Microphone">${glyph}</button></span>` : ''}</span></span>
          <span class="composer-execution">${phone ? model : ''}</span>
          <div class="composer-actions customize-zone"><span class="composer-extensions"></span><div class="composer-config">${phone ? '' : model}</div><span class="composer-primary">${action}</span></div>
        </div>
      </div>
    </div></div></div>`;
}

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

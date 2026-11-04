// Geometry contract for the phone conversation, in a real browser with the real
// stylesheets. Everything in the chat stands on one frame: prose, activity
// blocks, the composer, the session floats and the bookmark share their edges,
// and the lines above the composer share its columns. Reported breakage, in the
// Obsidian look: a closed package window left the rail host in flow, so its
// strip margins took 12pt from the whole chat and cut open windows short of the
// screen; a look's padding reset hung activity marks and chevrons 8pt outside
// the frame; and Stop pushed a live block's chevron to the middle of its line.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { findChromium } from "./chromium.ts";

const CHROME = await findChromium();
if (!CHROME && process.env.POLYTH_REQUIRE_CHROMIUM === "1") {
  throw new Error("This layout test requires an installed Chromium (set POLYTH_CHROMIUM_PATH).");
}

const LOOKS = ["standard", "paper", "line", "air", "monolith", "monolith-reverse", "obsidian", "editorial"];
const VIEWPORTS = [{ width: 430, height: 932 }, { width: 320, height: 568 }, { width: 932, height: 430 }];
const read = (path: string) => readFileSync(resolve(import.meta.dirname, `../src/${path}`), "utf8");
// main.tsx's order; component sheets arrive with the app graph, after the core.
const css = [
  "tokens.css", "styles.css", "moduleContent.css", "composerAdaptive.css", "components/mobile/MobileComposerRail.css",
  "motion.css", "stackNavigation.css", "mobileViewport.css", "shellLayout.css", "shellLooks.css", "components/ui/AgentStatusDock.css", "components/ChatChrome.css",
].map(read).join("\n").replace(/@import[^;]+;/g, "");

const summary = (state: string, copy: string) => `
  <button class="ui-run-summary" data-state="${state}">
    <span class="ui-run-summary-mark"><svg width="18" height="18"></svg></span>
    <span class="ui-run-summary-copy">${copy}</span>
    <svg class="ui-run-summary-chevron ui-icon ui-icon--sm" width="16" height="16"></svg>
  </button>`;
const step = `
  <div class="tool-card execution-row"><div class="execution-summary-line">
    <button class="tool-disclosure execution-summary">
      <span class="tool-icon execution-icon"><svg></svg></span>
      <span class="execution-main"><span class="tool-name">Shell</span></span>
      <span class="execution-diff-stat-slot"></span>
      <span class="execution-status done"><span class="execution-duration">4s</span></span>
      <span class="tool-chevron"><svg></svg></span>
    </button>
  </div></div>`;

const conversation = (rail: string) => `
<div class="app mode-chat view-session"><div class="app-shell">
  <main class="workspace"><div class="focus-conversation">
    <div class="timeline-viewport">
      <div class="timeline">
        <div class="msg assistant"><div class="bubble">Prose</div></div>
        <section class="msg assistant activity-group folded">${summary("completed", "<strong>Ran 1 command</strong>")}</section>
        <section class="msg assistant activity-group open">
          ${summary("completed", "<strong>Ran 1 command</strong>")}
          <div class="activity-group-expand-shell"><div class="activity-group-collapse-content"><div class="activity-group-items">${step}</div></div></div>
        </section>
        <section class="msg assistant activity-group current has-live-stop">
          ${summary("active", "<strong>Shell</strong>")}
          <span class="activity-live-stop"><button class="ui-btn ui-btn--danger ui-btn--sm execution-stop"><span class="ui-btn-label">Stop</span></button></span>
        </section>
      </div>
      <div class="prompt-bookmark"><button class="ui-icon-btn prompt-bookmark-toggle"></button></div>
    </div>
    <div class="conversation-composer-dock">
      <span class="placed-mini-widget"><button class="agent-status-dock">
        <span class="agent-status-dock-icon"></span>
        <span class="agent-status-dock-content"><span class="agent-status-dock-primary"><span class="agent-status-dock-state">Working</span></span></span>
        <time class="agent-status-dock-time">1m</time>
      </button></span>
      <div class="composer composer-chat composer-simple composer-mobile composer-mobile-grid composer-collapsed">
        <div class="ui-glass-dock ui-glass-dock--strong composer-card">
          <div class="composer-input"><textarea class="composer-editor"></textarea></div>
          <div class="composer-rail mobile-composer-rail" data-resting="true">
            <div class="mobile-composer-launchers"><div class="mobile-composer-run">
              <div class="mobile-composer-cell" data-resting="add"><div class="mobile-composer-launcher"><span class="composer-add"><button class="chip composer-add-trigger"></button></span></div></div>
            </div></div>
            <div class="mobile-composer-primary"><div class="composer-primary"><button class="stop"></button></div></div>
          </div>
        </div>
      </div>
    </div>
  </div></main>
  ${rail}
</div></div>
<div class="mobile-session-floats">
  <div class="mobile-float-navigation"><button></button></div>
  <div class="mobile-float-actions"><button></button></div>
</div>`;

const CLOSED_WINDOW = `<aside class="railbar" data-rail-motion="idle" data-rail-strip="none"><div class="rail" style="display:none"></div></aside>`;
const OPEN_WINDOW = `<aside class="railbar railbar-open" data-rail-motion="open" data-rail-strip="none"><div class="rail rail-workspace rail-fullscreen"></div></aside>`;

let browser: Browser;
before(async () => { if (CHROME) browser = await chromium.launch({ executablePath: CHROME, headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(look: string, viewport: { width: number; height: number }, rail: string): Promise<Page> {
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${css}</style><style>*, *::before, *::after { animation: none !important; transition: none !important; }</style></head>
    <body data-shell-look="${look}" data-activity-style="thread" data-keyboard="closed">${conversation(rail)}</body></html>`);
  return page;
}

const measure = (page: Page) => page.evaluate(() => {
  const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
  const centre = (selector: string) => { const rect = box(selector); return (rect.left + rect.right) / 2; };
  const items = document.querySelector(".open .activity-group-items")!;
  return {
    viewport: innerWidth,
    workspaceRight: box(".workspace").right,
    prose: { left: box(".bubble").left, right: box(".bubble").right },
    card: { left: box(".composer-card").left, right: box(".composer-card").right },
    floats: { left: box(".mobile-float-navigation").left, right: box(".mobile-float-actions").right },
    bookmarkRight: box(".prompt-bookmark-toggle").right,
    pillLeft: box(".folded > .ui-run-summary").left,
    markLeft: box(".folded .ui-run-summary-mark").left,
    chevronRight: box(".folded .ui-run-summary-chevron").right,
    liveChevronRight: box(".has-live-stop .ui-run-summary-chevron").right,
    liveChevronLeft: box(".has-live-stop .ui-run-summary-chevron").left,
    stopRight: box(".execution-stop").right,
    threadX: items.getBoundingClientRect().left + parseFloat(getComputedStyle(items, "::before").left),
    openMarkCentre: centre(".open .ui-run-summary-mark"),
    openTitleLeft: box(".open .ui-run-summary-copy").left,
    stepIconLeft: box(".open .execution-icon").left,
    stepChevronRight: box(".open .tool-chevron").right,
    statusMarkCentre: centre(".agent-status-dock-icon"),
    statusEnd: box(".agent-status-dock-time").right,
    addCentre: centre(".composer-add"),
    discRight: box(".composer-rail .stop").right,
  };
});

const near = (actual: number, expected: number, what: string, tolerance = 0.6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} vs ${expected}`);

for (const viewport of VIEWPORTS) {
  for (const look of LOOKS) {
    const name = `${look} at ${viewport.width}x${viewport.height}`;
    test(`${name}: a closed package window takes no room from the chat`, { skip: !CHROME }, async () => {
      const page = await fixture(look, viewport, CLOSED_WINDOW);
      const m = await measure(page);
      near(m.workspaceRight, m.viewport, "chat column reaches the screen edge");
      near(m.card.left, m.prose.left, "composer and prose start together");
      near(m.card.right, m.prose.right, "composer and prose end together");
      near(m.floats.left, m.prose.left, "floats and prose start together");
      near(m.floats.right, m.prose.right, "floats and prose end together");
      near(m.bookmarkRight, m.floats.right, "the bookmark rests on the floats' edge");
      await page.context().close();
    });

    test(`${name}: activity blocks stand on the frame`, { skip: !CHROME }, async () => {
      const page = await fixture(look, viewport, CLOSED_WINDOW);
      const m = await measure(page);
      if (look === "air") {
        // Air's summary is a pill that hugs its words: its edge is on the frame.
        near(m.pillLeft, m.prose.left, "the pill starts on the prose edge");
      } else {
        near(m.markLeft, m.prose.left, "the mark starts on the prose edge");
        near(m.chevronRight, m.prose.right, "the chevron ends on the prose edge");
        near(m.liveChevronRight, m.chevronRight, "Stop does not move a live block's chevron");
        assert.ok(m.stopRight <= m.liveChevronLeft, `Stop stands before the chevron: ${m.stopRight} vs ${m.liveChevronLeft}`);
        near(m.stepIconLeft, m.openTitleLeft, "steps start on the title column");
        near(m.stepChevronRight, m.chevronRight, "step chevrons share the block's column");
      }
      near(m.threadX, m.openMarkCentre, "the thread hangs from the mark's centre", 1);
      await page.context().close();
    });

    test(`${name}: the status line shares the resting composer's columns`, { skip: !CHROME }, async () => {
      const page = await fixture(look, viewport, CLOSED_WINDOW);
      const m = await measure(page);
      near(m.statusMarkCentre, m.addCentre, "the status mark centres on Add");
      near(m.statusEnd, m.discRight, "the status line ends with the Stop/Send disc");
      await page.context().close();
    });

    test(`${name}: an open package window fills the screen`, { skip: !CHROME }, async () => {
      const page = await fixture(look, viewport, OPEN_WINDOW);
      const rect = await page.evaluate(() => {
        const box = document.querySelector(".rail-fullscreen")!.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight };
      });
      near(rect.left, 0, "left edge");
      near(rect.top, 0, "top edge");
      near(rect.right, rect.width, "right edge");
      near(rect.bottom, rect.height, "bottom edge");
      await page.context().close();
    });
  }
}

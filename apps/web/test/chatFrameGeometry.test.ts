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
const stepRow = (name: string, target = "") => `
  <div class="tool-card execution-row"><div class="execution-summary-line">
    <button class="tool-disclosure execution-summary">
      <span class="tool-icon execution-icon"><svg></svg></span>
      <span class="execution-main"><span class="tool-name">${name}</span>${target ? `<span class="tool-preview">${target}</span>` : ""}</span>
      <span class="execution-diff-stat-slot"></span>
      <span class="execution-status done"><span class="execution-duration">4s</span></span>
      <span class="tool-chevron"><svg></svg></span>
    </button>
  </div></div>`;
// The live line of a working block: an MCP tool's name and, when the call has
// one, its quiet preview (ActivityTicker.tsx).
const tickerCopy = (label: string, preview = "") => `<span class="activity-ticker" data-ticker-entry="live"><span class="activity-ticker-line"><span class="activity-ticker-step live"><span class="activity-ticker-glyph"><svg width="14" height="14"></svg></span><strong>${label}</strong>${preview ? `<span class="activity-ticker-preview">${preview}</span>` : ""}</span></span></span>`;
const step = stepRow("Shell");
// A step's target is far longer than its name: the name must keep its words
// and the target must be what truncates.
const longTargetStep = stepRow("Read", "Read · .agents/skills/polyth-agent-beta/SKILL.md");

// Detail rows inside an opened tool call, as ExecutionRow renders them. Each
// pairs a primary with something that must give way before it.
const detailCard = `
<div class="tool-card execution-row detail-rows"><div class="execution-details tool-body">
  <section class="execution-detail-section execution-file-changes"><article class="execution-file-change">
    <button class="execution-file-toggle"><span class="execution-file-path"><span class="muted">apps/web/old-name.tsx → </span>apps/web/src/components/SessionActivityDetails.tsx</span><span class="execution-diff-stat"><span class="positive">+12</span><span class="negative">−4</span></span><span class="tool-chevron"><svg width="16" height="16"></svg></span></button>
  </article></section>
  <section class="execution-mcp-list"><ul><li>
    <span class="execution-mcp-list-title"><span>Fix truncated step names in the mobile activity ticker rows</span><small>3 comments · open · assigned</small></span>
    <span class="execution-mcp-list-detail">The cap resolves against the words it caps.</span>
  </li></ul></section>
  <section class="execution-detail-section execution-subagent-detail">
    <span class="execution-subagent-branch"><svg width="18" height="18"></svg></span>
    <div><strong>Delegated worker: sweep every transcript row for truncation</strong><span class="execution-subagent-state running">Waiting for model response</span><p>Measuring rows at phone width</p></div>
    <button>Open child session</button>
  </section>
</div></div>`;
// A block summary whose title alone is longer than the row.
const longSummary = summary("completed", "<strong>Edited SessionActivityDetails and every transcript row that truncates</strong><small>4 steps · 1m</small>");

const conversation = (rail: string) => `
<div class="app mode-chat view-session"><div class="app-shell">
  <main class="workspace"><div class="focus-conversation">
    <div class="timeline-viewport">
      <div class="timeline">
        <div class="msg assistant"><div class="bubble">Prose</div></div>
        <section class="msg assistant activity-group folded">${summary("completed", "<strong>Ran 1 command</strong>")}</section>
        <section class="msg assistant activity-group open">
          ${summary("completed", "<strong>Ran 1 command</strong>")}
          <div class="activity-group-expand-shell"><div class="activity-group-collapse-content"><div class="activity-group-items">${step}${longTargetStep}</div></div></div>
        </section>
        <section class="msg assistant activity-group current has-live-stop">
          ${summary("active", "<strong>Shell</strong>")}
          <span class="activity-live-stop"><button class="ui-btn ui-btn--danger ui-btn--sm execution-stop"><span class="ui-btn-label">Stop</span></button></span>
        </section>
        <section class="msg assistant activity-group current live-alone">
          ${summary("active", tickerCopy("Session messages"))}
        </section>
        <section class="msg assistant activity-group current live-with-preview">
          ${summary("active", tickerCopy("Session messages", "e9210f5f"))}
        </section>
        <section class="msg assistant activity-group folded long-title">${longSummary}</section>
        ${detailCard}
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

/** The long-target step's name, as the reader sees it: its glyphs and the
 *  line they stand on. */
const measureStepLine = (page: Page) => page.evaluate(() => {
  const rows = document.querySelectorAll(".open .execution-row");
  const row = rows[rows.length - 1]!;
  const main = row.querySelector<HTMLElement>(".execution-main")!;
  const name = row.querySelector<HTMLElement>(".tool-name")!;
  const range = document.createRange();
  range.selectNodeContents(name);
  return {
    main: main.getBoundingClientRect().toJSON() as { right: number },
    name: range.getBoundingClientRect().toJSON() as { width: number; right: number },
    overflows: main.scrollWidth > main.clientWidth,
  };
});

/** A live line's name as the reader sees it: how much of the word survives,
 *  and where it ends against the room the row gives it. */
const measureTickerLine = (page: Page, block: string) => page.evaluate((selector) => {
  const section = document.querySelector(`.${selector}`)!;
  const copy = section.querySelector<HTMLElement>(".ui-run-summary-copy")!;
  const name = section.querySelector<HTMLElement>(".activity-ticker-step strong")!;
  const preview = section.querySelector<HTMLElement>(".activity-ticker-preview");
  const chevron = section.querySelector<HTMLElement>(".ui-run-summary-chevron")!;
  const range = document.createRange();
  range.selectNodeContents(name);
  return {
    room: copy.getBoundingClientRect().right,
    nameRight: range.getBoundingClientRect().right,
    nameWidth: range.getBoundingClientRect().width,
    nameClipped: name.scrollWidth > name.clientWidth + 1,
    nameNeeds: name.scrollWidth,
    previewClipped: preview ? preview.scrollWidth > preview.clientWidth + 1 : false,
    chevronLeft: chevron.getBoundingClientRect().left,
  };
}, block);

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

    test(`${name}: a step names itself before its target truncates`, { skip: !CHROME || viewport.width > 430 }, async () => {
      const page = await fixture(look, viewport, CLOSED_WINDOW);
      const line = await measureStepLine(page);
      assert.ok(line.name.width > 0, `the step's name keeps its glyphs: ${line.name.width}`);
      assert.ok(line.name.right <= line.main.right + 0.5, `the name is not cut off: ${line.name.right} vs ${line.main.right}`);
      assert.ok(line.overflows, "the target, not the name, takes the truncation");
      await page.context().close();
    });

    // Reported: a live block whose tool was "Session messages" read "Session
    // m…" beside a chevron with 160pt of the row unused. The name alone on the
    // line was capped at 60% of the ticker's own shrink-to-fit width.
    test(`${name}: a live line keeps its step's name whole`, { skip: !CHROME || viewport.width > 430 }, async () => {
      const page = await fixture(look, viewport, CLOSED_WINDOW);
      const alone = await measureTickerLine(page, "live-alone");
      assert.ok(!alone.nameClipped, `a name alone on the line is not trimmed to 60% of itself: ${alone.nameWidth} of ${alone.nameNeeds}`);
      assert.ok(alone.nameRight <= alone.chevronLeft, `the name ends before the chevron: ${alone.nameRight} vs ${alone.chevronLeft}`);
      const paired = await measureTickerLine(page, "live-with-preview");
      assert.ok(!paired.nameClipped, `the name stays whole beside a preview: ${paired.nameWidth} of ${paired.nameNeeds}`);
      assert.ok(paired.nameRight <= paired.chevronLeft, `the line ends before the chevron: ${paired.nameRight} vs ${paired.chevronLeft}`);
      await page.context().close();
    });

    // Every transcript row truncates the same way: the row's primary words
    // keep the line, whatever pairs with them gives way first, and any
    // ellipsis lands at the end of the line — never a clip mid-row with the
    // rest of the row still empty, and never past the row's edge.
    test(`${name}: every transcript row truncates at the end of its line`, { skip: !CHROME || viewport.width > 430 }, async () => {
      const page = await fixture(look, viewport, CLOSED_WINDOW);
      const rows = await page.evaluate(() => {
        const primary = (el: HTMLElement | null) => {
          if (!el) return null;
          const box = el.getBoundingClientRect();
          return { right: box.right, clipped: el.scrollWidth > el.clientWidth + 1 };
        };
        const block = document.querySelector(".long-title")!.getBoundingClientRect();
        const title = primary(document.querySelector<HTMLHTMLElement>(".long-title .ui-run-summary-copy strong"));
        const chevron = document.querySelector(".long-title .ui-run-summary-chevron")!.getBoundingClientRect().left;
        const card = document.querySelector(".detail-rows")!.getBoundingClientRect();
        const path = primary(document.querySelector<HTMLHTMLElement>(".detail-rows .execution-file-path"));
        const diffStat = document.querySelector(".detail-rows .execution-diff-stat")!.getBoundingClientRect().left;
        const mcpTitle = primary(document.querySelector<HTMLHTMLElement>(".detail-rows .execution-mcp-list-title > span"));
        const mcpMeta = document.querySelector<HTMLHTMLElement>(".detail-rows .execution-mcp-list-title small")!.getBoundingClientRect().left;
        const name = primary(document.querySelector<HTMLHTMLElement>(".detail-rows .execution-subagent-detail strong"));
        const state = document.querySelector<HTMLHTMLElement>(".detail-rows .execution-subagent-state")!.getBoundingClientRect().left;
        return {
          block: { left: block.left, right: block.right },
          title, chevron,
          path, diffStat,
          mcpTitle, mcpMeta,
          name, state,
          card: { right: card.right },
        };
      });
      // A summary title longer than the row: the counts are spent, then the
      // title ellipsizes — inside the row, reaching the chevron's column.
      assert.ok(rows.title, "the long summary title is present");
      assert.ok(rows.title!.right <= rows.chevron + 1, `the summary title never runs under the chevron: ${rows.title!.right} vs ${rows.chevron}`);
      assert.ok(rows.title!.right >= rows.chevron - 48, `the summary title reaches the end of the line: ${rows.title!.right} vs ${rows.chevron}`);
      // A changed file: the path ellipsizes inside the card, before the stats.
      assert.ok(rows.path, "the changed-file path is present");
      assert.ok(rows.path!.right <= rows.card.right + 1, `the path stays inside the card: ${rows.path!.right} vs ${rows.card.right}`);
      assert.ok(rows.path!.right >= rows.diffStat - 80, `the path reaches the end of its line: ${rows.path!.right} vs ${rows.diffStat}`);
      // An MCP result: the title keeps the line, its meta gives way first.
      assert.ok(rows.mcpTitle, "the MCP item title is present");
      assert.ok(rows.mcpTitle!.right <= rows.card.right + 1, `the MCP title stays inside the card: ${rows.mcpTitle!.right} vs ${rows.card.right}`);
      assert.ok(rows.mcpTitle!.right >= rows.card.right - 48, `the MCP title reaches the end of the line: ${rows.mcpTitle!.right} vs ${rows.card.right}`);
      assert.ok(rows.mcpTitle!.right >= rows.mcpMeta - 12, `the MCP title keeps its line to its meta (minus the gap): ${rows.mcpTitle!.right} vs ${rows.mcpMeta}`);
      // A delegated agent: the name keeps the line, the state gives way first.
      assert.ok(rows.name, "the subagent name is present");
      assert.ok(rows.name!.right <= rows.card.right + 1, `the subagent name stays inside the card: ${rows.name!.right} vs ${rows.card.right}`);
      assert.ok(rows.name!.right >= rows.card.right - 48, `the subagent name reaches the end of the line: ${rows.name!.right} vs ${rows.card.right}`);
      assert.ok(rows.name!.right >= rows.state - 12, `the subagent name keeps its line to its state (minus the gap): ${rows.name!.right} vs ${rows.state}`);
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

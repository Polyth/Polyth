// A project's Agents group inside the phone Navigator, measured in a real
// browser (skipped without one). The group is part of the list: its chevron and
// every agent's mark share the leading column centred under the project mark,
// its label and agent names start on the session-title edge, ⋮ shares the chat
// rows' trailing column, and a row is a chat row's height at every density.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Browser, Page } from "playwright-core";
import { findChromium } from "../../../apps/web/test/chromium.ts";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const CHROME = await findChromium();

let browser: Browser | null = null;
let page = null as Page | null;
let css = "";

before(async () => {
  if (!CHROME) return;
  const files = await Promise.all([
    "../../../apps/web/src/tokens.css",
    "../../../apps/web/src/styles.css",
    "../../../apps/web/src/components/mobile/MobileNavigator.css",
    "../widgets/styles.css",
  ].map(read));
  css = files.map((text) => text.replace(/@import[^;]+;/g, "")).join("\n");
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
});

after(async () => {
  await browser?.close();
});

const svg = `<svg viewBox="0 0 24 24"><path d="M4 12h16"/></svg>`;
const icon = (size = "sm", extra = "") => `<svg class="ui-icon ui-icon--${size}${extra}" viewBox="0 0 24 24"><path d="M4 12h16"/></svg>`;
// The Lucide ellipsis the package renders for ⋮ (stroked circles).
const dots = `<svg class="ui-icon ui-icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>`;

const agentRow = (id: string, name: string, lead: string, meta = "") => `<div class="agent-nav-row" id="${id}">
  <button type="button" class="agent-nav-btn">
    <span class="agent-nav-lead" aria-hidden="true">${lead}</span>
    <span class="agent-nav-title" dir="auto">${name}</span>
    ${meta ? `<span class="agent-nav-meta">${meta}</span>` : ""}
  </button>
  <button type="button" class="agent-nav-more">${dots}</button>
</div>`;

const agents = (id: string, folded: boolean) => `<div class="agent-nav" id="${id}" role="group" data-surface="phone"${folded ? " data-collapsed" : ""}>
  <div class="agent-nav-head">
    <button type="button" class="agent-nav-toggle" aria-expanded="${!folded}">
      ${icon("sm", " agent-nav-chevron")}
      <span class="agent-nav-label">Agents</span>
      ${folded ? `<span class="agent-nav-summary"><span class="agent-nav-mark" data-mark="stopped">!</span><span class="agent-nav-dot"></span></span>` : ""}
    </button>
    <span class="agent-nav-head-actions"><button type="button" class="agent-nav-head-action">${dots}</button></span>
  </div>
  ${folded ? "" : `<div class="agent-nav-rows">
    ${agentRow("glyph", "Nightly release captain", `<span class="agent-nav-glyph">${icon()}</span>`, "in 3h")}
    ${agentRow("stopped", "Stopped agent with a long name that truncates", `<span class="agent-nav-mark" data-mark="stopped">!</span>`)}
  </div>`}
</div>`;

const session = (title: string) => `<div class="mobile-nav-session-swipe"><div class="mobile-nav-session-row">
  <button class="mobile-nav-session-main"></button>
  <span class="mobile-nav-session-body">
    <span class="mobile-nav-session-lead"></span>
    <span class="mobile-nav-session-heading"><span class="mobile-nav-session-title">${title}</span></span>
    <span class="mobile-nav-session-trailing"><span class="mobile-nav-session-flags"><span class="isolation-list-badge" id="flag">${svg}</span></span></span>
  </span>
  <button class="mobile-nav-more">${svg}</button>
</div></div>`;

const project = (id: string, body: string) => `<section class="mobile-nav-project is-expanded" id="${id}">
  <div class="mobile-nav-project-head">
    <span class="project-glyph">${svg}</span>
    <button class="mobile-nav-project-main"><span class="mobile-nav-project-name">polyth</span></button>
    <div class="mobile-nav-project-actions">
      <button class="mobile-nav-project-action">${icon("lg")}</button>
      <button class="mobile-nav-project-action">${svg}</button>
    </div>
  </div>
  <div class="mobile-nav-project-body">${body}</div>
</section>`;

const fixture = `<nav class="mobile-navigator" style="animation:none">
  <div class="mobile-nav-scroll" style="animation:none">
    ${project("open", `${agents("open-agents", false)}${session("A chat row")}<div class="mobile-nav-date-divider" role="separator"><span>Yesterday</span></div>`)}
    ${project("folded", `${agents("folded-agents", true)}${session("Another chat row")}`)}
  </div>
</nav>`;

async function measure(width: number, options: { density?: string; dir?: "ltr" | "rtl" } = {}) {
  assert.ok(page);
  await page.setViewportSize({ width, height: 844 });
  await page.setContent(`<!doctype html><html dir="${options.dir ?? "ltr"}" data-density="${options.density ?? "comfortable"}"><head><meta name="viewport" content="width=device-width"><style>${css}</style><style>html,body{margin:0}</style></head><body>${fixture}</body></html>`);
  return page.evaluate(() => {
    const rtl = document.documentElement.dir === "rtl";
    const W = document.documentElement.clientWidth;
    const fromStart = (x: number) => rtl ? W - x : x;
    const rect = (el: Element) => el.getBoundingClientRect();
    const centreFromStart = (el: Element) => { const r = rect(el); return fromStart(r.left + r.width / 2); };
    const centreFromEnd = (el: Element) => W - centreFromStart(el);
    const endFromEnd = (el: Element) => { const r = rect(el); return rtl ? r.left : W - r.right; };
    const textStart = (el: Element) => { const range = document.createRange(); range.selectNodeContents(el); const r = range.getBoundingClientRect(); return fromStart(rtl ? r.right : r.left); };
    const q = (s: string) => document.querySelector(s)!;
    const all = (s: string) => [...document.querySelectorAll(s)];
    return {
      glyphCentre: centreFromStart(q(".project-glyph")),
      titleEdge: textStart(q(".mobile-nav-session-title")),
      sessionRow: rect(q(".mobile-nav-session-row")).height,
      sessionMore: centreFromEnd(q(".mobile-nav-more svg")),
      sessionMoreSize: rect(q(".mobile-nav-more svg")).width,
      flagEnd: endFromEnd(q("#flag")),
      chevrons: all(".agent-nav-chevron").map(centreFromStart),
      labels: all(".agent-nav-label").map(textStart),
      heads: all(".agent-nav-head").map((el) => rect(el).height),
      headMore: all(".agent-nav-head-action svg").map(centreFromEnd),
      leads: all(".agent-nav-row .agent-nav-lead").map(centreFromStart),
      leadSizes: all(".agent-nav-row .agent-nav-lead").map((el) => rect(el).width),
      names: all(".agent-nav-title").map(textStart),
      // The box edge: a truncated name in the other script direction
      // overflows (clipped) past its text start, so mirror on the box.
      nameBoxes: all(".agent-nav-title").map((el) => { const r = rect(el); return fromStart(rtl ? r.right : r.left); }),
      shortName: textStart(q("#glyph .agent-nav-title")),
      rows: all(".agent-nav-row").map((el) => rect(el).height),
      rowMore: all(".agent-nav-more svg").map(centreFromEnd),
      rowMoreSizes: all(".agent-nav-more svg").map((el) => rect(el).width),
      metaEnd: endFromEnd(q("#glyph .agent-nav-meta")),
      // A long name with no meta ends where a chat row's marks (and a
      // chat title without marks) do, not an empty column gap short.
      longNameEnd: endFromEnd(q("#stopped .agent-nav-title")),
      summaryMark: rect(q(".agent-nav-summary .agent-nav-mark")).width,
      summaryStart: (() => { const r = rect(q(".agent-nav-summary")); return fromStart(rtl ? r.right : r.left); })(),
      foldedLabelEnd: (() => { const r = rect(q("#folded-agents .agent-nav-label")); return fromStart(rtl ? r.left : r.right); })(),
      gapBelowOpenGroup: rect(q("#open .mobile-nav-session-row")).top - rect(q("#open-agents")).bottom,
      gapBelowFoldedGroup: rect(q("#folded .mobile-nav-session-row")).top - rect(q("#folded-agents")).bottom,
      caption: (() => {
        const style = (el: Element) => { const s = getComputedStyle(el); return [s.fontSize, s.fontWeight, s.letterSpacing, s.textTransform, s.color].join(" "); };
        return { label: style(q(".agent-nav-label")), divider: style(q(".mobile-nav-date-divider")) };
      })(),
      moreInk: { agent: getComputedStyle(q(".agent-nav-more")).color, head: getComputedStyle(q(".agent-nav-head-action")).color, session: getComputedStyle(q(".mobile-nav-more")).color },
      dotsFilled: all(".agent-nav :is(.agent-nav-more, .agent-nav-head-action) circle").length > 0
        && all(".agent-nav :is(.agent-nav-more, .agent-nav-head-action) circle").every((c) => getComputedStyle(c).fill !== "none" && getComputedStyle(c).stroke === "none"),
      overflow: all(".mobile-navigator *").some((el) => { const r = rect(el); return r.width > 0 && (r.left < -0.5 || r.right > W + 0.5); }),
    };
  });
}

const near = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= 0.6, `${label}: ${actual} ≠ ${expected}`);

for (const width of [320, 390, 430]) {
  for (const density of ["comfortable", "balanced", "compact"]) {
    test(`phone Agents group sits on the navigator grid at ${width}px, ${density}`, { skip: !CHROME }, async () => {
      const m = await measure(width, { density });
      for (const x of [...m.chevrons, ...m.leads]) near(x, m.glyphCentre, "chevron and agent marks centred under the project mark");
      for (const x of [...m.labels, ...m.names]) near(x, m.titleEdge, "group label and agent names on the session-title edge");
      for (const h of [...m.heads, ...m.rows]) near(h, m.sessionRow, "group header and agent rows are a chat row's height");
      for (const x of [...m.headMore, ...m.rowMore]) near(x, m.sessionMore, "⋮ shares the chat rows' trailing column");
      for (const s of m.rowMoreSizes) near(s, m.sessionMoreSize, "⋮ is the chat row's glyph size");
      for (const s of m.leadSizes) assert.ok(s <= 20, `an agent mark stays a state-mark size (${s}px)`);
      near(m.metaEnd, m.flagEnd, "the trailing measure ends where a chat row's marks do");
      assert.ok(m.summaryMark <= 18, `folded summary marks stay small (${m.summaryMark}px)`);
      assert.ok(m.summaryStart >= m.foldedLabelEnd, "folded summary follows the label");
      near(m.longNameEnd, m.flagEnd, "a long name truncates on the chat rows' trailing measure");
      near(m.gapBelowOpenGroup, 8, "an open group ends one rhythm step before the chats");
      near(m.gapBelowFoldedGroup, 0, "a folded group is one more line of the list");
      assert.equal(m.caption.label, m.caption.divider, "the group header uses the navigator's caption style");
      assert.equal(m.moreInk.agent, m.moreInk.session, "agent ⋮ shares the chat rows' quiet ink");
      assert.equal(m.moreInk.head, m.moreInk.session, "the group ⋮ shares the chat rows' quiet ink");
      assert.equal(m.dotsFilled, true, "agent ⋮ dots are filled like the chat rows' ⋮");
      assert.equal(m.overflow, false, "nothing leaves the screen");
    });
  }
}

test("phone Agents group mirrors in RTL", { skip: !CHROME }, async () => {
  const ltr = await measure(390);
  const rtl = await measure(390, { dir: "rtl" });
  for (const key of ["glyphCentre", "titleEdge", "sessionMore", "metaEnd", "longNameEnd"] as const) near(rtl[key], ltr[key], `${key} mirrors`);
  near(rtl.shortName, ltr.shortName, "a short Latin name sits on the RTL title edge");
  for (const key of ["chevrons", "labels", "leads", "nameBoxes", "rowMore"] as const) {
    rtl[key].forEach((x, i) => near(x, ltr[key][i]!, `${key} mirror`));
  }
});

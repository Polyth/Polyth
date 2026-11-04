// Phone Navigator geometry measured in a real browser (skipped without one).
// The list is one grid: project marks and session state marks share a leading
// column, names and titles share one start edge, and project ⋮ and session
// ⋮ share the trailing column. The toolbar's tools keep full tap boxes, and
// so do a project's New chat and ⋮; both clusters space their glyphs by
// visible ink. These checks hold at every phone width, density, status mix
// and direction.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import type { Browser, Page } from "playwright-core";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MoreVerticalIcon, NewChatIcon, SelectIcon, type LucideIcon } from "../src/components/ui/icons.ts";
import { findChromium } from "./chromium.ts";

register("./tsxHooks.mjs", import.meta.url);
const { Icon } = await import("../src/icons.tsx");

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const CHROME = await findChromium();

let browser: Browser | null = null;
let page = null as Page | null;
let css = "";

before(async () => {
  if (!CHROME) return;
  const files = await Promise.all([
    "../src/tokens.css",
    "../src/styles.css",
    "../src/components/mobile/MobileNavigator.css",
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
const icon = (size = "md") => `<svg class="ui-icon ui-icon--${size}" viewBox="0 0 24 24"><path d="M4 12h16"/></svg>`;
// The toolbar's tools and a project's New chat and ⋮ are spaced by their
// ink, so they draw the real glyphs, as UiIcon and Icon render them.
const lucide = (glyph: LucideIcon, size = "lg") =>
  renderToStaticMarkup(createElement(glyph, { className: `ui-icon ui-icon--${size}`, strokeWidth: 1.75, "aria-hidden": true }));
const glyph = (draw: FunctionComponent) => renderToStaticMarkup(createElement(draw));
const pill = (kind: string, count: number) =>
  `<span class="mobile-nav-project-status is-${kind}">${icon("sm").replace("ui-icon ", "ui-icon mobile-nav-state-icon ")}<span>${count}</span></span>`;

function project(id: string, name: string, pills: string, body = "") {
  return `<section class="mobile-nav-project${body ? " is-expanded" : ""}" id="${id}">
    <div class="mobile-nav-project-head">
      <span class="project-glyph">${svg}</span>
      <button class="mobile-nav-project-main"><span class="mobile-nav-project-name">${name}</span>${pills ? `<span class="mobile-nav-project-statuses">${pills}</span>` : ""}</button>
      <div class="mobile-nav-project-actions">
        <button class="mobile-nav-project-action">${lucide(NewChatIcon)}</button>
        <button class="mobile-nav-project-action" aria-haspopup="menu">${lucide(MoreVerticalIcon)}</button>
      </div>
    </div>
    ${body ? `<div class="mobile-nav-project-body">${body}</div>` : ""}
  </section>`;
}

function session(title: string, lead: string, flags = "", children = 0, clock = "") {
  const pill = children ? `<button class="mobile-nav-subagent-toggle" aria-expanded="false">${svg}<span class="mobile-nav-subagent-count">${children}</span></button>` : "";
  return `<div class="mobile-nav-session-swipe"><div class="mobile-nav-session-row">
    <button class="mobile-nav-session-main"></button>
    <span class="mobile-nav-session-body">
      <span class="mobile-nav-session-lead">${lead}</span>
      <span class="mobile-nav-session-heading"><span class="mobile-nav-session-title" dir="auto">${title}</span>${pill}</span>
      <span class="mobile-nav-session-trailing">${clock ? `<span class="mobile-nav-duration">${clock}</span>` : ""}<span class="mobile-nav-session-flags">${flags}</span></span>
    </span>
    <button class="mobile-nav-more">${lucide(MoreVerticalIcon, "md")}</button>
  </div></div>`;
}

// The bar's two faces share one cell; the closed search face is inert, as in
// MobileNavigator.tsx, so taps reach the tools under it.
const fixture = `<nav class="mobile-navigator" style="animation:none">
  <div class="mobile-nav-toolbar" style="animation:none">
    <div class="mobile-nav-toolbar-row">
      <button class="mobile-nav-place"><span class="mobile-nav-place-name">Personal</span>${svg}</button>
      <div class="mobile-nav-tools">
        <button class="mobile-nav-tool mobile-nav-search-toggle" id="search-tool">${glyph(Icon.search)}<span class="mobile-nav-filter-dot"></span></button>
        <button class="mobile-nav-tool mobile-nav-select-toggle" id="select">${lucide(SelectIcon)}</button>
        <button class="mobile-nav-tool" id="settings">${glyph(Icon.gear)}</button>
        <button class="mobile-nav-tool" id="close">${glyph(Icon.close)}</button>
      </div>
    </div>
    <div class="mobile-nav-search-bar" inert>
      <button class="mobile-nav-tool mobile-nav-search-back" id="back">${svg}</button>
      <div class="mobile-nav-search">${svg}<input type="search" placeholder="Search sessions…"><button class="mobile-nav-filter">${svg}</button></div>
    </div>
  </div>
  <div class="mobile-nav-scroll" style="animation:none">
    ${project("open", "polyth", "", `
      <div class="mobile-nav-pinned">${session("Pinned and running", "", `<span class="mobile-nav-pin-icon">${svg}</span>`, 0, "3h")}</div>
      ${session("Running a session whose title is long enough to truncate before its clock", "", "", 0, "42m")}
      ${session("Plain session title long enough to truncate before its subagent count", "", "", 4)}
      ${session("Running session", `<span class="mobile-nav-running-ring"></span>`, `<span class="isolation-list-badge" id="flag">${svg}</span>`)}
      ${session("A plain session title with no marks that is long enough to truncate at the trailing edge", "")}
      <div class="mobile-nav-pagination"><button class="mobile-nav-more-sessions">Show less</button></div>`)}
    ${project("empty", "empty-project", "", `<p class="mobile-nav-project-empty">No sessions yet</p>`)}
    ${project("busy", "busy-project", [pill("running", 3), pill("waiting", 2), pill("failed", 1), pill("limited", 1), pill("complete", 12)].join(""))}
  </div>
</nav>`;

async function measure(width: number, options: { density?: string; dir?: "ltr" | "rtl" } = {}) {
  assert.ok(page);
  await page.setViewportSize({ width, height: 844 });
  await page.setContent(`<!doctype html><html dir="${options.dir ?? "ltr"}" data-density="${options.density ?? "comfortable"}"><head><meta name="viewport" content="width=device-width"><style>${css}</style><style>html,body{margin:0}</style></head><body>${fixture}</body></html>`);
  return page.evaluate(() => {
    const rtl = document.documentElement.dir === "rtl";
    const W = document.documentElement.clientWidth;
    // Distances from the inline-start / inline-end screen edge.
    const fromStart = (x: number) => rtl ? W - x : x;
    const rect = (el: Element) => el.getBoundingClientRect();
    const start = (el: Element) => { const r = rect(el); return fromStart(rtl ? r.right : r.left); };
    const centreFromStart = (el: Element) => { const r = rect(el); return fromStart(r.left + r.width / 2); };
    const centreFromEnd = (el: Element) => W - centreFromStart(el);
    const textStart = (el: Element) => { const range = document.createRange(); range.selectNodeContents(el); const r = range.getBoundingClientRect(); return fromStart(rtl ? r.right : r.left); };
    const q = (s: string) => document.querySelector(s)!;
    const all = (s: string) => [...document.querySelectorAll(s)];
    const busy = q("#busy");
    const busyPills = [...busy.querySelectorAll(".mobile-nav-project-status")];
    const statuses = rect(busy.querySelector(".mobile-nav-project-statuses")!);
    const busyNewChat = rect(busy.querySelector(".mobile-nav-project-action svg")!);
    const endFromEnd = (el: Element) => { const r = rect(el); return rtl ? r.left : W - r.right; };
    const startFromEnd = (el: Element) => { const r = rect(el); return rtl ? r.right : W - r.left; };
    // A glyph's visible ink, not its box: each shape grown by half its stroke.
    const ink = (svg: Element) => {
      let left = Infinity, right = -Infinity;
      for (const shape of svg.querySelectorAll<SVGGraphicsElement>("path, circle")) {
        const b = shape.getBBox();
        const half = parseFloat(getComputedStyle(shape).strokeWidth) / 2;
        const m = shape.getScreenCTM()!;
        for (const x of [b.x - half, b.x + b.width + half]) {
          const p = new DOMPoint(x, b.y).matrixTransform(m);
          left = Math.min(left, p.x);
          right = Math.max(right, p.x);
        }
      }
      return { left, right };
    };
    const inkEnd = (svg: Element) => { const i = ink(svg); return rtl ? i.left : W - i.right; };
    const inkStart = (svg: Element) => { const i = ink(svg); return rtl ? i.right : W - i.left; };
    const busyDots = busy.querySelector(".mobile-nav-project-actions > :last-child svg")!;
    const busyBubble = busy.querySelector(".mobile-nav-project-actions > :first-child svg")!;
    return {
      W,
      place: textStart(q(".mobile-nav-place-name")),
      // Closed, Back waits nudged aside for its entry; its open place is its
      // untransformed box.
      backCentre: (() => {
        const back = q("#back") as HTMLElement;
        back.style.transition = back.style.transform = "none";
        const centre = centreFromStart(q("#back svg"));
        back.style.transition = back.style.transform = "";
        return centre;
      })(),
      searchEnd: endFromEnd(q(".mobile-nav-search")),
      // The truncating title of the row with no marks or subagent pill.
      plainTitleEnd: endFromEnd(all(".mobile-nav-session-title")[4]!),
      flagEnd: endFromEnd(q("#flag")),
      // A running clock's air, on its ink: the ⋮ dots to the clock's last
      // character, the title's end to its box, and the screen edge to the dots.
      ...(() => {
        const clocks = all(".mobile-nav-duration");
        // The clock reads left to right in either direction, so the
        // character nearest ⋮ is its last in LTR and its first in RTL.
        const textEnd = (el: Element) => {
          const node = el.firstChild as Text;
          const at = rtl ? 0 : node.length - 1;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 1);
          const box = range.getBoundingClientRect();
          const style = getComputedStyle(el);
          const context = document.createElement("canvas").getContext("2d")!;
          context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const ink = context.measureText(node.data[at]!);
          return rtl ? box.left - ink.actualBoundingBoxLeft : W - (box.left + ink.actualBoundingBoxRight);
        };
        const dots = (el: Element) => el.closest(".mobile-nav-session-row")!.querySelector(".mobile-nav-more svg")!;
        const clock = clocks[1]!;
        const title = rect(clock.closest(".mobile-nav-session-row")!.querySelector(".mobile-nav-session-title")!);
        return {
          rowEdgeGap: inkEnd(dots(clock)),
          clockGap: textEnd(clock) - inkStart(dots(clock)),
          pinnedClockGap: textEnd(clocks[0]!) - inkStart(dots(clocks[0]!)),
          clockLead: rtl ? title.left - rect(clock).right : rect(clock).left - title.right,
        };
      })(),
      // Edge controls draw a small circle on the edge column but keep a
      // target that runs out to the edge. A row's ⋮ keeps 44px (the body
      // tucks over it); close and project ⋮ meet their neighbour's target.
      edgeTargets: (() => {
        const y = (el: Element) => { const r = rect(el); return r.top + r.height / 2; };
        const at = (fromEnd: number, row: Element) => {
          const x = rtl ? fromEnd : W - fromEnd;
          return document.elementFromPoint(x, y(row))?.closest("button");
        };
        const width = (el: Element) => rect(el).width;
        const close = q("#close");
        const settings = q("#settings");
        const projectMore = q("#open .mobile-nav-project-actions > :last-child");
        const projectNew = q("#open .mobile-nav-project-actions > :first-child");
        const rowMore = q(".mobile-nav-more");
        const rowEdge = endFromEnd(q(".mobile-nav-session-row"));
        return [
          at(1, close) === close, at(width(close) - 1, close) === close, at(width(close) + 1, close) === settings,
          at(1, projectMore) === projectMore, at(width(projectMore) - 1, projectMore) === projectMore,
          at(width(projectMore) + 1, projectMore) === projectNew,
          at(rowEdge + 1, rowMore) === rowMore, at(rowEdge + 43, rowMore) === rowMore,
        ];
      })(),
      targets: all(".mobile-nav-tools > .mobile-nav-tool, .mobile-nav-project-action").map((el) => [rect(el).width, rect(el).height] as const),
      toolBoxes: all(".mobile-nav-tools > .mobile-nav-tool:not(:last-child)").map((el) => [rect(el).width, rect(el).height] as const),
      rowMoreWash: [rect(q(".mobile-nav-more")).width, rect(q(".mobile-nav-more")).height, rect(q(".mobile-nav-session-row")).height] as const,
      // The toolbar's visible air: the bar's edge to ×, × to the gear, the
      // gear to select's box, the box to the lens.
      toolGaps: (() => {
        const tools = ["#close", "#settings", "#select", "#search-tool"].map((s) => q(`${s} svg`));
        return tools.map((svg, i) => inkEnd(svg) - (i ? inkStart(tools[i - 1]!) : 0));
      })(),
      toolInkInTarget: ["#close", "#settings", "#select", "#search-tool"].map((s) => {
        const i = ink(q(`${s} svg`));
        const t = rect(q(s));
        return i.left >= t.left - 0.01 && i.right <= t.right + 0.01;
      }),
      // The closed search pill is a circle centred --nav-search-axis from
      // the bar's end; opening grows it out of the lens.
      seedOffset: (() => {
        const bar = q(".mobile-nav-search-bar");
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;width:var(--nav-search-axis);height:1px";
        bar.append(probe);
        const axis = rect(probe).width;
        probe.remove();
        return axis - (W - endFromEnd(bar) - centreFromStart(q("#search-tool svg")));
      })(),
      // The filter dot marks the lens's top-end corner.
      filterDot: (() => {
        const dot = rect(q(".mobile-nav-filter-dot"));
        const lens = rect(q("#search-tool svg"));
        return [rtl ? lens.left - dot.left : dot.right - lens.right, lens.top - dot.top] as const;
      })(),
      projectNew: all(".mobile-nav-project-actions > :first-child svg").map(centreFromEnd),
      // The visible air in a project's trailing cluster: screen edge to the ⋮
      // dots, dots to New chat's bubble, bubble to the status pills.
      edgeGap: inkEnd(busyDots),
      dotsGap: inkEnd(busyBubble) - inkStart(busyDots),
      pillsGap: endFromEnd(busy.querySelector(".mobile-nav-project-statuses")!) - inkStart(busyBubble),
      bubbleInTarget: (() => {
        const i = ink(busyBubble);
        const t = rect(busyBubble.closest("button")!);
        return i.left >= t.left - 0.01 && i.right <= t.right + 0.01;
      })(),
      newChatWidth: rect(busyBubble.closest("button")!).width,
      projectGlyphSizes: all(".mobile-nav-project-action svg").map((el) => [rect(el).width, rect(el).height] as const),
      toolGlyph: rect(q("#settings svg")).width,
      glyphs: all(".project-glyph").map(start),
      glyphCentre: centreFromStart(q(".project-glyph")),
      leads: all(".mobile-nav-session-lead").map(centreFromStart),
      names: all(".mobile-nav-project-name").map(textStart),
      titles: all(".mobile-nav-session-title").map(textStart),
      // Titles carry dir="auto": a truncated title in the other direction
      // overflows (clipped) past its text start, so mirror on the box edge.
      titleBoxes: all(".mobile-nav-session-title").map(start),
      pagination: textStart(q(".mobile-nav-more-sessions")),
      empty: textStart(q(".mobile-nav-project-empty")),
      projectMore: all(".mobile-nav-project-actions > :last-child svg").map(centreFromEnd),
      rowMore: all(".mobile-nav-more svg").map(centreFromEnd),
      flag: centreFromEnd(q("#flag")),
      type: (() => {
        const s = (el: Element) => getComputedStyle(el);
        const name = s(q(".mobile-nav-project-name"));
        const title = s(q(".mobile-nav-session-title"));
        return { name: parseFloat(name.fontSize), nameWeight: Number(name.fontWeight), title: parseFloat(title.fontSize), titleWeight: Number(title.fontWeight) };
      })(),
      pillFont: parseFloat(getComputedStyle(q(".mobile-nav-subagent-toggle")).fontSize),
      // A row without marks: its subagent pill must stay clear of the part of
      // the row the ⋮ control tucks over, or its end would open the menu.
      pillClearOfMenu: (() => {
        const row = q(".mobile-nav-subagent-toggle").closest(".mobile-nav-session-row")!;
        const pill = rect(q(".mobile-nav-subagent-toggle"));
        const menu = rect(row.querySelector(".mobile-nav-more")!);
        return rtl ? pill.left >= menu.right - 0.5 : pill.right <= menu.left + 0.5;
      })(),
      metaFont: parseFloat(getComputedStyle(q(".mobile-nav-project-status")).fontSize),
      searchHeight: rect(q(".mobile-nav-search")).height,
      toolHeight: rect(q("#settings")).height,
      ink: { row: getComputedStyle(q(".mobile-nav-more")).color, project: getComputedStyle(q(".mobile-nav-project-action[aria-haspopup]")).color, muted: getComputedStyle(q(".mobile-nav-search > svg")).color },
      busyName: rect(busy.querySelector(".mobile-nav-project-name")!).width,
      busyFontSize: parseFloat(getComputedStyle(busy.querySelector(".mobile-nav-project-name")!).fontSize),
      // A pill is shown when it sits inside the clipped first line.
      shownPills: busyPills.filter((p) => { const r = rect(p); return r.top >= statuses.top - 0.5 && r.bottom <= statuses.bottom + 0.5; }).map((p) => p.className.replace(/.* is-/, "")),
      pillsClearOfActions: rtl ? statuses.left >= busyNewChat.right : statuses.right <= busyNewChat.left,
      overflow: all(".mobile-navigator *").some((el) => { const r = rect(el); return r.width > 0 && (r.left < -0.5 || r.right > W + 0.5) && !el.closest(".mobile-nav-session-underlay"); }),
    };
  });
}

const near = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= 0.6, `${label}: ${actual} ≠ ${expected}`);

// gutter: content edge, the ⋮ glyph's own edge; axis: end-column glyph
// centre from the screen; titleStart: gutter + 24px mark + 8px.
for (const [width, gutter, axis, titleStart] of [[320, 11, 20, 43], [390, 15, 24, 47], [430, 15, 24, 47]] as const) {
  for (const density of ["comfortable", "compact"]) {
    test(`phone navigator grid holds at ${width}px, ${density}`, { skip: !CHROME }, async () => {
      const m = await measure(width, { density });
      near(m.place, gutter, "the toolbar title starts on the content edge");
      near(m.searchEnd, gutter, "the open search field ends on the content edge");
      for (const g of m.glyphs) near(g, gutter, "project mark on the content edge");
      near(m.glyphCentre, gutter + 12, "a 24px project mark: the leading column is no wider than the marks need");
      // Both ends of a row keep the same air: the start edge is the ⋮ glyph's
      // own edge (the axis less half an 18px glyph).
      near(m.glyphs[0]!, axis - 9, "the start edge sits on the ⋮ glyph's edge, so the two margins measure the same");
      near(m.backCentre, m.glyphCentre, "search's Back glyph sits over the project marks");
      for (const lead of m.leads) near(lead, m.glyphCentre, "session state mark centred under the project mark");
      const titleEdge = m.names[0]!;
      near(titleEdge, titleStart, "titles start one mark and one gap in, not a wasted indent");
      for (const x of [...m.names, ...m.titles, m.pagination, m.empty]) near(x, titleEdge, "names, titles, pagination and empty text share one edge");
      near(m.plainTitleEnd, m.flagEnd, "a title with no marks ends where marks do, not a column gap short");
      for (const x of [...m.projectMore, ...m.rowMore]) near(x, axis, "project ⋯ and session ⋯ glyphs share the edge column, clear of the screen's rounded edge");
      // A chat row's trailing marks are spaced by ink too: the running clock
      // stands as far from the ⋮ dots as the dots from the screen edge, so
      // marks end two axes in; the first mark keeps 12px from the title.
      near(m.flagEnd, 2 * axis, "a session's trailing marks end two axes in");
      near(m.rowEdgeGap, axis - 1.4, "a session's ⋮ dots stay on the edge column");
      near(m.clockGap, m.rowEdgeGap, "the running clock stands as far from ⋮ as ⋮ from the screen edge");
      near(m.pinnedClockGap, m.clockGap, "a Pinned row's hidden pin leaves no lead-in before ⋮");
      near(m.clockLead, 12, "a running clock keeps 12px from a truncated title");
      const air = m.rowEdgeGap;
      // The toolbar's tools are its primary controls: a full tap box each,
      // never squeezed into the row-mark rhythm below.
      for (const [w, h] of m.toolBoxes) assert.ok(w >= 44 && h >= 44, `a toolbar tool keeps the 44px tap floor (${w}×${h})`);
      const [washW, washH, rowH] = m.rowMoreWash;
      near(washW, 28, "a row's ⋮ press circle keeps its size whatever the axis");
      assert.ok(washW === washH && washH <= rowH, `the ⋮ circle (${washW}×${washH}) fits its row (${rowH}px)`);
      for (const [w, h] of m.projectGlyphSizes) {
        assert.ok(w === m.toolGlyph && h === m.toolGlyph, `a project's New chat and ⋮ draw the toolbar's glyph size (${w}×${h} vs ${m.toolGlyph})`);
      }
      // One visible rhythm across a project's cluster, measured on the ink
      // (the ⋮ dots are 3px wide in a 20px box): the screen edge, the dots,
      // New chat's bubble and the pills stand the same air apart. Only the
      // narrowest axis is too tight for that and two 44px targets, so there
      // the two inner gaps share the extra.
      near(m.edgeGap, axis - 1.6, "the ⋮ dots stay on the edge column");
      near(m.pillsGap, m.dotsGap, "the pills stand as far from New chat as New chat from ⋮");
      if (axis >= 24) near(m.dotsGap, m.edgeGap, "New chat stands as far from ⋮ as ⋮ from the screen edge");
      else assert.ok(m.dotsGap > m.edgeGap && m.dotsGap - m.edgeGap <= 6, `the narrow axis widens only the inner gaps (${m.dotsGap} vs ${m.edgeGap})`);
      near(m.newChatWidth, 44, "New chat keeps a full tap box");
      assert.equal(m.bubbleInTarget, true, "New chat's bubble lies inside its own target, never ⋮'s");
      // The toolbar keeps that rhythm on its own ink: the edge, ×, the gear,
      // select's box and the lens stand one gap apart. The gap is the
      // cluster's edge air, so × ends where the ⋮ dots below it do, unless
      // four 44px targets need more, which only the narrowest axis does.
      const [toolEdge] = m.toolGaps as [number];
      for (const gap of m.toolGaps) near(gap, toolEdge, "toolbar glyphs stand one gap apart, the edge included");
      if (axis >= 24) near(toolEdge, m.edgeGap, "× ends where the ⋮ dots below it do");
      else assert.ok(toolEdge > m.edgeGap && toolEdge - m.edgeGap <= 3, `the narrow axis widens the toolbar's gap only as far as its targets need (${toolEdge} vs ${m.edgeGap})`);
      assert.deepEqual(m.toolInkInTarget, [true, true, true, true], "each tool's glyph lies inside its own target");
      near(m.seedOffset, 0, "the search pill grows out of the lens");
      near(m.filterDot[0], 1, "the filter dot sits on the lens's end corner");
      near(m.filterDot[1], 1, "the filter dot sits on the lens's top corner");
      assert.ok(m.pillsGap >= air - 0.6, `status pills stop at least a row's mark air before New chat (${m.pillsGap})`);
      assert.deepEqual(m.edgeTargets, [true, true, true, true, true, true, true, true], "edge targets run out to the edge and meet their neighbour's");
      for (const [w, h] of m.targets) {
        assert.ok(w >= 44 && h >= 44, `a toolbar or project target keeps the 44px tap floor (${w}×${h})`);
      }
      assert.ok(m.pillsClearOfActions, "status pills never run into New chat");
      assert.ok(m.busyName >= Math.min(5 * m.busyFontSize, 80) - 1, `a busy project keeps a readable name (${m.busyName}px)`);
      assert.deepEqual(m.shownPills, ["running", "waiting", "failed", "limited", "complete"].slice(0, m.shownPills.length),
        "pills that do not fit leave whole, least urgent first");
      assert.ok(m.shownPills.length >= 1);
      assert.equal(m.overflow, false, "nothing leaves the screen");
      assert.ok(m.type.title <= m.type.name && m.type.titleWeight < m.type.nameWeight,
        `a chat title never outranks its project name (${m.type.title}/${m.type.titleWeight} vs ${m.type.name}/${m.type.nameWeight})`);
      near(m.pillFont, m.metaFont, "the subagent count is metadata caliber, not the row's size");
      assert.equal(m.pillClearOfMenu, true, "a subagent pill never sits under the ⋮ control's tucked edge");
      near(m.searchHeight, m.toolHeight, "the search field shares the tools' height");
      assert.equal(m.ink.project, m.ink.row, "project and session ⋮ share the quiet ink");
      assert.notEqual(m.ink.row, m.ink.muted, "repeated ⋮ is quieter than the muted ink");
    });
  }
}

test("phone navigator grid mirrors in RTL", { skip: !CHROME }, async () => {
  const ltr = await measure(390);
  const rtl = await measure(390, { dir: "rtl" });
  for (const key of ["place", "searchEnd", "glyphCentre", "backCentre", "pagination", "empty", "flag", "flagEnd", "plainTitleEnd", "edgeGap", "dotsGap", "pillsGap", "rowEdgeGap", "clockLead"] as const) {
    near(rtl[key], ltr[key], `${key} mirrors`);
  }
  for (const key of ["toolGaps", "projectNew", "filterDot"] as const) rtl[key].forEach((x, i) => near(x, ltr[key][i]!, `${key} mirror`));
  near(rtl.seedOffset, 0, "the search pill grows out of the lens in RTL");
  near(rtl.clockGap, rtl.rowEdgeGap, "the running clock keeps its air from ⋮ in RTL");
  near(rtl.pinnedClockGap, rtl.clockGap, "a Pinned row's clock keeps it too");
  for (const [a, b] of rtl.titleBoxes.map((x, i) => [x, ltr.titleBoxes[i]!] as const)) near(a, b, "titles mirror");
  assert.equal(rtl.pillsClearOfActions, true);
  assert.equal(rtl.pillClearOfMenu, true);
  assert.deepEqual(rtl.edgeTargets, ltr.edgeTargets, "edge targets mirror");
});

// Opening a project is the whole line. A press lights one plate from the
// mark to ⋮ in the row's corner; the shared button press (the .98 settle and
// inset washes) and the system tap highlight never paint the button's own
// box, which drew a patch between the mark and New chat.
test("a pressed project lights its whole line, not the button's box", { skip: !CHROME }, async () => {
  assert.ok(page);
  await measure(390);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#busy .mobile-nav-project-main" });
  const read = () => page!.evaluate(() => {
    const head = document.querySelector("#busy .mobile-nav-project-head")!;
    const main = head.querySelector(".mobile-nav-project-main")!;
    const glyph = head.querySelector(".project-glyph")!;
    const box = head.getBoundingClientRect();
    const own = getComputedStyle(main);
    const plate = getComputedStyle(main, "::before");
    // The mark passes taps through, so the plate (the button) takes them.
    const g = glyph.getBoundingClientRect();
    const hit = document.elementFromPoint(g.left + g.width / 2, g.top + g.height / 2);
    return {
      headWidth: box.width, headHeight: box.height,
      plateWidth: parseFloat(plate.width), plateHeight: parseFloat(plate.height),
      plate: plate.backgroundColor, ownShadow: own.boxShadow, ownTransform: own.transform,
      tap: own.getPropertyValue("-webkit-tap-highlight-color"),
      markOpens: hit === main,
    };
  });
  const rest = await read();
  assert.equal(rest.plate, "rgba(0, 0, 0, 0)", "the plate is clear at rest");
  assert.equal(rest.tap, "rgba(0, 0, 0, 0)", "no system highlight on the button's own box");
  assert.equal(rest.markOpens, true, "a tap on the mark opens the project too");
  await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["active"] });
  try {
    const pressed = await read();
    near(pressed.plateWidth, pressed.headWidth, "the plate spans the whole line");
    near(pressed.plateHeight, pressed.headHeight, "and its full height");
    assert.notEqual(pressed.plate, "rgba(0, 0, 0, 0)", "the plate lights under the finger");
    assert.equal(pressed.ownShadow, "none", "no inset wash on the button's own box");
    assert.equal(pressed.ownTransform, "none", "no settle that shrinks the button's box");
  } finally {
    await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    await cdp.detach();
  }
});

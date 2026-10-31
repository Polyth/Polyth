// Phone Navigator geometry measured in a real browser (skipped without one).
// The list is one grid: project marks and session state marks share a leading
// column, names and titles share one start edge, and close, project ⋮ and
// session ⋮ share the trailing column. The toolbar's tools keep full tap
// boxes; a project's New chat steps the way a chat row's marks step toward
// its ⋮. These checks hold at
// every phone width, density, status mix and direction.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Browser, Page } from "playwright-core";
import { findChromium } from "./chromium.ts";

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
const pill = (kind: string, count: number) =>
  `<span class="mobile-nav-project-status is-${kind}">${icon("sm").replace("ui-icon ", "ui-icon mobile-nav-state-icon ")}<span>${count}</span></span>`;

function project(id: string, name: string, pills: string, body = "") {
  return `<section class="mobile-nav-project${body ? " is-expanded" : ""}" id="${id}">
    <div class="mobile-nav-project-head">
      <span class="project-glyph">${svg}</span>
      <button class="mobile-nav-project-main"><span class="mobile-nav-project-name">${name}</span>${pills ? `<span class="mobile-nav-project-statuses">${pills}</span>` : ""}</button>
      <div class="mobile-nav-project-actions">
        <button class="mobile-nav-project-action">${icon("lg")}</button>
        <button class="mobile-nav-project-action" aria-haspopup="menu">${svg}</button>
      </div>
    </div>
    ${body ? `<div class="mobile-nav-project-body">${body}</div>` : ""}
  </section>`;
}

function session(title: string, lead: string, flags = "", children = 0) {
  const pill = children ? `<button class="mobile-nav-subagent-toggle" aria-expanded="false">${svg}<span class="mobile-nav-subagent-count">${children}</span></button>` : "";
  return `<div class="mobile-nav-session-swipe"><div class="mobile-nav-session-row">
    <button class="mobile-nav-session-main"></button>
    <span class="mobile-nav-session-body">
      <span class="mobile-nav-session-lead">${lead}</span>
      <span class="mobile-nav-session-heading"><span class="mobile-nav-session-title" dir="auto">${title}</span>${pill}</span>
      <span class="mobile-nav-session-trailing"><span class="mobile-nav-session-flags">${flags}</span></span>
    </span>
    <button class="mobile-nav-more">${svg}</button>
  </div></div>`;
}

// The bar's two faces share one cell; the closed search face is inert, as in
// MobileNavigator.tsx, so taps reach the tools under it.
const fixture = `<nav class="mobile-navigator" style="animation:none">
  <div class="mobile-nav-toolbar" style="animation:none">
    <div class="mobile-nav-toolbar-row">
      <button class="mobile-nav-place"><span class="mobile-nav-place-name">Personal</span>${svg}</button>
      <div class="mobile-nav-tools">
        <button class="mobile-nav-tool mobile-nav-search-toggle" id="search-tool">${svg}</button>
        <button class="mobile-nav-tool mobile-nav-select-toggle" id="select">${icon("lg")}</button>
        <button class="mobile-nav-tool" id="settings">${svg}</button>
        <button class="mobile-nav-tool" id="close">${svg}</button>
      </div>
    </div>
    <div class="mobile-nav-search-bar" inert>
      <button class="mobile-nav-tool mobile-nav-search-back" id="back">${svg}</button>
      <div class="mobile-nav-search">${svg}<input type="search" placeholder="Search sessions…"><button class="mobile-nav-filter">${svg}</button></div>
    </div>
  </div>
  <div class="mobile-nav-scroll" style="animation:none">
    ${project("open", "polyth", "", `
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
      plainTitleEnd: endFromEnd(all(".mobile-nav-session-title")[2]!),
      flagEnd: endFromEnd(q("#flag")),
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
      closeWidth: rect(q("#close")).width,
      rowMoreWash: [rect(q(".mobile-nav-more")).width, rect(q(".mobile-nav-more")).height, rect(q(".mobile-nav-session-row")).height] as const,
      tools: ["#close", "#settings", "#select", "#search-tool"].map((s) => centreFromEnd(q(`${s} svg`))),
      projectNewEnd: all(".mobile-nav-project-actions > :first-child svg").map(endFromEnd),
      pillsGap: endFromEnd(busy.querySelector(".mobile-nav-project-statuses")!) - startFromEnd(busy.querySelector(".mobile-nav-project-action svg")!),
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

// gutter: content edge; axis: end-column glyph centre from the screen;
// titleStart: gutter + 24px mark + 8px.
for (const [width, gutter, axis, titleStart] of [[320, 6, 20, 38], [390, 8, 24, 40], [430, 8, 24, 40]] as const) {
  for (const density of ["comfortable", "compact"]) {
    test(`phone navigator grid holds at ${width}px, ${density}`, { skip: !CHROME }, async () => {
      const m = await measure(width, { density });
      near(m.place, gutter, "the toolbar title starts on the content edge");
      near(m.searchEnd, gutter, "the open search field ends on the content edge");
      for (const g of m.glyphs) near(g, gutter, "project mark on the content edge");
      near(m.glyphCentre, gutter + 12, "a 24px project mark: the leading column is no wider than the marks need");
      assert.ok(m.glyphCentre - axis <= 2.6, `the leading column (${m.glyphCentre}px) sits no further in than the ⋮ axis (${axis}px), so the start side carries no extra margin`);
      near(m.backCentre, m.glyphCentre, "search's Back glyph sits over the project marks");
      for (const lead of m.leads) near(lead, m.glyphCentre, "session state mark centred under the project mark");
      const titleEdge = m.names[0]!;
      near(titleEdge, titleStart, "titles start one mark and one gap in, not a wasted indent");
      for (const x of [...m.names, ...m.titles, m.pagination, m.empty]) near(x, titleEdge, "names, titles, pagination and empty text share one edge");
      near(m.plainTitleEnd, m.flagEnd, "a title with no marks ends where marks do, not a column gap short");
      const [close, settings, select, search] = m.tools as [number, number, number, number];
      for (const x of [close, ...m.projectMore, ...m.rowMore]) near(x, axis, "close, project ⋯ and session ⋯ glyphs share the edge column, clear of the screen's rounded edge");
      near(m.flagEnd, axis + 13, "a session's trailing marks end 12px clear of its ⋮ dots");
      // A chat row's air between its last mark and the ⋮ dots (whose ink
      // runs 1px past the axis) is the rhythm of every trailing cluster.
      const air = m.flagEnd - axis - 1;
      // The toolbar's tools are its primary controls: a full tap box each,
      // never squeezed into the row-mark rhythm below.
      for (const step of [search - select, select - settings, settings - close]) near(step, 44, "toolbar glyphs sit one tap step apart");
      for (const [w, h] of m.toolBoxes) assert.ok(w >= 44 && h >= 44, `a toolbar tool keeps the 44px tap floor (${w}×${h})`);
      const [washW, washH, rowH] = m.rowMoreWash;
      near(washW, 28, "a row's ⋮ press circle is a project ⋮'s, whatever the axis");
      assert.ok(washW === washH && washH <= rowH, `the ⋮ circle (${washW}×${washH}) fits its row (${rowH}px)`);
      near(m.closeWidth, axis + 22, "close's target runs half a tap step inside its glyph and out to the edge");
      for (const x of m.projectNewEnd) near(x, m.flagEnd, "New chat ends where a chat row's marks end");
      near(m.pillsGap, air, "status pills stop that same air before New chat");
      assert.deepEqual(m.edgeTargets, [true, true, true, true, true, true, true, true], "edge targets run out to the edge and meet their neighbour's");
      for (const [w, h] of m.targets) {
        assert.ok(w >= 24 && h >= 44, `a toolbar or project target spans the room between its neighbours, the full height, and at least WCAG 2.2's 24px (${w}×${h})`);
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
  for (const key of ["place", "searchEnd", "glyphCentre", "backCentre", "pagination", "empty", "flag", "flagEnd", "plainTitleEnd", "pillsGap"] as const) {
    near(rtl[key], ltr[key], `${key} mirrors`);
  }
  for (const key of ["tools", "projectNewEnd"] as const) rtl[key].forEach((x, i) => near(x, ltr[key][i]!, `${key} mirror`));
  for (const [a, b] of rtl.titleBoxes.map((x, i) => [x, ltr.titleBoxes[i]!] as const)) near(a, b, "titles mirror");
  assert.equal(rtl.pillsClearOfActions, true);
  assert.equal(rtl.pillClearOfMenu, true);
  assert.deepEqual(rtl.edgeTargets, ltr.edgeTargets, "edge targets mirror");
});

// Desktop navigator pills, measured in a real browser (skipped without one):
// chat rows, this package's agent rows under the Agents action, and the
// action rows share one pill geometry (--nav-pill-air on both sides). It
// lives with the agents package because it renders the package's own rows;
// the host never names a removable package.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

// Measured in real Chromium: every navigator pill (chat rows hugged, with a
// state mark, pinned and current; agent rows; New chat and an action row)
// keeps --nav-pill-air before its first content and after its last trailing
// mark, ends on one shared edge and stays 2px clear of the scrollbar, in
// both directions and densities. Fluent's accent bar rides the pill start.
test("navigator pills keep 10px of air on both sides and stay clear of the scrollbar", async (t) => {
  const { findChromium } = await import("../../../apps/web/test/chromium.ts");
  const executablePath = await findChromium();
  if (!executablePath) { t.skip("no Chromium"); return; }
  const { chromium } = await import("playwright-core");
  const css = (await Promise.all([
    "../../../apps/web/src/tokens.css", "../../../apps/web/src/styles.css", "../../../apps/web/src/fluentTheme.css",
    "../widgets/styles.css",
  ].map(source))).join("\n");
  const glyph = `<svg width="15" height="15" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>`;
  const row = (id: string, lead: "empty" | "mark", cls = "", leadHtml = "", meta = "") => `<div id="${id}" class="session-row idle ${cls}" data-lead="${lead}"><button class="session-btn" type="button"></button><span class="session-row-body"><span class="session-lead">${leadHtml}</span><span class="session-title"><span class="session-title-text">A fairly long chat title that truncates</span></span><span class="session-status-zone">${meta}<span class="session-identity"></span></span></span></div>`;
  const agent = (id: string, cls = "") => `<div id="${id}" class="agent-nav-row ${cls}"><button class="agent-nav-btn" type="button"><span class="agent-nav-lead"><span class="agent-nav-glyph">${glyph}</span></span><span class="agent-nav-title">Nightly release captain</span><span class="agent-nav-meta">in 3h</span></button></div>`;
  const fixture = `<aside class="sidebar" style="height:700px"><div class="sidebar-main"><div class="sidebar-nav-block">
    <button id="new" class="sidebar-nav-row sidebar-nav-new" type="button"><span class="sidebar-nav-glyph">${glyph}</span><span class="sidebar-nav-label">New chat</span></button>
    <div class="sidebar-nav-actions"><div class="sidebar-nav-item"><button id="action" class="sidebar-nav-row sidebar-nav-action" type="button"><span class="sidebar-nav-glyph">${glyph}</span><span class="sidebar-nav-label">Agents</span></button>
    <div class="sidebar-nav-section"><div class="agent-nav" data-placement="action"><div class="agent-nav-rows">${agent("agent")}${agent("agentActive", "active")}</div></div></div></div></div>
  </div><div class="side-scroll" id="scroll"><div class="session-org">
    ${row("hug", "empty")}
    ${row("mark", "mark", "", `<span class="session-lead-dot"></span>`, `<span class="session-duration">12m</span>`)}
    ${row("pinned", "mark", "pinned", `<span class="session-lead-pin">${glyph}</span>`, `<span class="session-duration">3d</span>`)}
    ${row("active", "mark", "active", `<span class="session-lead-dot"></span>`, `<span class="session-duration">5m</span>`)}
    ${Array.from({ length: 24 }, (_, i) => row(`more${i}`, "empty")).join("")}
  </div></div></div></aside>`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    for (const density of ["comfortable", "compact"]) for (const dir of ["ltr", "rtl"]) {
      await page.setContent(`<!doctype html><html dir="${dir}" data-theme-style="fluent"><head><style>${css}</style><style>*,*::before,*::after{transition:none!important}</style></head><body data-density="${density}">${fixture}</body></html>`);
      const m = await page.evaluate(() => {
        const rtl = document.documentElement.dir === "rtl";
        const rect = (el: Element) => el.getBoundingClientRect();
        const pseudo = (el: Element, which: string) => {
          const r = rect(el); const s = getComputedStyle(el, which);
          return { l: r.left + parseFloat(s.left), r: r.right - parseFloat(s.right) };
        };
        const start = (b: { l: number; r: number } | DOMRect) => ("l" in b ? (rtl ? b.r : b.l) : (rtl ? b.right : b.left));
        const end = (b: { l: number; r: number } | DOMRect) => ("l" in b ? (rtl ? b.l : b.r) : (rtl ? b.left : b.right));
        const contentEnd = (el: Element) => { const r = rect(el); const s = getComputedStyle(el); return rtl ? r.left + parseFloat(s.paddingLeft) : r.right - parseFloat(s.paddingRight); };
        const out: Record<string, { start: number; end?: number; pillEnd: number }> = {};
        for (const id of ["hug", "mark", "pinned", "active"]) {
          const el = document.getElementById(id)!;
          const pill = pseudo(el.querySelector(".session-btn")!, "::before");
          const first = el.querySelector(id === "hug" ? ".session-title-text" : ".session-lead")!;
          out[id] = { start: Math.abs(start(rect(first)) - start(pill)), end: Math.abs(end(pill) - contentEnd(el.querySelector(".session-row-body")!)), pillEnd: end(pill) };
        }
        for (const id of ["agent", "agentActive"]) {
          const btn = document.querySelector(`#${id} .agent-nav-btn`)!;
          const pill = pseudo(btn, "::before");
          out[id] = { start: Math.abs(start(rect(btn.querySelector(".agent-nav-lead")!)) - start(pill)), end: Math.abs(end(pill) - contentEnd(btn)), pillEnd: end(pill) };
        }
        for (const id of ["new", "action"]) {
          const el = document.getElementById(id)!;
          out[id] = { start: Math.abs(start(rect(el.querySelector("svg")!)) - start(rect(el))), pillEnd: end(rect(el)) };
        }
        const scroll = document.getElementById("scroll")!;
        const sr = rect(scroll);
        const clientEnd = rtl ? sr.right - scroll.clientLeft - scroll.clientWidth : sr.left + scroll.clientLeft + scroll.clientWidth;
        const sidebar = rect(document.querySelector(".sidebar")!);
        const active = document.querySelector("#active .session-btn")!;
        return {
          rows: out,
          endClear: Math.min(...Object.values(out).map((o) => Math.abs(clientEnd - o.pillEnd))),
          startClear: Math.min(...["mark", "agent", "new"].map((id) => Math.abs(start(id === "new" ? rect(document.getElementById(id)!) : pseudo(document.querySelector(`#${id} ${id === "agent" ? ".agent-nav-btn" : ".session-btn"}`)!, "::before")) - (rtl ? sidebar.right : sidebar.left)))),
          fluentBar: Math.abs(start(pseudo(active, "::after")) - start(pseudo(active, "::before"))),
        };
      });
      const where = `${density} ${dir}`;
      for (const [id, r] of Object.entries(m.rows)) {
        assert.ok(Math.abs(r.start - 10) < 0.5, `${where} ${id}: air before content ${r.start}`);
        if (r.end !== undefined) assert.ok(Math.abs(r.end - 10) < 0.5, `${where} ${id}: air after the trailing marks ${r.end}`);
      }
      const ends = Object.values(m.rows).map((r) => r.pillEnd);
      assert.ok(Math.max(...ends) - Math.min(...ends) < 0.5, `${where}: every pill ends on one edge (${ends.join(", ")})`);
      assert.ok(m.endClear >= 2 - 0.01, `${where}: pills stay 2px clear of the scrollbar (${m.endClear})`);
      assert.ok(m.startClear >= 2 - 0.01, `${where}: pills stay clear of the sidebar edge (${m.startClear})`);
      assert.ok(m.fluentBar < 0.5, `${where}: Fluent's bar rides the pill start (${m.fluentBar})`);
    }
  } finally {
    await browser.close();
  }
});

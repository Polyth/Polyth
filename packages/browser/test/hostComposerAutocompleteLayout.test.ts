// Composer suggestion rows. `.ac-item` lays a row out on a grid, and grid items
// auto-place into tracks in order. Action rows (`/`) render a leading icon;
// snippet (`#`) and file (`@`) rows do not — so when the template always led
// with an icon track, their copy fell into that 16px track and a snippet read
// as one clipped glyph ("# ı"). The fixture mirrors renderAutocompleteOption in
// Composer.tsx and runs the real stylesheet; no server or app boot.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Browser, Page } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";

const readCss = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const CHROME = await findChromiumExecutable();

const icon = '<span class="ac-icon"><svg width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16"/></svg></span>';
function row(label: string, detail: string, opts: { icon?: boolean; meta?: string } = {}) {
  return `<div class="ac-item ac-active" role="option">
    ${opts.icon ? icon : ""}
    <span class="ac-copy"><span class="ac-label">${label}</span><span class="ac-detail">${detail}</span></span>
    ${opts.meta ? `<span class="ac-meta"><span class="ac-source">${opts.meta}</span></span>` : ""}
  </div>`;
}
function composer(id: string, width: number, kind: string, rows: string) {
  return `<div class="composer composer-chat composer-simple" id="${id}" style="width:${width}px;margin:220px 0 0 24px">
    <div class="composer-card"><div class="composer-input">
      <textarea class="composer-editor" rows="1"></textarea>
      <div class="ac-popup" data-kind="${kind}">
        <div class="ac-header"><span class="ac-header-title">Suggestions</span></div>
        <div class="ac-list" role="listbox">${rows}</div>
        <div class="ac-footer"><span><kbd>Esc</kbd> dismiss</span></div>
      </div>
    </div></div>
  </div>`;
}

let browser: Browser | null = null;
let page: Page | null = null;

before(async () => {
  if (!CHROME) return;
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  const css = [await readCss("../../../apps/web/src/tokens.css"), await readCss("../../../apps/web/src/styles.css")].join("\n");
  await page.setContent(`<style>${css}</style>
    ${composer("snippet", 600, "snip", row("#review", "Review the staged diff") + row("#standup", "Plan the day"))}
    ${composer("file", 600, "file", row("@src/main.tsx", "file"))}
    ${composer("action", 600, "cmd", row("/review", "Review the changes", { icon: true, meta: "Claude" }))}
    ${composer("destination", 600, "cmd", row("Commands", "Manage commands", { icon: true }))}
    ${composer("narrow", 360, "snip", row("#review", "Review the staged diff"))}`);
});

after(async () => {
  await browser?.close();
});

/** Geometry of the first row in a fixture composer. */
function measure(id: string) {
  return page!.evaluate((composerId) => {
    const item = document.querySelector<HTMLElement>(`#${composerId} .ac-item`)!;
    const rect = (selector: string) => {
      const el = item.querySelector<HTMLElement>(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        left: r.left, right: r.right, width: r.width,
        display: getComputedStyle(el).display,
        clipped: el.scrollWidth > el.clientWidth,
      };
    };
    const r = item.getBoundingClientRect();
    return {
      columns: getComputedStyle(item).gridTemplateColumns.split(" "),
      item: { left: r.left, right: r.right, width: r.width },
      icon: rect(".ac-icon"), copy: rect(".ac-copy")!, label: rect(".ac-label")!,
      detail: rect(".ac-detail")!, meta: rect(".ac-meta"),
    };
  }, id);
}

test("an icon track exists only on rows that render an icon", async () => {
  const css = await readCss("../../../apps/web/src/styles.css");
  const base = css.match(/\n\.ac-item \{[^}]*\}/)?.[0] ?? "";
  assert.match(base, /grid-template-columns:\s*minmax\(0, 1fr\) auto;/,
    "icon-less rows (snippets, files) must start with the copy track");
  assert.doesNotMatch(base, /var\(--icon-sm\)/, "the base row never reserves the icon track");
  assert.match(
    css,
    /\.ac-item:has\(> \.ac-icon\)\s*\{\s*grid-template-columns:\s*var\(--icon-sm\) minmax\(0, 1fr\) auto;/,
    "the icon track is keyed on the icon actually being rendered",
  );
});

for (const [id, what, label] of [["snippet", "snippet", "#review"], ["file", "file mention", "@src/main.tsx"]] as const) {
  test(`a ${what} row without an icon uses the whole row for its copy`, { skip: !CHROME }, async () => {
    const g = await measure(id);
    assert.equal(g.icon, null, "this row renders no icon");
    assert.ok(g.copy.width > g.item.width * 0.8,
      `the copy fills the row, not a 16px icon track (copy ${g.copy.width}px of ${g.item.width}px)`);
    assert.equal(g.label.clipped, false, `${label} is shown in full`);
    assert.ok(g.label.width > 30, `the label keeps its natural width (${g.label.width}px)`);
    assert.ok(g.detail.width > 60, `the detail text is visible beside the label (${g.detail.width}px)`);
  });
}

test("an action row keeps the icon, copy and provenance columns", { skip: !CHROME }, async () => {
  const g = await measure("action");
  assert.equal(g.columns.length, 3);
  assert.equal(g.columns[0], "16px", "the icon track is the icon-sm token");
  assert.ok(g.icon && g.copy.left >= g.icon.right, "the copy starts after the icon");
  assert.ok(g.meta && g.meta.left >= g.copy.right && g.meta.right <= g.item.right,
    "provenance sits at the row's trailing edge");
  assert.ok(g.copy.width > 200, `the copy still owns the flexible track (${g.copy.width}px)`);
});

test("an icon row with no provenance keeps its icon track", { skip: !CHROME }, async () => {
  const g = await measure("destination");
  assert.equal(g.columns[0], "16px");
  assert.ok(g.icon && g.copy.left >= g.icon.right, "the copy starts after the icon");
  assert.equal(g.meta, null);
});

test("a narrow composer still shows the snippet alias", { skip: !CHROME }, async () => {
  const g = await measure("narrow");
  assert.equal(g.detail.display, "none", "the narrow popup drops the detail text");
  assert.ok(g.copy.width > g.item.width * 0.8, `the copy fills the row (${g.copy.width}px of ${g.item.width}px)`);
  assert.equal(g.label.clipped, false, "#review is shown in full");
});

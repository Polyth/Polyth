import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import type { Browser } from "playwright-core";
import { findChromiumExecutable } from "@polyth/browser/chromium";
import { browserBuildOptions, uiFontScalePlugin } from "../../../apps/web/buildConfig.ts";
import type { ContextGauge } from "../../../apps/web/src/reduce.ts";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { default: ContextPie, contextPieLabel, contextPieVisible } = await import("../../../apps/web/src/components/ContextPie.tsx");

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");
const CHROME = await findChromiumExecutable();
const SECTOR_C = 2 * Math.PI * 3.5;

function gauge(percent: number | null, quality: "native" | "estimated" | "fraction" = "native"): ContextGauge {
  if (percent === null) {
    return { known: false, inputTokens: 0, contextTokens: null, percent: null, level: "unknown", quality: "unknown" };
  }
  if (quality === "fraction") {
    return { known: false, inputTokens: 0, contextTokens: null, percent, level: "fraction", quality: "fraction", hasTokenCount: false };
  }
  return {
    known: true,
    inputTokens: percent * 1_000,
    contextTokens: 100_000,
    percent,
    level: percent < 70 ? "green" : percent < 90 ? "yellow" : "red",
    quality,
  };
}
const observedOnly: ContextGauge = {
  known: false, inputTokens: 12_500, contextTokens: null, percent: null, level: "unknown", quality: "native",
};

const pie = (value: ContextGauge | null, pending = false) =>
  renderToStaticMarkup(createElement(ContextPie, { gauge: value ? { ...value, ...(pending ? { pending: true } : {}) } : null }));

test("the slice is the window share of the sector circumference, starting at twelve o'clock", () => {
  const html = pie(gauge(42));
  assert.match(html, /^<button type="button" class="config-chip composer-context-pie" data-level="green" data-quality="native"/);
  assert.match(html, /aria-haspopup="dialog" aria-expanded="false"/);
  const dash = html.match(/stroke-dasharray:([\d.]+) ([\d.]+)/);
  assert.ok(dash, "the sector carries its dash");
  assert.equal(Number(dash[1]), Number((SECTOR_C * .42).toFixed(3)));
  assert.equal(Number(dash[2]), Number(SECTOR_C.toFixed(3)));
  assert.match(html, /transform="rotate\(-90 10 10\)"/);
  assert.match(pie(gauge(0)), /stroke-dasharray:0\.000 /, "an empty window keeps the ring and an empty sector");
  assert.match(pie(gauge(100)), new RegExp(`stroke-dasharray:${SECTOR_C.toFixed(3)} ${SECTOR_C.toFixed(3)}`), "a full window is a solid disc");
  assert.match(pie(gauge(75)), /data-level="yellow"/);
  assert.match(pie(gauge(95)), /data-level="red"/);
  assert.match(pie(gauge(30, "fraction")), /data-level="green"[\s\S]*context-pie-sector/, "a runtime fraction still draws a slice");
  assert.match(pie(gauge(92, "fraction")), /data-level="red"/, "a fraction-only window warms like a measured one");
});

test("observed tokens without a limit and an unmeasured window both keep an empty dashed ring", () => {
  const html = pie(observedOnly);
  assert.match(html, /data-level="unknown"/);
  assert.doesNotMatch(html, /context-pie-sector/, "no slice is invented without a denominator");
  // A fresh leg, a compaction or an epoch replacement reports nothing for a
  // while; the pie (and its card with the cache controls) must not vanish.
  const unmeasured = pie(gauge(null));
  assert.match(unmeasured, /data-level="unknown"/);
  assert.match(unmeasured, /aria-label="Context usage unavailable"/);
  assert.doesNotMatch(unmeasured, /context-pie-sector/);
  assert.equal(pie(null), "");
  assert.equal(contextPieVisible(gauge(null)), true);
  assert.equal(contextPieVisible(null), false);
  assert.equal(contextPieVisible(observedOnly), true);
  assert.equal(contextPieVisible(gauge(0)), true);
});

test("a held value of the same context is dimmed, not hidden", () => {
  assert.match(pie(gauge(64), true), /data-pending="true"/);
  assert.doesNotMatch(pie(gauge(64)), /data-pending/);
});

test("the accessible name and tooltip carry percent and tokens", () => {
  assert.equal(contextPieLabel(gauge(42)), "Context 42% · 42.0k / 100.0k");
  assert.equal(contextPieLabel(gauge(42, "estimated")), "Context ~42% · ~42.0k / 100.0k");
  assert.equal(contextPieLabel(gauge(30, "fraction")), "Context 30%");
  assert.equal(contextPieLabel(observedOnly), "12.5k tokens observed; window limit unavailable");
  assert.match(pie(gauge(42)), /title="Context 42% · 42.0k \/ 100.0k" aria-label="Context 42% · 42.0k \/ 100.0k"/);
});

test("the composer places the pie right after effort and only for an open session", async () => {
  const composer = await read("../../../apps/web/src/components/Composer.tsx");
  assert.match(composer, /const contextPie = session && contextPieVisible\(contextGauge\)\s*\? <ContextPie\s+key=\{session\.id\}\s+gauge=\{contextGauge\}\s+phone=\{phoneLayout\}/);
  assert.match(composer, /\{!peopleOnly && !peopleMode && \(modelControl \|\| effortControl \|\| contextPie \|\| phoneLayout\) && \(\s*<div className="composer-config composer-config-row">\s*\{modelControl\}\s*\{effortControl\}\s*\{contextPie\}/);
  // Package indicators share that row through a slot, not a host import.
  assert.match(composer, /<SlotHost slot="composer\.config" context=\{slotContext\} \/>/);
});

let browser: Browser | null = null;
let css = "";

before(async () => {
  if (!CHROME) return;
  const result = await build({
    ...browserBuildOptions,
    entryPoints: [new URL("../../../apps/web/src/main.tsx", import.meta.url).pathname],
    outdir: "/tmp/opencode/context-pie-build",
    write: false, sourcemap: false, minify: false, logLevel: "silent",
    plugins: [uiFontScalePlugin],
  });
  css = result.outputFiles.find((file) => file.path.endsWith("/main.css"))!.text;
  const { chromium } = await import("playwright-core");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});

after(async () => {
  await browser?.close();
});

type Layout = "desktop" | "phone-engaged" | "phone-resting";

/** The composer card around the pie, mirroring Composer.tsx/MobileComposerRail. */
function composerFixture(layout: Layout, value: ContextGauge): string {
  const state = layout === "desktop"
    ? ""
    : ` composer-mobile composer-mobile-grid ${layout === "phone-resting" ? "composer-collapsed" : "composer-expanded composer-input-active"}`;
  const glyph = '<svg width="16" height="16" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';
  const rail = layout === "desktop"
    ? `<div class="composer-rail"><span class="composer-leading-zone customize-zone"><button class="chip composer-add-trigger" id="add">${glyph}</button></span>
        <div class="composer-actions customize-zone"><span class="composer-primary"><button class="send" id="send">${glyph}</button></span></div></div>`
    : `<div class="composer-rail mobile-composer-rail"${layout === "phone-resting" ? ' data-resting="true"' : ""} style="--mobile-rail-lanes: 5">
        <div class="mobile-composer-launchers">
          <div class="mobile-composer-cell" data-resting="add"><div class="mobile-composer-launcher"><button class="chip composer-add-trigger" id="add">${glyph}</button></div></div>
          <div class="mobile-composer-cell" data-resting="quick"><div class="mobile-composer-launcher"><button class="ui-icon-btn" id="quick">${glyph}</button></div></div>
          <div class="mobile-composer-cell"><div class="mobile-composer-launcher"><button class="ui-icon-btn">${glyph}</button></div></div>
        </div>
        <div class="mobile-composer-primary"><span class="composer-primary"><button class="send" id="send">${glyph}</button></span></div>
      </div>`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>
    <body><div class="app"><div style="width: ${layout === "desktop" ? 760 : 374}px">
      <div class="composer composer-chat composer-simple composer-focus-light${state}">
        <div class="ui-glass-dock ui-glass-dock--strong composer-card">
          <div class="composer-config composer-config-row">
            <div class="picker picker-model"><button class="config-chip model-picker-trigger" id="model"><span class="model-trigger-name">Claude Opus 5.5</span></button></div>
            <button class="config-chip composer-effort-trigger" id="effort"><span class="config-chip-text">High</span></button>
            ${pie(value)}
            ${layout === "desktop" ? "" : `<button class="ui-icon-btn mobile-composer-edit" id="edit">${glyph}</button>`}
          </div>
          <div class="composer-input"><textarea class="composer-editor" rows="3" placeholder="Message Polyth…"></textarea></div>
          ${rail}
        </div>
      </div>
    </div><span id="red" style="color: var(--red)"></span><span id="amber" style="color: var(--amber)"></span></div></body></html>`;
}

async function measure(layout: Layout, value: ContextGauge) {
  const phone = layout !== "desktop";
  const page = await browser!.newPage({
    viewport: { width: phone ? 390 : 1280, height: 700 },
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  try {
    await page.setContent(composerFixture(layout, value));
    return await page.evaluate(() => {
      const rect = (selector: string) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { x: box.x, y: box.y, w: box.width, h: box.height, right: box.right, cy: box.y + box.height / 2 };
      };
      const pieNode = document.querySelector(".composer-context-pie")!;
      return {
        pie: rect(".composer-context-pie")!,
        glyph: rect(".context-pie-glyph")!,
        effort: rect("#effort")!,
        model: rect("#model")!,
        add: rect('[data-resting="add"]') ?? rect("#add")!,
        quick: rect("#quick"),
        send: rect("#send")!,
        input: rect("textarea")!,
        color: getComputedStyle(pieNode).color,
        red: getComputedStyle(document.getElementById("red")!).color,
        amber: getComputedStyle(document.getElementById("amber")!).color,
        sectorStroke: getComputedStyle(document.querySelector(".context-pie-sector") ?? pieNode).strokeWidth,
      };
    });
  } finally {
    await page.close();
  }
}

for (const layout of ["desktop", "phone-engaged"] as const) {
  test(`${layout}: the pie sits right of the effort chip on the model line`, { skip: !CHROME }, async () => {
    const m = await measure(layout, gauge(42));
    assert.ok(m.pie.w > 0 && m.pie.h > 0, "the pie is laid out");
    assert.ok(m.pie.x >= m.effort.right, "the pie follows effort");
    assert.ok(m.pie.x - m.effort.right <= 12, `the pie is effort's neighbour (${m.pie.x - m.effort.right}px)`);
    assert.ok(Math.abs(m.pie.cy - m.effort.cy) <= 1, "the pie shares the line's center");
    assert.ok(m.pie.right <= m.input.right, "the line never overflows the card");
    assert.ok(m.pie.y + m.pie.h <= m.input.y + 1, "the pie stays above the editor");
    assert.equal(m.glyph.w, layout === "desktop" ? 16 : 18);
    assert.equal(m.sectorStroke, "7px");
    if (layout === "phone-engaged") assert.ok(m.pie.h >= 44, "a phone pie keeps a touch-height cell");
  });
}

test("phone resting: the one-line composer keeps the pie right after Add", { skip: !CHROME }, async () => {
  const m = await measure("phone-resting", gauge(42));
  assert.equal(m.model.w, 0, "the model chip is hidden while resting");
  assert.equal(m.effort.w, 0, "the effort chip is hidden while resting");
  assert.ok(m.pie.w > 0, "the pie stays visible");
  assert.ok(Math.abs(m.pie.x - m.add.right) <= .5, `the pie is attached to Add (${m.pie.x - m.add.right}px)`);
  assert.ok(m.input.x >= m.pie.right, "the placeholder follows the pie");
  assert.ok(m.quick && m.quick.x >= m.input.right && m.send.x >= m.quick.right, "the quick launcher and Send keep the trailing edge");
  for (const item of [m.add, m.input, m.send]) {
    assert.ok(Math.abs(item.cy - m.pie.cy) <= 1, "one optical row");
  }
  assert.ok(m.pie.h >= 44, "the pie keeps a touch-height cell");
  assert.ok(m.input.w >= 120, `the placeholder keeps room (${m.input.w}px)`);
});

test("the pie warms with the window and uses theme tones", { skip: !CHROME }, async () => {
  const yellow = await measure("desktop", gauge(75));
  assert.equal(yellow.color, yellow.amber);
  const red = await measure("desktop", gauge(95));
  assert.equal(red.color, red.red);
  const green = await measure("desktop", gauge(20));
  assert.notEqual(green.color, green.red);
  assert.notEqual(green.color, green.amber);
});

// The chip renders from its slot context alone: the right state, colour, arc
// and accessible name, nothing for an unscheduled route, and the touch path
// (a click) opens the details card.
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { default: PeakPricingIndicator, tickIntervalFor } = await import("../widgets/PeakPricingIndicator.tsx");
const { DEFAULT_PEAK_PRICING_PREFS, replacePeakPricingPrefs } = await import("../widgets/prefs.ts");

const model = {
  harnessId: "deepseek",
  providerID: "deepseek-official",
  modelID: "deepseek-flash",
  name: "DeepSeek Flash",
};

/** The component reads `Date.now()` at mount; pin it for a deterministic paint. */
function withNow<T>(iso: string, run: () => T): T {
  const real = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    return run();
  } finally {
    Date.now = real;
  }
}

const render = (props: Record<string, unknown>) => withNow(
  "2026-10-19T08:39:00Z",
  () => renderToStaticMarkup(createElement(PeakPricingIndicator, props as never)),
);

test("a peak route paints the red state, the countdown and the exact end", () => {
  const html = render({ model, harnessId: "deepseek" });
  assert.match(html, /class="config-chip peak-pricing-chip" data-phase="peak" data-display="full"/);
  assert.match(html, /peak-pricing-state">Peak</);
  // 08:39 UTC to 10:00 UTC.
  assert.match(html, /peak-pricing-remaining" aria-hidden="true">1h 21m</);
  assert.match(html, /aria-label="DeepSeek pricing: Peak until \d{1,2}:\d{2}(?:\s?[AP]M)?"/);
  assert.match(html, /aria-haspopup="dialog"/);
  // The arc is the progress through the phase: 08:39 of 06:00–10:00.
  const arc = /stroke-dasharray="([\d.]+) 100"/.exec(html);
  assert.ok(arc, "the phase arc is drawn");
  const progress = Number(arc![1]);
  assert.ok(progress > 65 && progress < 68, `expected ~66% through the peak window, got ${progress}`);
});

test("an off-peak route paints the green state", () => {
  const html = withNow("2026-10-19T04:30:00Z", () => renderToStaticMarkup(
    createElement(PeakPricingIndicator, { model, harnessId: "deepseek" } as never),
  ));
  assert.match(html, /data-phase="off-peak"/);
  assert.match(html, /peak-pricing-state">Off-peak</);
  assert.match(html, /peak-pricing-remaining" aria-hidden="true">1h 30m</);
});

test("a route without a time-of-day schedule renders nothing", () => {
  assert.equal(render({
    model: { harnessId: "codex", providerID: "openai", modelID: "gpt-5.2", name: "GPT-5.2" },
    harnessId: "codex",
  }), "");
  assert.equal(render({}), "");
});

test("an extra DeepSeek login (harness family) still gets the clock", () => {
  const html = render({ model: { ...model, providerID: "deepseek-work", harnessId: "deepseek-work" }, harnessId: "deepseek-work" });
  assert.match(html, /data-phase="peak"/);
});

test("a DeepSeek model served by another provider still shows the clock", () => {
  const html = render({
    model: { providerID: "openrouter", providerName: "OpenRouter", modelID: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    harnessId: "opencode",
  });
  assert.match(html, /data-phase="peak"/);
});

test("the chip is a real button with an expanded state and no nested interactive content", () => {
  const html = render({ model, harnessId: "deepseek" });
  assert.match(html, /^<span class="peak-pricing" data-display="full"><span class="ui-tooltip-host"><button/);
  assert.match(html, /type="button"/);
  assert.match(html, /aria-expanded="false"/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});

/** Render with prefs applied, then restore today's defaults for later tests. */
function renderWith(prefs: Record<string, unknown>): string {
  replacePeakPricingPrefs({ ...DEFAULT_PEAK_PRICING_PREFS, ...prefs });
  try {
    return render({ model, harnessId: "deepseek" });
  } finally {
    replacePeakPricingPrefs(DEFAULT_PEAK_PRICING_PREFS);
  }
}

const ariaLabelOf = (html: string) => /aria-label="([^"]+)"/.exec(html)?.[1];

test("the countdown box holds only the current text, so the chip is never wider than it", () => {
  const html = render({ model, harnessId: "deepseek" });
  // No hidden wider shapes: the countdown is one text node and nothing else.
  assert.match(html, /<span class="peak-pricing-remaining" aria-hidden="true">1h 21m<\/span><\/span><\/button>/);
  assert.doesNotMatch(html, /reserve/);
});

test("compact keeps the state word and glyph and drops the countdown", () => {
  const html = renderWith({ display: "compact" });
  assert.match(html, /class="config-chip peak-pricing-chip" data-phase="peak" data-display="compact"/);
  assert.match(html, /peak-pricing-state">Peak</);
  assert.doesNotMatch(html, /peak-pricing-remaining/);
  assert.match(html, /peak-pricing-glyph/);
});

test("dot only draws the glyph alone, without chip chrome or words", () => {
  const html = renderWith({ display: "dot" });
  assert.match(html, /class="peak-pricing-chip" data-phase="peak" data-display="dot"/);
  assert.doesNotMatch(html, /config-chip/);
  assert.doesNotMatch(html, /peak-pricing-text|peak-pricing-state|peak-pricing-remaining/);
  // The standalone glyph: a 16px ring around the 8px dot.
  assert.match(html, /viewBox="0 0 16 16" width="16" height="16"/);
  assert.match(html, /^<span class="peak-pricing" data-display="dot"><span class="ui-tooltip-host"><button/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-expanded="false"/);
});

test("every display keeps one accessible name with the state and the end time", () => {
  const full = ariaLabelOf(renderWith({ display: "full" }));
  assert.match(full ?? "", /^DeepSeek pricing: Peak until \d{1,2}:\d{2}/);
  assert.equal(ariaLabelOf(renderWith({ display: "compact" })), full);
  assert.equal(ariaLabelOf(renderWith({ display: "dot" })), full);
  assert.equal(ariaLabelOf(renderWith({ display: "dot", tooltip: false })), full);
});

test("turning the hover summary off drops the tooltip but keeps the button and its card path", () => {
  const html = renderWith({ tooltip: false });
  assert.doesNotMatch(html, /ui-tooltip-host/);
  assert.match(html, /^<span class="peak-pricing" data-display="full"><button/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /aria-label="DeepSeek pricing: Peak until/);
});

test("a disabled chip renders nothing", () => {
  assert.equal(renderWith({ enabled: false }), "");
  assert.equal(renderWith({ enabled: false, display: "dot" }), "");
});

test("only a visible countdown ticks every second", () => {
  assert.equal(tickIntervalFor("full", false), 1000);
  assert.equal(tickIntervalFor("compact", false), 30_000);
  assert.equal(tickIntervalFor("dot", false), 30_000);
  // An open summary or card shows the live countdown in any display.
  assert.equal(tickIntervalFor("dot", true), 1000);
});

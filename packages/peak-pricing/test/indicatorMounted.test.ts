// The hover/focus timer and the click card are interaction paths, not just
// markup: mount the real component in a DOM and drive focus and clicks.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    // Hover tests need a fine pointer; the shell queries stay wide.
    get matches() { return query.includes("hover: hover") && query.includes("pointer: fine"); },
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: PeakPricingIndicator } = await import("../widgets/PeakPricingIndicator.tsx");
const { DEFAULT_PEAK_PRICING_PREFS, replacePeakPricingPrefs } = await import("../widgets/prefs.ts");

const model = {
  harnessId: "deepseek",
  providerID: "deepseek-official",
  modelID: "deepseek-flash",
  name: "DeepSeek Flash",
};
const realNow = Date.now;
const FIXED_NOW = Date.parse("2026-10-19T08:39:00Z");

async function mount(): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PeakPricingIndicator, { model, harnessId: "deepseek" } as never));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the visible timer repaints as the clock advances", async () => {
  Date.now = () => FIXED_NOW;
  const callbacks: Array<() => void> = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((callback: () => void) => {
    callbacks.push(callback);
    return 1;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval;
  const view = await mount();
  try {
    const chip = view.container.querySelector<HTMLElement>(".peak-pricing-chip")!;
    assert.equal(callbacks.length, 1, "one timer for the one chip");
    assert.match(chip.textContent ?? "", /1h 21m/);

    Date.now = () => Date.parse("2026-10-19T08:40:00Z");
    await act(async () => callbacks[0]!());
    assert.match(chip.textContent ?? "", /1h 20m/, "the next tick shows the new remaining time");
  } finally {
    await view.unmount();
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    Date.now = realNow;
  }
});

test("focus shows the live countdown, and a click opens and closes the details card", async () => {
  Date.now = () => FIXED_NOW;
  const view = await mount();
  try {
    const button = view.container.querySelector<HTMLButtonElement>(".peak-pricing-chip")!;
    assert.ok(button, "the chip is mounted");

    await act(async () => button.focus());
    const tip = document.body.querySelector<HTMLElement>(".ui-tooltip");
    assert.ok(tip, "keyboard focus reveals the timer");
    assert.match(tip.textContent ?? "", /Peak ends in 1h 21m/);
    assert.match(tip.textContent ?? "", /Changes at/);
    assert.match(tip.textContent ?? "", /Off-peak is half the peak rate/);

    await act(async () => button.click());
    const card = document.body.querySelector<HTMLElement>(".peak-pricing-card");
    assert.ok(card, "the click card is open");
    assert.match(card.textContent ?? "", /Peak pricing/);
    assert.match(card.textContent ?? "", /1h 21m/);
    assert.match(card.textContent ?? "", /Peak until/);
    assert.match(card.textContent ?? "", /Peak hours \(UTC\)/);
    assert.match(card.textContent ?? "", /01:00–04:00, 06:00–10:00/);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.match(
      document.body.querySelector<HTMLElement>(".ui-tooltip")?.className ?? "",
      /peak-pricing-tip-hidden/,
      "the hover tip is hidden while the click card owns the surface",
    );

    await act(async () => button.click());
    assert.equal(document.body.querySelector(".peak-pricing-card"), null);
    assert.equal(button.getAttribute("aria-expanded"), "false");
  } finally {
    await view.unmount();
    Date.now = realNow;
  }
});

test("compact paces the arc at 30 s and still flips colour exactly at the phase edge", async () => {
  Date.now = () => FIXED_NOW;
  replacePeakPricingPrefs({ ...DEFAULT_PEAK_PRICING_PREFS, display: "compact" });
  const intervals: number[] = [];
  const timeouts: Array<{ callback: () => void; delay: number }> = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setInterval = ((_callback: () => void, delay: number) => {
    intervals.push(delay);
    return intervals.length;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval;
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    timeouts.push({ callback, delay });
    return timeouts.length;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout;
  const view = await mount();
  try {
    const chip = view.container.querySelector<HTMLElement>(".peak-pricing-chip")!;
    assert.equal(chip.dataset.phase, "peak");
    assert.equal(chip.querySelector(".peak-pricing-remaining"), null, "compact shows no countdown");
    assert.deepEqual(intervals, [30_000], "no one-second tick without a visible countdown");
    const edge = timeouts.find((entry) => entry.delay === 81 * 60_000);
    assert.ok(edge, "the 10:00 UTC edge is scheduled exactly");

    Date.now = () => Date.parse("2026-10-19T10:00:00Z");
    await act(async () => edge!.callback());
    assert.equal(chip.dataset.phase, "off-peak", "the colour changes on the edge, not on the next idle tick");
  } finally {
    await view.unmount();
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    replacePeakPricingPrefs(DEFAULT_PEAK_PRICING_PREFS);
    Date.now = realNow;
  }
});

test("dot only keeps the summary, the card and Escape on its one button", async () => {
  Date.now = () => FIXED_NOW;
  replacePeakPricingPrefs({ ...DEFAULT_PEAK_PRICING_PREFS, display: "dot" });
  const view = await mount();
  try {
    const button = view.container.querySelector<HTMLButtonElement>(".peak-pricing-chip")!;
    assert.equal(button.dataset.display, "dot");
    assert.equal((button.textContent ?? "").trim(), "", "no visible words");
    assert.match(button.getAttribute("aria-label") ?? "", /^DeepSeek pricing: Peak until/);

    await act(async () => button.focus());
    assert.match(document.body.querySelector(".ui-tooltip")?.textContent ?? "", /Peak ends in 1h 21m/);

    await act(async () => button.click());
    assert.ok(document.body.querySelector(".peak-pricing-card"), "a click opens the card");
    assert.equal(button.getAttribute("aria-expanded"), "true");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(document.body.querySelector(".peak-pricing-card"), null, "Escape closes the card");
    assert.equal(button.getAttribute("aria-expanded"), "false");
  } finally {
    await view.unmount();
    replacePeakPricingPrefs(DEFAULT_PEAK_PRICING_PREFS);
    Date.now = realNow;
  }
});

test("with the hover summary off, focus shows nothing and a click still opens the card", async () => {
  Date.now = () => FIXED_NOW;
  replacePeakPricingPrefs({ ...DEFAULT_PEAK_PRICING_PREFS, tooltip: false });
  const view = await mount();
  try {
    const button = view.container.querySelector<HTMLButtonElement>(".peak-pricing-chip")!;
    await act(async () => button.focus());
    assert.equal(document.body.querySelector(".ui-tooltip"), null);
    await act(async () => button.click());
    assert.ok(document.body.querySelector(".peak-pricing-card"));
    await act(async () => button.click());
  } finally {
    await view.unmount();
    replacePeakPricingPrefs(DEFAULT_PEAK_PRICING_PREFS);
    Date.now = realNow;
  }
});

test("turning the chip off in settings removes it from a mounted composer at once", async () => {
  Date.now = () => FIXED_NOW;
  const view = await mount();
  try {
    assert.ok(view.container.querySelector(".peak-pricing-chip"));
    await act(async () => replacePeakPricingPrefs({ ...DEFAULT_PEAK_PRICING_PREFS, enabled: false }));
    assert.equal(view.container.innerHTML, "");
  } finally {
    await view.unmount();
    replacePeakPricingPrefs(DEFAULT_PEAK_PRICING_PREFS);
    Date.now = realNow;
  }
});

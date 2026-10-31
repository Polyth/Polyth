// The chip's preferences and their settings page: sanitizing stored values,
// the account-sync adapter contract, and a page whose controls write the
// store and whose preview follows it immediately.
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
  StorageEvent: dom.StorageEvent,
  MutationObserver: dom.MutationObserver,
  getComputedStyle: dom.getComputedStyle,
  localStorage: dom.localStorage,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const prefs = await import("../widgets/prefs.ts");
const { default: PeakPricingSettings } = await import("../widgets/PeakPricingSettings.tsx");

const {
  DEFAULT_PEAK_PRICING_PREFS,
  PEAK_PRICING_PREFS_KEY,
  getPeakPricingPrefs,
  replacePeakPricingPrefs,
  resetPeakPricingPrefsCache,
  sanitizePeakPricingPrefs,
  subscribePeakPricingPrefs,
  updatePeakPricingPrefs,
} = prefs;

function resetStore(): void {
  localStorage.clear();
  resetPeakPricingPrefsCache();
}

test("defaults are today's chip: on, full, with the hover summary", () => {
  resetStore();
  assert.deepEqual(getPeakPricingPrefs(), { enabled: true, display: "full", tooltip: true });
  assert.deepEqual({ ...DEFAULT_PEAK_PRICING_PREFS }, { enabled: true, display: "full", tooltip: true });
});

test("stored values are sanitized: unknown fields, wrong types and old spellings", () => {
  assert.deepEqual(sanitizePeakPricingPrefs(null), DEFAULT_PEAK_PRICING_PREFS);
  assert.deepEqual(sanitizePeakPricingPrefs([]), DEFAULT_PEAK_PRICING_PREFS);
  assert.deepEqual(sanitizePeakPricingPrefs("{not json"), DEFAULT_PEAK_PRICING_PREFS);
  assert.deepEqual(
    sanitizePeakPricingPrefs({ enabled: "no", display: "huge", tooltip: 0, extra: true }),
    DEFAULT_PEAK_PRICING_PREFS,
  );
  assert.deepEqual(sanitizePeakPricingPrefs({ display: "dot-only" }), { ...DEFAULT_PEAK_PRICING_PREFS, display: "dot" });
  assert.deepEqual(sanitizePeakPricingPrefs({ display: "Compact" }), { ...DEFAULT_PEAK_PRICING_PREFS, display: "compact" });
  assert.deepEqual(
    sanitizePeakPricingPrefs(JSON.stringify({ enabled: false, display: "dot", tooltip: false })),
    { enabled: false, display: "dot", tooltip: false },
  );
});

test("a corrupt stored record reads as the defaults", () => {
  resetStore();
  localStorage.setItem(PEAK_PRICING_PREFS_KEY, "{\"display\":42");
  assert.deepEqual(getPeakPricingPrefs(), DEFAULT_PEAK_PRICING_PREFS);
});

test("writes persist, notify subscribers once per real change, and keep a stable snapshot", () => {
  resetStore();
  let calls = 0;
  const off = subscribePeakPricingPrefs(() => { calls += 1; });
  try {
    const before = getPeakPricingPrefs();
    assert.equal(getPeakPricingPrefs(), before, "unchanged reads return the same object");
    updatePeakPricingPrefs({ display: "dot" });
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(localStorage.getItem(PEAK_PRICING_PREFS_KEY) ?? "{}"), { enabled: true, display: "dot", tooltip: true });
    updatePeakPricingPrefs({ display: "dot" });
    assert.equal(calls, 1, "a no-op write does not notify");
    // The account-sync adapter replaces the whole record, sanitizing it.
    replacePeakPricingPrefs({ enabled: false, display: "nope" });
    assert.equal(calls, 2);
    assert.deepEqual(getPeakPricingPrefs(), { enabled: false, display: "full", tooltip: true });
  } finally {
    off();
  }
  updatePeakPricingPrefs({ enabled: true });
  assert.equal(calls, 2, "an unsubscribed listener is not called");
});

test("another tab's write repaints this one", () => {
  resetStore();
  getPeakPricingPrefs();
  let calls = 0;
  const off = subscribePeakPricingPrefs(() => { calls += 1; });
  try {
    localStorage.setItem(PEAK_PRICING_PREFS_KEY, JSON.stringify({ enabled: true, display: "compact", tooltip: true }));
    window.dispatchEvent(new StorageEvent("storage", { key: PEAK_PRICING_PREFS_KEY }));
    assert.equal(calls, 1);
    assert.equal(getPeakPricingPrefs().display, "compact");
  } finally {
    off();
  }
});

async function mountPage(): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(PeakPricingSettings)));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>(".seg button")].find((entry) => entry.textContent === label)!;

test("the page shows its sections, the selected display and a live preview of both phases", async () => {
  resetStore();
  document.documentElement.lang = "en";
  const view = await mountPage();
  try {
    const titles = [...view.container.querySelectorAll(".settings-section-title")].map((entry) => entry.textContent);
    assert.deepEqual(titles, ["Chip", "Details", "Preview"]);
    assert.ok(view.container.querySelector('[data-settings-item="peak-pricing.chip"]'));
    assert.ok(view.container.querySelector('[data-settings-item="peak-pricing.display"]'));
    assert.ok(view.container.querySelector('[data-settings-item="peak-pricing.tooltip"]'));
    assert.equal(button(view.container, "Full").getAttribute("aria-pressed"), "true");

    const preview = view.container.querySelector<HTMLElement>(".peak-pricing-preview")!;
    assert.equal(preview.getAttribute("aria-hidden"), "true", "the preview is a picture, not a control");
    assert.ok(preview.hasAttribute("inert"));
    const chips = [...preview.querySelectorAll<HTMLElement>(".peak-pricing-chip")];
    assert.deepEqual(chips.map((chip) => chip.dataset.phase), ["off-peak", "peak"]);
    assert.ok(chips.every((chip) => chip.dataset.display === "full"));
    assert.match(chips[1]!.textContent ?? "", /^Peak1h 21m/);
    assert.match(view.container.textContent ?? "", /never show a chip/);

    await act(async () => button(view.container, "Dot only").click());
    assert.equal(getPeakPricingPrefs().display, "dot");
    assert.equal(button(view.container, "Dot only").getAttribute("aria-pressed"), "true");
    assert.ok([...preview.querySelectorAll<HTMLElement>(".peak-pricing-chip")].every((chip) => chip.dataset.display === "dot"));
    assert.equal(preview.querySelector(".peak-pricing-state"), null, "the preview follows the mode at once");
  } finally {
    await view.unmount();
  }
});

test("the master toggle writes the prefs and disables the rows that depend on it", async () => {
  resetStore();
  const view = await mountPage();
  try {
    const master = view.container.querySelector<HTMLElement>('[role="switch"]')!;
    assert.ok(master, "the chip toggle is a switch");
    await act(async () => master.click());
    assert.equal(getPeakPricingPrefs().enabled, false);
    assert.ok([...view.container.querySelectorAll<HTMLButtonElement>(".seg button")].every((entry) => entry.disabled));
    const switches = [...view.container.querySelectorAll<HTMLElement>('[role="switch"]')];
    assert.equal(switches[1]!.hasAttribute("disabled") || switches[1]!.getAttribute("aria-disabled") === "true", true);
    assert.equal(view.container.querySelector<HTMLElement>(".peak-pricing-preview")!.dataset.enabled, "false");
    assert.match(view.container.textContent ?? "", /The chip is hidden\./);

    await act(async () => master.click());
    assert.equal(getPeakPricingPrefs().enabled, true);
  } finally {
    await view.unmount();
  }
});

test("the page and its preview speak Ukrainian, durations included", async () => {
  resetStore();
  document.documentElement.lang = "uk";
  const view = await mountPage();
  try {
    const titles = [...view.container.querySelectorAll(".settings-section-title")].map((entry) => entry.textContent);
    assert.deepEqual(titles, ["Позначка", "Подробиці", "Попередній перегляд"]);
    assert.ok(button(view.container, "Крапка"));
    const peakChip = view.container.querySelectorAll<HTMLElement>(".peak-pricing-chip")[1]!;
    assert.equal(peakChip.querySelector(".peak-pricing-state")?.textContent, "Пік");
    assert.equal(peakChip.querySelector(".peak-pricing-remaining")?.textContent, "1 год 21 хв");
  } finally {
    await view.unmount();
    document.documentElement.lang = "en";
  }
});

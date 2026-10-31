import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { QuotaPace, QuotaWindow } from "@polyth/contracts";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1/4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LimitsView } = await import("../widgets/usage/LimitsView.tsx");
const {
  DEFAULT_USAGE_LIMITS_PREFS,
  LIMIT_BAR_COLORS,
  replaceUsageLimitsPrefs,
} = await import("../widgets/usage/limitsPrefs.ts");
const model = await import("../widgets/usage/limitsModel.ts");

const now = Date.now();
const H = 3_600_000;

/** Pressure is a continuous ratio; compare it with a tolerance, never exactly. */
const near = (actual: number | null, expected: number, what: string) => {
  assert.ok(actual !== null, `${what}: expected ${expected}, got null`);
  assert.ok(Math.abs(actual! - expected) < 1e-9, `${what}: expected ${expected}, got ${actual}`);
};
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await dom.happyDOM.close(); });

beforeEach(() => {
  replaceUsageLimitsPrefs(DEFAULT_USAGE_LIMITS_PREFS);
  dom.localStorage.clear();
});

/**
 * A window whose remaining share and burn rate deliberately disagree, so the
 * two factors cannot accidentally produce the same colour:
 * 2% left (percent pressure pinned high) but a pace ratio under budget.
 */
const window: QuotaWindow = {
  id: "5h", label: "5h", unit: "percent", used: 98, limit: 100,
  periodMs: 5 * H, resetsAt: now + 5 * H - 3 * 60_000,
};
const comfortablePace: QuotaPace = { usageFraction: .02, timeFraction: .01, pace: "over", predictedAtReset: 5 };
const hotPace: QuotaPace = { usageFraction: .9, timeFraction: .5, pace: "over", predictedAtReset: 130 };

const rowFor = (pace: QuotaPace, extra: Partial<QuotaWindow> = {}, prefs = DEFAULT_USAGE_LIMITS_PREFS) =>
  model.limitGroups(
    [{
      providerId: "antigravity", fetchedAt: now, stale: false,
      windows: [{ ...window, ...extra }], balances: [], pace: { [window.id]: pace },
    }] as never,
    prefs,
    now,
  )[0]!.rows[0]!;

test("percent pressure ramps from the remaining share between the two thresholds", () => {
  // Above the low threshold the bar is calm; at or past the critical share it is fully alarmed.
  near(model.percentPressure(1, 20, 5), 0, "full capacity");
  near(model.percentPressure(.2, 20, 5), 0, "at the low threshold");
  near(model.percentPressure(.05, 20, 5), 1, "at the critical threshold");
  near(model.percentPressure(.01, 20, 5), 1, "past the critical threshold");
  // Halfway between the thresholds is halfway up the ramp.
  near(model.percentPressure(.125, 20, 5), .5, "mid ramp");
  // A cap-less window has no share to read and must not look healthy.
  assert.equal(model.percentPressure(null, 20, 5), null);
  // A degenerate scale (critical at or above low) is a step, not a division by zero:
  // below the low threshold it is fully alarmed, at or above it is calm.
  near(model.percentPressure(.5, 10, 10), 0, "degenerate scale above low");
  near(model.percentPressure(.05, 10, 10), 1, "degenerate scale below low");
});

test("each bar-colour factor reads its own signal and reports the factor it used", () => {
  const percent = rowFor(comfortablePace, {}, { ...DEFAULT_USAGE_LIMITS_PREFS, barFactor: "percent" });
  const pace = rowFor(comfortablePace, {}, { ...DEFAULT_USAGE_LIMITS_PREFS, barFactor: "pace" });
  const stat = rowFor(comfortablePace, {}, { ...DEFAULT_USAGE_LIMITS_PREFS, barFactor: "static", barColor: "blue" });

  // 2% left sits at the default 10% low / 2% critical ramp, so percent is fully alarmed.
  assert.equal(percent.bar.factor, "percent");
  near(percent.bar.pressure, 1, "2% left in percent mode");
  assert.equal(percent.bar.color, null);
  assert.equal(percent.bar.tone, "critical");

  // The same window burns far under its steady budget, so pace stays calm.
  assert.equal(pace.bar.factor, "pace");
  near(pace.bar.pressure, 0, "comfortable pace");
  assert.equal(pace.bar.tone, "ok");

  // Static carries no pressure at all — only the palette slot it pins.
  assert.equal(stat.bar.factor, "static");
  assert.equal(stat.bar.pressure, null);
  assert.equal(stat.bar.color, "blue");
});

test("pace falls back to the percent reading while a window has no usable pace sample", () => {
  // An initial burst with no reset forecast yields no pace; the visible share still colours the bar.
  const burst = { ...comfortablePace, predictedAtReset: undefined, usageFraction: .02, timeFraction: .001 };
  const paced = rowFor(burst, {}, { ...DEFAULT_USAGE_LIMITS_PREFS, barFactor: "pace" });
  assert.equal(paced.bar.factor, "pace");
  assert.deepEqual(paced.bar.pressure, model.percentPressure(.02, 10, 2));
  assert.ok((paced.bar.pressure ?? 0) > 0, "a nearly spent window must not read as calm");
});

test("percent sensitivity follows the two thresholds, and static ignores them entirely", () => {
  const wide = { ...DEFAULT_USAGE_LIMITS_PREFS, barFactor: "percent" as const, lowRemainingPercent: 50, criticalRemainingPercent: 0 };
  const narrow = { ...DEFAULT_USAGE_LIMITS_PREFS, barFactor: "percent" as const, lowRemainingPercent: 40, criticalRemainingPercent: 39 };
  // 20% left: mid-ramp on a wide scale, fully alarmed on a narrow one.
  const wideRow = rowFor(comfortablePace, { used: 80 }, wide);
  const narrowRow = rowFor(comfortablePace, { used: 80 }, narrow);
  assert.ok(Math.abs(wideRow.bar.pressure! - .6) < 1e-9);
  near(narrowRow.bar.pressure, 1, "narrow scale");
  // The same share is untouched by the thresholds in static mode.
  const staticRow = rowFor(comfortablePace, { used: 80 }, { ...wide, barFactor: "static", barColor: "purple" });
  assert.equal(staticRow.bar.pressure, null);
});

test("a hot pace is flagged in pace mode but leaves percent mode at the remaining share", () => {
  const pace = rowFor(hotPace, { used: 20 }, { ...DEFAULT_USAGE_LIMITS_PREFS, barFactor: "pace" });
  const percent = rowFor(hotPace, { used: 20 }, { ...DEFAULT_USAGE_LIMITS_PREFS, barFactor: "percent" });
  near(pace.bar.pressure, 1, "hot pace");
  assert.deepEqual(percent.bar.pressure, model.percentPressure(.8, 10, 2));
  assert.notEqual(pace.bar.pressure, percent.bar.pressure);
});

test("every palette slot is a supported value and an unknown one falls back", async () => {
  assert.ok(LIMIT_BAR_COLORS.includes("accent"));
  assert.ok(LIMIT_BAR_COLORS.includes("neutral"));
  replaceUsageLimitsPrefs({ barColor: "chartreuse", barFactor: "holographic" });
  const stored = (await import("../widgets/usage/limitsPrefs.ts")).getUsageLimitsPrefs();
  assert.equal(stored.barColor, DEFAULT_USAGE_LIMITS_PREFS.barColor);
  assert.equal(stored.barFactor, "pace");
});

test("the Limits page fill carries the selected mode and pins the static colour", async () => {
  const provider = {
    providerId: "antigravity", fetchedAt: now, stale: false,
    windows: [window], balances: [], pace: { [window.id]: comfortablePace },
  };
  const previous = globalThis.fetch;
  const container = document.createElement("div");
  document.body.append(container);
  const fill = () => container.querySelector(".usage-limit-window") as HTMLElement | null;
  try {
    for (const [prefs, expected] of [
      [{ ...DEFAULT_USAGE_LIMITS_PREFS, barFactor: "pace" as const }, { color: "pace", pace: "0" }],
      [{ ...DEFAULT_USAGE_LIMITS_PREFS, barFactor: "percent" as const }, { color: "percent", pace: "1" }],
      [{ ...DEFAULT_USAGE_LIMITS_PREFS, barFactor: "static" as const, barColor: "purple" as const }, { color: "static", pace: null }],
    ] as const) {
      replaceUsageLimitsPrefs(prefs);
      globalThis.fetch = (async () => Response.json({ fetchedAt: now, providers: [provider] })) as typeof fetch;
      // A fresh root per mode: the page reads the stored preference at mount, so
      // rendering twice into one root would not exercise the change.
      const root = createRoot(container);
      await act(async () => { root.render(createElement(LimitsView)); });
      for (let i = 0; i < 100 && !fill(); i++) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
      }
      const element = fill()!;
      assert.equal(element.dataset.color, expected.color);
      const paceVar = element.style.getPropertyValue("--usage-limit-pace");
      if (expected.pace === null) assert.equal(paceVar, "");
      else assert.ok(Math.abs(Number(paceVar) - Number(expected.pace)) < 1e-9, `pace var ${paceVar} != ${expected.pace}`);
      if (expected.color === "static") {
        assert.equal(element.style.getPropertyValue("--usage-limit-color"), "var(--usage-bar-purple)");
      } else {
        assert.equal(element.style.getPropertyValue("--usage-limit-color"), "");
      }
      await act(async () => { root.unmount(); });
    }
  } finally {
    container.remove();
    globalThis.fetch = previous;
  }
});

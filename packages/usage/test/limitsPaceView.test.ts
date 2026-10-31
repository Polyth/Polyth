import test, { after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { QuotaPace, QuotaWindow } from "@polyth/contracts";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LimitsView, classifyLimitPace, formatLimitPaceBudget, pacePressure, paceProjection } =
  await import("../widgets/usage/LimitsView.tsx");
const { paceBrief, relativeTime } = await import("../widgets/usage/limitsModel.ts");

const now = Date.now();
const window: QuotaWindow = {
  id: "google-models", label: "Google models (5h)", unit: "percent",
  used: 2, limit: 100, periodMs: 5 * 3_600_000, resetsAt: now + 5 * 3_600_000 - 3 * 60_000,
};
const pace: QuotaPace = { usageFraction: .02, timeFraction: .01, pace: "over", predictedAtReset: 5 };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => Response.json({
  fetchedAt: now,
  providers: [{ providerId: "antigravity", fetchedAt: now, stale: false,
    windows: [window], balances: [], pace: { [window.id]: pace } }],
})) as typeof fetch;
after(async () => {
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
});

test("observed reset forecast takes precedence over an initial burst for every sensitivity", () => {
  for (const sensitivity of ["stable", "balanced", "responsive"] as const) {
    assert.equal(classifyLimitPace(pace, window, sensitivity), "comfortable");
    assert.equal(classifyLimitPace({ ...pace, predictedAtReset: 99 }, window, sensitivity), "on-track");
    assert.equal(classifyLimitPace({ ...pace, predictedAtReset: 110, exhaustsAt: now + 3_600_000 }, window, sensitivity), "likely");
    assert.equal(classifyLimitPace(pace, { ...window, used: 100 }, sensitivity), "exhausted");
  }
});

test("the brief verdict names when a window runs out, else the pace with the share left at reset", () => {
  const at = new Date(now);
  at.setHours(22, 25, 0, 0);
  const likely = { ...pace, predictedAtReset: 160, exhaustsAt: at.getTime() };
  const today = { ...window, resetsAt: at.getTime() + 3_600_000 };
  const clock = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(at);
  assert.equal(paceBrief("likely", likely, today, at.getTime() - 3_600_000, true), `Runs out ~${clock}`);
  // Another day carries its weekday, so a time tomorrow never reads as today.
  const later = paceBrief("likely", likely, today, at.getTime() - 86_400_000, true);
  assert.match(later, /^Runs out ~\w{3} /);
  assert.equal(paceBrief("comfortable", pace, window, now, true), "Comfortable · ~95% left at reset");
  assert.equal(paceBrief("comfortable", { ...pace, predictedAtReset: undefined }, window, now, true), "Comfortable");
  // Projections off: the label alone, even for a window that will run out.
  assert.equal(paceBrief("likely", likely, today, at.getTime() - 3_600_000, false), "Likely to exhaust");
  assert.equal(paceBrief("exhausted", likely, { ...today, used: 100 }, now, true), "Exhausted");
});

test("sparse early observations wait, then use an explicit steady budget with unsigned percentage points", () => {
  const sparse = { ...pace, predictedAtReset: undefined };
  assert.equal(classifyLimitPace(sparse, window, "balanced"), null);
  assert.equal(classifyLimitPace({ ...sparse, timeFraction: .5 }, window, "balanced"), "comfortable");
  assert.equal(formatLimitPaceBudget(pace), null);
  assert.equal(formatLimitPaceBudget(sparse), "1 pp above steady budget");
  assert.equal(formatLimitPaceBudget({ ...sparse, timeFraction: .5 }), "48 pp below steady budget");
  assert.equal(formatLimitPaceBudget({ ...sparse, timeFraction: .02 }), "At steady budget");
});

test("pacing pressure is a continuous 0..1 signal that follows pace, never the remaining share", () => {
  const pressure = (patch: Partial<QuotaPace> | null, overrides: Partial<QuotaWindow> = {}) =>
    pacePressure(patch === null ? null : { ...pace, ...patch }, { ...window, ...overrides }, "balanced");
  // Comfortably under budget, on budget, and past the threshold.
  assert.equal(pressure(null), null);
  assert.equal(pressure({ predictedAtReset: 5 }), 0);
  assert.ok(Math.abs(pressure({ predictedAtReset: 100 })! - 0.5) < 1e-9);
  assert.equal(pressure({ predictedAtReset: 130 }), 1);
  // A reset forecast still pending must not colour the fill from an initial burst.
  assert.equal(pressure({ predictedAtReset: undefined }), null);
  // Observed-rate fallback drives the same ramp once elapsed time is usable.
  assert.equal(pressure({ predictedAtReset: undefined, usageFraction: .9, timeFraction: .5 }), 1);
  // Exhaustion and a forecast that lands before the reset pin to the top.
  assert.equal(pressure({}, { used: 100 }), 1);
  assert.equal(pressure({ predictedAtReset: 110, exhaustsAt: now + 3_600_000 }), 1);
  // Sensitivity widens or narrows the ramp; the same 1.05 ratio sits higher when responsive.
  const ratio = 1.05;
  assert.equal(pacePressure(pace, window, "stable"), 0);
  const pressured = (sensitivity: "stable" | "balanced" | "responsive") =>
    pacePressure({ ...pace, predictedAtReset: ratio * 100 }, window, sensitivity)!;
  assert.ok(pressured("stable") < pressured("balanced"));
  assert.ok(pressured("balanced") < pressured("responsive"));
});

test("a measured window drops the redundant sub-line while an uncapped one keeps its explanation", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({
    fetchedAt: now,
    providers: [
      { providerId: "antigravity", fetchedAt: now, stale: false,
        windows: [window], balances: [], pace: { [window.id]: pace } },
      { providerId: "opencode-go", fetchedAt: now, stale: false,
        windows: [{ id: "status", label: "Status", used: 0, limit: 0, unit: "requests" }],
        balances: [], pace: {} },
    ],
  })) as typeof fetch;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const headFor = (label: string) => [...container.querySelectorAll(".usage-limit-window-head")]
    .find((head) => head.querySelector("strong")?.textContent?.includes(label));
  try {
    await act(async () => { root.render(createElement(LimitsView)); });
    for (let i = 0; i < 100 && !headFor("Status"); i++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    assert.equal(headFor("Google models")?.querySelector("small"), null);
    assert.match(headFor("Status")?.querySelector("small")?.textContent ?? "", /without a comparable cap/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    globalThis.fetch = previous;
  }
});

test("an exhausted window states exhaustion only, without a further exhaustion forecast", () => {
  const exhaustedWindow = { ...window, used: 100 };
  const beforeReset: QuotaPace = { usageFraction: 1, timeFraction: .5, pace: "over", predictedAtReset: 140, exhaustsAt: now - 3_600_000 };
  assert.equal(classifyLimitPace(beforeReset, exhaustedWindow, "balanced"), "exhausted");
  // "Exhausted · may exhaust an hour ago" is exactly the contradiction to avoid.
  assert.equal(paceProjection(beforeReset, exhaustedWindow, now), null);
  assert.equal(paceProjection({ ...beforeReset, predictedAtReset: undefined }, exhaustedWindow, now), null);
  // An over-cap window is exhausted too (used above the reported limit).
  assert.equal(paceProjection(beforeReset, { ...window, used: 120 }, now), null);
  // A window with capacity left still forecasts normally.
  assert.equal(paceProjection(beforeReset, window, now), `may exhaust ${relativeTime(beforeReset.exhaustsAt!, now)}`);
});

test("Limits renders the reported 2% example with a consistent status and unambiguous remaining forecast", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(LimitsView)); });
    for (let i = 0; i < 100 && !container.querySelector(".usage-limit-pace"); i++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    assert.equal(container.querySelector(".usage-limit-pace")?.textContent,
      "Comfortable · ~95% left at reset at current rate");
    assert.match(container.textContent ?? "", /98% left/);
    // The meter and its caption carry the numbers; the redundant "% used · limit"
    // sub-line is gone from a measurable window.
    assert.doesNotMatch(container.textContent ?? "", /used · 100% limit/);
    assert.equal(container.querySelector(".usage-limit-window-head small"), null);
    assert.doesNotMatch(container.textContent ?? "", /Elevated|behind|ahead/);
    // The row stays neutral; only the fill carries the pace signal.
    const row = container.querySelector(".usage-limit-window") as HTMLElement | null;
    assert.ok(row);
    assert.doesNotMatch(row!.className, /warning|critical/);
    assert.equal(row!.getAttribute("data-pace"), null);
    assert.equal(row!.style.getPropertyValue("--usage-limit-pace"), "0");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

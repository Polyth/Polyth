import test, { after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { WebNotificationInput } from "@polyth/web-sdk";

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
const { UsageLimitsSettings } = await import("../widgets/usage/UsageLimitsSettings.tsx");
const { getUsageAlertPrefs, resetUsageAlertPrefs } = await import("../widgets/usage/alertsPrefs.ts");
const { startUsageAlerts } = await import("../widgets/usage/alertsController.ts");

const now = Date.now();
const providers = [
  { providerId: "claude", fetchedAt: now, stale: false, balances: [], pace: {},
    windows: [{ id: "5h", label: "5-hour", unit: "percent", used: 20, limit: 100, periodMs: 5 * 3_600_000, resetsAt: now + 3_600_000 }] },
  { providerId: "codex", fetchedAt: now, stale: false, balances: [], pace: {},
    windows: [{ id: "weekly", label: "Weekly", unit: "percent", used: 5, limit: 100 }] },
];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => Response.json({ fetchedAt: now, providers })) as typeof fetch;
after(async () => {
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
});

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
};

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(UsageLimitsSettings)));
  await flush();
  return {
    host,
    rule: (key: string) => host.querySelector(`[data-usage-alert-rule="${key}"]`) as HTMLElement | null,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("the Usage page lists every notification rule with its switch and live description", async () => {
  resetUsageAlertPrefs();
  const view = await mount();
  const titles = [...view.host.querySelectorAll(".settings-section-title")].map((node) => node.textContent);
  assert.deepEqual(titles, ["Display", "Bar colour", "Pace", "Highlights", "Notifications", "Limit alerts", "After a turn", "Sources"]);
  for (const key of ["pace", "low", "exhausted", "restored", "sourceProblems", "turn", "cache"]) assert.ok(view.rule(key), key);
  assert.match(view.rule("low")!.textContent ?? "", /When 25% or 10% of a limit is left\./);
  assert.match(view.host.textContent ?? "", /5 of 7 notifications on\./);
  // Options open under a rule only while it is on.
  assert.ok(view.host.querySelector('[aria-label="Running low options"]'));
  assert.equal(view.host.querySelector('[aria-label="Turn summary options"]'), null);

  const turnSwitch = view.rule("turn")!.querySelector('[role="switch"]') as HTMLElement;
  await act(async () => turnSwitch.click());
  assert.equal(getUsageAlertPrefs().turn, true);
  assert.ok(view.host.querySelector('[aria-label="Turn summary options"]'));
  assert.match(view.rule("turn")!.textContent ?? "", /Tokens, cost,? and limits left after each turn in the chat on screen\./);

  // Both reporting sources are offered for muting.
  const sources = view.host.querySelector('[role="group"][aria-label="Watch sources"]');
  assert.ok(sources);
  assert.equal(sources.querySelectorAll('input[type="checkbox"]').length, 2);
  await view.unmount();
});

test("the master switch quiets every rule and previews need a running controller", async () => {
  resetUsageAlertPrefs();
  const shown: WebNotificationInput[] = [];
  const stop = startUsageAlerts({
    notifications: { show: (input) => { shown.push(input); }, dismiss: () => undefined },
    sessions: { get: () => undefined, events: () => [], subscribeEvents: () => () => undefined },
    visibleSessionId: () => null,
    openLimits: () => undefined,
    openSettings: () => undefined,
    openSession: () => undefined,
    loadLimits: async () => ({ fetchedAt: now, providers: [] }),
    refreshLimitSource: async () => ({ fetchedAt: now, providers: [] }),
    cachedLimits: () => null,
    storage: null,
    visibility: { visible: () => true, subscribe: () => () => undefined },
  });
  const view = await mount();
  const preview = view.rule("exhausted")!.querySelector('button[aria-label="Preview “Limit reached”"]') as HTMLElement;
  assert.ok(preview);
  await act(async () => preview.click());
  assert.deepEqual(shown.map((input) => [input.id, input.kind]), [["preview:exhausted", "error"]]);

  const master = [...view.host.querySelectorAll('[role="switch"]')]
    .find((node) => node.getAttribute("aria-label") === "Usage notifications") as HTMLElement;
  await act(async () => master.click());
  assert.equal(getUsageAlertPrefs().enabled, false);
  assert.match(view.host.textContent ?? "", /Off\. Limits and turns stay quiet\./);
  assert.equal(view.host.querySelector('button[aria-label^="Preview"]'), null);
  assert.ok([...view.host.querySelectorAll(".usage-alert-rule [role=switch]")].every((node) => (node as HTMLButtonElement).disabled));
  await view.unmount();
  stop();
  resetUsageAlertPrefs();
});

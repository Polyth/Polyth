// Usage's status-bar segments, mounted from their widget definitions the way
// the bar's widget areas render them: context and spend, prompt cache, and the
// tightest limit of the session's route.
import test, { after, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { QuotaWindow, SessionEvent, SessionProjection } from "@polyth/contracts";
import { applyEvents, setSessions } from "../../../apps/web/src/store.ts";
import { computePace } from "../src/pace.ts";
import type { UsageLimitSnapshotDto } from "../widgets/usage/limitsClient.ts";
import type { RequestedUsageView } from "../widgets/usage/viewRequest.ts";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = globalThis.fetch;
after(async () => { globalThis.fetch = originalFetch; await dom.happyDOM.close(); });
afterEach(() => mock.timers.reset());
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { barCost, clockDuration, createUsageStatusbarPlugin, tightestLimit, turnDuration } = await import("../widgets/statusbarSegments.tsx");
const { limitGroups } = await import("../widgets/usage/limitsModel.ts");
const { DEFAULT_USAGE_LIMITS_PREFS } = await import("../widgets/usage/limitsPrefs.ts");

const NOW = Date.UTC(2026, 9, 9, 10, 0, 0);
const MIN = 60_000;
const H = 3_600_000;
const PROJECT = "statusbar-usage-project";
const anthropic = { providerID: "anthropic", modelID: "claude-sonnet-4-5" };

function seed(
  id: string,
  usage: Array<[number, { input: number; output: number; cacheRead?: number; cacheWrite?: number }]>,
  extra: Partial<SessionProjection> = {},
): { projection: SessionProjection; events: SessionEvent[] } {
  const projection = {
    id, projectId: PROJECT, title: id, status: "idle", createdAt: 1, updatedAt: 1,
    model: anthropic, resolvedHarnessId: "claude", ...extra,
  } as SessionProjection;
  const events = usage.map(([offset, tokens], index) => ({
    id: `${id}:u${index}`, sessionId: id, seq: index + 1, type: "usage/recorded", time: NOW + offset, v: 1,
    data: { model: anthropic, tokens },
  } as SessionEvent));
  return { projection, events };
}

const fixtures = [
  seed("warm", [[-MIN, { input: 10, output: 20, cacheRead: 30_000, cacheWrite: 2_000 }]], {
    costTotal: 1.19,
    contextWindow: { source: "native", updatedAt: NOW - MIN, usedTokens: 73_435, limitTokens: 1_000_000 },
  }),
  seed("expiring", [[-260_000, { input: 10, output: 20, cacheRead: 64_000, cacheWrite: 4_000 }]]),
  seed("expired", [[-12 * MIN, { input: 10, output: 20, cacheRead: 170_000, cacheWrite: 12_000 }]]),
  seed("working", [[-30_000, { input: 10, output: 20, cacheRead: 40_000, cacheWrite: 2_000 }]], { status: "working" }),
  seed("fresh", []),
];
// A finished 36 s turn, and a turn still running for 42 s.
const turnEvent = (sessionId: string, seq: number, type: string, time: number, data: Record<string, unknown>) =>
  ({ id: `${sessionId}:t${seq}`, sessionId, seq, type, time, v: 1, data }) as SessionEvent;
const T0 = NOW - 10 * MIN;
fixtures.push({
  projection: { id: "timed", projectId: PROJECT, title: "timed", status: "idle", createdAt: 1, updatedAt: 1, model: anthropic, resolvedHarnessId: "claude" } as SessionProjection,
  events: [
    turnEvent("timed", 1, "turn/started", T0, { turnId: "turn-1" }),
    turnEvent("timed", 2, "assistant/chunk", T0 + 1_500, { turnId: "turn-1", text: "Hi" }),
    turnEvent("timed", 3, "usage/recorded", T0 + 35_000, { turnId: "turn-1", model: anthropic, tokens: { input: 500, output: 1_866 } }),
    turnEvent("timed", 4, "assistant/chunk", T0 + 35_500, { turnId: "turn-1", text: "!" }),
    turnEvent("timed", 5, "turn/stopped", T0 + 36_000, { turnId: "turn-1", reason: "completed" }),
  ],
}, {
  projection: { id: "running", projectId: PROJECT, title: "running", status: "working", createdAt: 1, updatedAt: 1, model: anthropic, resolvedHarnessId: "claude" } as SessionProjection,
  events: [turnEvent("running", 1, "turn/started", NOW - 42_000, { turnId: "turn-9" })],
});
setSessions(PROJECT, fixtures.map((entry) => entry.projection));
applyEvents(fixtures.flatMap((entry) => entry.events));

const win = (id: string, label: string, used: number): QuotaWindow => ({
  id, label, used, limit: 100, unit: "percent", resetsAt: NOW + 4 * H, periodMs: 5 * H,
});
const snapshot = (providerId: string, windows: QuotaWindow[]): UsageLimitSnapshotDto => ({
  providerId, windows, balances: [], fetchedAt: NOW, stale: false,
  pace: Object.fromEntries(windows.map((window) => [window.id, computePace(window, [], { now: NOW })])),
});
globalThis.fetch = async (input) => {
  if (String(input).includes("/api/usage/limits")) {
    return Response.json({
      providers: [
        snapshot("claude", [win("five-hour", "5h", 20), win("weekly", "Weekly", 91)]),
        snapshot("openai", [win("five-hour", "5h", 99)]),
      ],
      fetchedAt: NOW,
    });
  }
  return new Response("not found", { status: 404 });
};

const opened: RequestedUsageView[] = [];
const plugin = createUsageStatusbarPlugin((key) => key, (view) => opened.push(view));
const widget = (id: string) => plugin.widgets!.find((entry) => entry.id === id)!;

async function mount(widgetId: string, sessionId: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(widget(widgetId).render({
    sessionId, projectId: PROJECT, instanceId: widgetId, config: {}, updateConfig() {}, editing: false,
  })));
  for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); });
  return {
    segment: container.querySelector<HTMLButtonElement>(".usage-sb"),
    container,
    dispose: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("the segments are movable mini-widgets of both status-bar ends", () => {
  assert.deepEqual(plugin.widgets!.map((entry) => entry.id), [
    "usage.statusbar.context", "usage.statusbar.cache", "usage.statusbar.turn", "usage.statusbar.limits",
  ]);
  for (const entry of plugin.widgets!) {
    assert.equal(entry.kind, "mini-widget");
    assert.equal(entry.defaultSlot, "app.statusbar.trailing");
    assert.deepEqual([...entry.supportedSlots!], ["app.statusbar.leading", "app.statusbar.trailing"]);
    assert.equal(entry.requiredVisible, undefined, "each one can be hidden");
  }
});

test("context shows tokens, the level-coloured share and the session's spend; a click opens Session usage", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const view = await mount("usage.statusbar.context", "warm");
  try {
    const segment = view.segment!;
    assert.ok(segment, "the segment renders");
    assert.equal(segment.dataset.level, "green");
    assert.match(segment.textContent ?? "", /73\.4k \(7%\)/);
    assert.match(segment.textContent ?? "", /· \$1\.19/);
    assert.match(segment.getAttribute("aria-label") ?? "", /Context: 7% \(73\.4k \/ 1\.0M\) · Cost: \$1\.19/);
    opened.length = 0;
    await act(async () => segment.click());
    assert.deepEqual(opened, ["session"]);
  } finally {
    await view.dispose();
  }
});

test("cache follows the session card's states and tones", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  const cases: Array<[string, RegExp, string, string | undefined]> = [
    ["warm", /4 min left/, "warm", undefined],
    ["expiring", /40 sec left/, "expiring", "warning"],
    ["expired", /Expired/, "expired", "critical"],
    ["working", /In use/, "active", undefined],
  ];
  for (const [sessionId, text, state, tone] of cases) {
    const view = await mount("usage.statusbar.cache", sessionId);
    try {
      assert.ok(view.segment, `${sessionId} renders`);
      assert.match(view.segment!.textContent ?? "", text, sessionId);
      assert.equal(view.segment!.dataset.state, state, sessionId);
      assert.equal(view.segment!.dataset.tone, tone, sessionId);
    } finally {
      await view.dispose();
    }
  }
});

test("without a session or any data the segments take no room", async () => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  for (const [widgetId, sessionId] of [
    ["usage.statusbar.context", null],
    ["usage.statusbar.cache", null],
    ["usage.statusbar.limits", null],
    ["usage.statusbar.context", "fresh"],
    ["usage.statusbar.cache", "fresh"],
  ] as const) {
    const view = await mount(widgetId, sessionId);
    try {
      assert.equal(view.container.innerHTML, "", `${widgetId} for ${sessionId ?? "no session"}`);
    } finally {
      await view.dispose();
    }
  }
});

test("limits names the window that runs out first on the session's route and opens Limits", async () => {
  const view = await mount("usage.statusbar.limits", "warm");
  try {
    const segment = view.segment!;
    assert.ok(segment, "the segment renders once the snapshot arrives");
    assert.match(segment.textContent ?? "", /^Weekly9% left$/, "the claude weekly window is the tightest; openai is not this route");
    assert.equal(segment.dataset.tone, "critical");
    opened.length = 0;
    await act(async () => segment.click());
    assert.deepEqual(opened, ["limits"]);
  } finally {
    await view.dispose();
  }
});

test("bar spend keeps whole cents and never reads as free", () => {
  assert.equal(barCost(1.19), "$1.19");
  assert.equal(barCost(12.844), "$12.84");
  assert.equal(barCost(0.001), "<$0.01");
});

test("turn clock and duration formats", () => {
  assert.equal(clockDuration(42_000), "0:42");
  assert.equal(clockDuration(12 * MIN + 5_000), "12:05");
  assert.equal(clockDuration(62 * MIN + 5_000), "1:02:05");
  assert.equal(turnDuration(36_000), "36.0s");
  assert.equal(turnDuration(125_000), "2:05");
});

test("a running turn ticks a live timer; a finished one shows its time and response speed", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval"], now: NOW });
  const running = await mount("usage.statusbar.turn", "running");
  try {
    assert.equal(running.segment?.dataset.state, "running");
    assert.equal(running.segment?.textContent, "0:42");
    await act(async () => mock.timers.tick(3_000));
    assert.equal(running.segment?.textContent, "0:45", "the clock moves every second");
  } finally {
    await running.dispose();
  }
  const done = await mount("usage.statusbar.turn", "timed");
  try {
    assert.equal(done.segment?.dataset.state, "done");
    assert.match(done.segment?.textContent ?? "", /^36\.0s· [\d.]+ tok\/s$/);
    assert.match(done.segment?.getAttribute("aria-label") ?? "", /^Last turn took 36\.0s · [\d.]+ tok\/s$/);
  } finally {
    await done.dispose();
  }
});

test("the tightest limit skips windows without a comparable cap", () => {
  const groups = limitGroups([
    { ...snapshot("a", [win("x", "Daily", 10)]), balances: [{ id: "credit", label: "Credit", amount: 4, unit: "currency" }] },
    snapshot("b", [win("y", "Monthly", 60)]),
  ], DEFAULT_USAGE_LIMITS_PREFS, NOW);
  assert.equal(tightestLimit(groups)?.row.label, "Monthly");
  assert.equal(tightestLimit([]), null);
});

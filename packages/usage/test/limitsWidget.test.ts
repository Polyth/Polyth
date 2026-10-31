import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { JsonObject, QuotaWindow, SessionProjection } from "@polyth/contracts";
import { computePace } from "../src/pace.ts";
import type { UsageLimitSnapshotDto } from "../widgets/usage/limitsClient.ts";

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
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LimitsWidget, LimitsWidgetSettings } = await import("../widgets/usage/LimitsWidget.tsx");
const model = await import("../widgets/usage/limitsModel.ts");
const { DEFAULT_USAGE_LIMITS_PREFS, replaceUsageLimitsPrefs } = await import("../widgets/usage/limitsPrefs.ts");

const now = Date.now();
const H = 3_600_000;
const win = (
  id: string, label: string, used: number, resetsIn?: number, period?: number,
  unit: QuotaWindow["unit"] = "percent", limit = 100,
): QuotaWindow => ({
  id, label, used, limit, unit,
  ...(resetsIn !== undefined ? { resetsAt: now + resetsIn } : {}),
  ...(period !== undefined ? { periodMs: period } : {}),
});
// Pace is what the limits service attaches to every window: present once a reset and a period are known.
const snapshot = (
  providerId: string, windows: QuotaWindow[], extra: Partial<UsageLimitSnapshotDto> = {},
): UsageLimitSnapshotDto => ({
  providerId, windows, balances: [], fetchedAt: now, stale: false,
  pace: Object.fromEntries(windows.map((window) => [window.id, computePace(window, [], { now })])),
  ...extra,
});

// Claude carries model-scoped weekly windows; Codex a balance; OpenCode Go a request window with
// no reset; Cursor has never answered.
const claude = snapshot("claude", [
  win("5h", "5h", 30, 3 * H, 5 * H),
  win("7d", "7d", 90, 48 * H, 168 * H),
  win("sonnet/7d", "Sonnet 7d", 10, 48 * H, 168 * H),
  win("opus/7d", "Opus 7d", 50, 48 * H, 168 * H),
], { accountLabel: "Max 5x" });
const codex = snapshot("codex", [win("5h", "5h limit", 5, 4 * H, 5 * H)], {
  accountLabel: "Codex (pro)",
  balances: [{ id: "credits_balance", label: "Credits balance", amount: 12.5, unit: "currency", valueLabel: "$12.50 available" }],
});
const opencodeGo = snapshot("opencode-go", [win("rolling", "Rolling", 20, undefined, undefined, "requests")]);
const cursor = snapshot("cursor", [], {
  stale: true, fetchedAt: 0, error: { code: "never-fetched", message: "no limit data yet" },
});
const providers = [claude, codex, opencodeGo, cursor];

const session = (harness: string, providerID: string, modelID: string, title = "Session A") =>
  ({ id: "session-a", title, resolvedHarnessId: harness, model: { providerID, modelID } }) as unknown as SessionProjection;
const claudeOpus = session("claude", "anthropic", "claude-opus-4-1");

// ---- model: configuration ------------------------------------------------------------------

test("widget config falls back to the current harness as pace bars and ignores legacy or malformed values", () => {
  assert.deepEqual(model.limitsWidgetPreferences({}), { style: "pace", source: "current", sources: [], showReset: true });
  assert.deepEqual(
    model.limitsWidgetPreferences({ style: "gauge", source: "everything", sources: "claude", showReset: 0 }),
    { style: "pace", source: "current", sources: [], showReset: true },
  );
  assert.deepEqual(
    model.limitsWidgetPreferences({ style: "hero", source: "selected", sources: [" Claude ", "codex", "CODEX", 4, "", null], showReset: false }),
    { style: "hero", source: "selected", sources: ["claude", "codex"], showReset: false },
  );
  for (const style of model.LIMITS_WIDGET_STYLES) assert.equal(model.limitsWidgetPreferences({ style }).style, style);
  assert.equal(model.LIMITS_WIDGET_STYLES.length, 7);
});

// ---- model: which sources are "current" -----------------------------------------------------

test("the current harness or model provider resolves to its limit source, once, in snapshot order", () => {
  const ids = ["codex", "claude", "opencode-go", "command-code", "xai", "cursor"];
  const current = (harness: string | undefined, providerID?: string) =>
    model.currentLimitSources({
      ...(harness ? { resolvedHarnessId: harness } : {}),
      ...(providerID ? { model: { providerID, modelID: "m" } } : {}),
    }, ids);
  assert.deepEqual(current("claude", "anthropic"), ["claude"]);
  assert.deepEqual(current("codex", "openai"), ["codex"]);
  assert.deepEqual(current("opencode", "opencode-go"), ["opencode-go"]);
  assert.deepEqual(current("opencode", "anthropic"), ["claude"]);
  assert.deepEqual(current("commandcode"), ["command-code"]);
  assert.deepEqual(current("grok"), ["xai"]);
  assert.deepEqual(current("cursor", "cursor"), ["cursor"]);
  assert.deepEqual(current("opencode", "openrouter"), []);
  assert.deepEqual(current("pi", "xiaomi"), []);
  assert.deepEqual(model.currentLimitSources(null, ids), []);
  assert.deepEqual(model.currentLimitSources({ resolvedHarnessId: "claude" }, ["gone"]), []);
});

test("the opencode model alias does not leak Zen through an OpenCode harness", () => {
  const ids = ["opencode-zen", "opencode-go", "claude", "codex"];
  const current = (harness: string | undefined, providerID?: string) =>
    model.currentLimitSources({
      ...(harness ? { resolvedHarnessId: harness } : {}),
      ...(providerID ? { model: { providerID, modelID: "m" } } : {}),
    }, ids);
  assert.deepEqual(current("opencode", "anthropic"), ["claude"]);
  assert.deepEqual(current("opencode", "opencode"), ["opencode-zen"]);
  assert.deepEqual(current("pi", "opencode"), ["opencode-zen"]);
});

test("regional and legacy provider ids resolve to their Kimi and Xiaomi sources", () => {
  const ids = ["kimi-for-coding", "kimi-code-plan-global", "xiaomi"];
  const current = (providerID: string) =>
    model.currentLimitSources({ model: { providerID, modelID: "m" } }, ids);
  for (const providerID of ["kimi-code", "kimi", "kimi-code-plan-cn", "kimi-for-coding"]) {
    assert.deepEqual(current(providerID), ["kimi-for-coding"], providerID);
  }
  assert.deepEqual(current("kimi-code-plan-global"), ["kimi-code-plan-global"]);
  for (const providerID of ["xiaomi", "xiaomi-mimo", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"]) {
    assert.deepEqual(current(providerID), ["xiaomi"], providerID);
  }
  assert.equal(model.limitSourceName({ providerId: "kimi-code-plan-cn" }), "Kimi Code (CN)");
  assert.equal(model.limitSourceName({ providerId: "xiaomi-token-plan-sgp" }), "Xiaomi MiMo");
});

test("Alibaba plan provider ids resolve to their own sources", () => {
  const ids = ["alibaba-coding-plan", "alibaba-token-plan"];
  const current = (providerID: string) =>
    model.currentLimitSources({ model: { providerID, modelID: "m" } }, ids);
  assert.deepEqual(current("alibaba"), ["alibaba-coding-plan"]);
  assert.deepEqual(current("alibaba-coding-plan"), ["alibaba-coding-plan"]);
  assert.deepEqual(current("alibaba-token-plan"), ["alibaba-token-plan"]);
  assert.equal(model.limitSourceName({ providerId: "alibaba" }), "Alibaba Coding Plan");
});

test("only a model's own scoped windows apply to it; account-wide windows always do", () => {
  for (const id of ["5h", "7d", "google-models", "third-party-models"]) assert.equal(model.windowAppliesToModel(id, "claude-opus-4-1"), true);
  assert.equal(model.windowAppliesToModel("opus/7d", "claude-opus-4-1"), true);
  assert.equal(model.windowAppliesToModel("sonnet/7d", "claude-opus-4-1"), false);
  assert.equal(model.windowAppliesToModel("sonnet/7d", undefined), false);
  assert.equal(model.windowAppliesToModel("claude-sonnet-4.5/7d", "claude-sonnet-4-5-20250929"), true);
  assert.equal(model.windowAppliesToModel("claude-sonnet-4.5/7d", "claude-sonnet-4-1"), false);
});

test("current, selected and all choose different sources; hiding only affects all", () => {
  const prefs = (patch: JsonObject) => model.limitsWidgetPreferences(patch);
  const ids = (list: UsageLimitSnapshotDto[]) => list.map((provider) => provider.providerId);
  const hidden = { ...DEFAULT_USAGE_LIMITS_PREFS, hiddenSources: ["opencode-go"] };
  assert.deepEqual(ids(model.limitProviders(providers, prefs({ source: "all" }), DEFAULT_USAGE_LIMITS_PREFS, null)), ["claude", "codex", "opencode-go", "cursor"]);
  assert.deepEqual(ids(model.limitProviders(providers, prefs({ source: "all" }), hidden, null)), ["claude", "codex", "cursor"]);
  assert.deepEqual(ids(model.limitProviders(providers, prefs({ source: "selected", sources: ["opencode-go", "Codex"] }), hidden, null)), ["codex", "opencode-go"]);
  assert.deepEqual(ids(model.limitProviders(providers, prefs({ source: "selected" }), hidden, claudeOpus)), []);
  assert.deepEqual(ids(model.limitProviders(providers, prefs({}), hidden, claudeOpus)), ["claude"]);
  assert.deepEqual(ids(model.limitProviders(providers, prefs({}), hidden, null)), []);
});

// ---- model: rows ----------------------------------------------------------------------------

test("a row fills with what it shows: remaining by default, used on request, with the steady-budget tick on the same axis", () => {
  const remaining = model.limitGroups([claude], DEFAULT_USAGE_LIMITS_PREFS, now)[0]!.rows;
  const five = remaining.find((row) => row.key === "claude/5h")!;
  assert.deepEqual(
    { fill: five.fill, remaining: five.remaining, short: five.short, word: five.word, value: five.value, tone: five.tone },
    { fill: .7, remaining: .7, short: "70%", word: "left", value: "70% left", tone: "ok" },
  );
  assert.ok(Math.abs(five.tick! - .6) < 1e-9, "remaining axis: 40% of the window elapsed leaves a steady 60%");
  assert.equal(five.pace?.label, "Comfortable");
  assert.equal(five.pace?.text, "Comfortable · 10 pp below steady budget");
  assert.equal(five.reset, model.formatLimitReset(now + 3 * H, "relative", now));

  const used = model.limitGroups([claude], { ...DEFAULT_USAGE_LIMITS_PREFS, displayMode: "used" }, now)[0]!.rows.find((row) => row.key === "claude/5h")!;
  assert.deepEqual({ fill: used.fill, short: used.short, word: used.word, value: used.value }, { fill: .3, short: "30%", word: "used", value: "30% used" });
  assert.ok(Math.abs(used.tick! - .4) < 1e-9, "used axis: an even burn has used 40% by now");
  assert.equal(used.remaining, .7, "the most-constrained ranking never depends on the display mode");

  const quiet = model.limitGroups([claude], { ...DEFAULT_USAGE_LIMITS_PREFS, showPace: false }, now)[0]!.rows[0]!;
  assert.deepEqual({ tick: quiet.tick, pace: quiet.pace }, { tick: null, pace: null });
});

test("low capacity warns, exhaustion and likely exhaustion are critical, and pace warnings can be switched off", () => {
  const tone = (window: QuotaWindow, pace: UsageLimitSnapshotDto["pace"][string], patch = {}) =>
    model.limitGroups([snapshot("p", [window], { pace: { [window.id]: pace } })], { ...DEFAULT_USAGE_LIMITS_PREFS, ...patch }, now)[0]!.rows[0]!.tone;
  assert.equal(tone(win("w", "w", 89, H, 5 * H), null), "ok");
  assert.equal(tone(win("w", "w", 90, H, 5 * H), null), "warning");
  assert.equal(tone(win("w", "w", 100, H, 5 * H), null), "critical");
  const likely = { usageFraction: .5, timeFraction: .5, pace: "over" as const, predictedAtReset: 120, exhaustsAt: now + H / 2 };
  assert.equal(tone(win("w", "w", 50, H, 5 * H), likely), "critical");
  assert.equal(tone(win("w", "w", 50, H, 5 * H), likely, { paceWarnings: false }), "ok");
});

test("balances and uncapped windows are text rows that never claim a meter value", () => {
  const rows = model.limitGroups([codex], DEFAULT_USAGE_LIMITS_PREFS, now)[0]!.rows;
  assert.deepEqual(rows.map((row) => row.key), ["codex/5h", "codex/credits_balance"]);
  const balance = rows[1]!;
  assert.deepEqual(
    { fill: balance.fill, remaining: balance.remaining, short: balance.short, value: balance.value, word: balance.word, tone: balance.tone, reset: balance.reset },
    { fill: null, remaining: null, short: "$12.50 available", value: "$12.50 available", word: "", tone: "ok", reset: null },
  );
  const unlimited = model.limitGroups([snapshot("u", [win("w", "Unlimited", 0, undefined, undefined, "requests", 0)])], DEFAULT_USAGE_LIMITS_PREFS, now)[0]!.rows[0]!;
  assert.deepEqual({ fill: unlimited.fill, value: unlimited.value }, { fill: null, value: "Unlimited" });
});

test("the current model hides other models' windows; selected and all keep every window", () => {
  const keys = (narrow?: { id: string | undefined }) => model.limitGroups([claude], DEFAULT_USAGE_LIMITS_PREFS, now, narrow)[0]!.rows.map((row) => row.key);
  assert.deepEqual(keys({ id: "claude-opus-4-1" }), ["claude/5h", "claude/7d", "claude/opus/7d"]);
  assert.deepEqual(keys({ id: "claude-sonnet-4-5" }), ["claude/5h", "claude/7d", "claude/sonnet/7d"]);
  assert.deepEqual(keys({ id: undefined }), ["claude/5h", "claude/7d"]);
  assert.deepEqual(keys(), ["claude/5h", "claude/7d", "claude/sonnet/7d", "claude/opus/7d"]);
});

test("a source with an error keeps its message; one with nothing at all is dropped", () => {
  const [group] = model.limitGroups([cursor], DEFAULT_USAGE_LIMITS_PREFS, now);
  assert.deepEqual({ name: group!.name, error: group!.error, rows: group!.rows.length, stale: group!.stale }, { name: "Cursor", error: "no limit data yet", rows: 0, stale: true });
  assert.deepEqual(model.limitGroups([snapshot("empty", [])], DEFAULT_USAGE_LIMITS_PREFS, now), []);
});

test("an account label that only repeats the source name is dropped; a plan label stays", () => {
  const [same] = model.limitGroups([snapshot("antigravity", [win("w", "w", 1)], { accountLabel: "Antigravity" })], DEFAULT_USAGE_LIMITS_PREFS, now);
  assert.equal(same!.account, undefined);
  assert.equal(model.limitGroups([claude], DEFAULT_USAGE_LIMITS_PREFS, now)[0]!.account, "Max 5x");
});

// ---- model: accounts of a multi-account harness ---------------------------------------------

const work = snapshot("claude-work", [win("5h", "5h", 70, 2 * H, 5 * H)], {
  accountLabel: "max", account: { family: "claude", harnessId: "claude-work", label: "Work" },
});

test("a session on one account sees that account's limits alone, never the default login's", () => {
  const sources = [codex, work, claude];
  assert.deepEqual(model.currentLimitSources(session("claude-work", "anthropic", "claude-opus-4-1"), sources), ["claude-work"]);
  assert.deepEqual(model.currentLimitSources(claudeOpus, sources), ["claude"]);
  assert.deepEqual(model.currentLimitSources(session("opencode", "anthropic", "claude-opus-4-1"), sources), ["claude"]);
  // An account whose source is not reported yet still must not borrow the default login.
  assert.deepEqual(model.currentLimitSources(session("claude-other", "anthropic", "claude-opus-4-1"), sources), []);
});

test("accounts read as source · account, sit beside their family, and head the widget by account", () => {
  assert.equal(model.limitSourceName(work), "Claude · Work");
  assert.equal(model.limitSourceName(claude), "Claude");
  assert.deepEqual(model.orderLimitSources([work, codex, claude, cursor]).map((source) => source.providerId), ["claude", "claude-work", "codex", "cursor"]);
  assert.deepEqual(model.orderLimitSources([codex, work, claude]).map((source) => source.providerId), ["codex", "claude", "claude-work"]);
  assert.equal(model.limitsHarnessName("claude-work", [work]), "Claude Code · Work");
  assert.equal(model.limitsHarnessName("claude-gone", [work]), "Claude Code · Gone");
  assert.equal(model.limitGroups([work], DEFAULT_USAGE_LIMITS_PREFS, now)[0]!.name, "Claude · Work");
});

// ---- widget: rendering -----------------------------------------------------------------------

let fail = false;
let hold: Promise<void> | null = null;
let served = providers;
let requests = 0;
beforeEach(() => {
  fail = false;
  hold = null;
  served = providers;
  requests = 0;
  replaceUsageLimitsPrefs(DEFAULT_USAGE_LIMITS_PREFS);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/usage/limits")) {
      requests += 1;
      await hold;
      return fail
        ? Response.json({ error: "limits-unavailable", message: "Limits backend offline" }, { status: 503 })
        : Response.json({ fetchedAt: now, providers: served });
    }
    return Response.json({});
  }) as typeof fetch;
});

async function settle() {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
}

async function mount(node: ReactNode) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () => root.render(node));
  await settle();
  return {
    element,
    render: async (next: ReactNode) => { await act(async () => root.render(next)); },
    text: () => element.textContent ?? "",
    all: (selector: string) => [...element.querySelectorAll(selector)],
    dispose: async () => { await act(async () => root.unmount()); element.remove(); },
  };
}

const widget = (config: JsonObject, sessionValue: SessionProjection | null = null, editing = false, panelSize?: "compact" | "standard") =>
  createElement(LimitsWidget, { session: sessionValue, config, editing, ...(panelSize ? { panelSize } : {}) });

test("an unreachable limits service is unavailable and retryable; loading shows before the first answer", async () => {
  fail = true;
  const failed = await mount(widget({ source: "all" }));
  try {
    assert.match(failed.text(), /Limits unavailable/);
    assert.match(failed.text(), /Limits backend offline/);
    assert.equal(failed.all(".usage-limits-widget button").some((button) => /Retry/.test(button.textContent ?? "")), true);
    assert.equal(failed.all("[role=meter]").length, 0);
  } finally { await failed.dispose(); }

  fail = false;
  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  const element = document.createElement("div");
  document.body.appendChild(element);
  const root = createRoot(element);
  await act(async () => root.render(widget({ source: "all" })));
  try {
    assert.match(element.textContent ?? "", /Loading limits…/);
    assert.equal(element.querySelector(".usage-limits-widget")!.getAttribute("aria-busy"), "true");
    release();
    await settle();
    assert.doesNotMatch(element.textContent ?? "", /Loading limits…/);
    assert.match(element.textContent ?? "", /Claude/);
  } finally { await act(async () => root.unmount()); element.remove(); }
});

test("the current harness shows only its source and the current model's windows, headed by harness and model", async () => {
  const card = await mount(widget({}, claudeOpus));
  try {
    assert.match(card.text(), /Current harness \/ model/);
    assert.match(card.element.querySelector(".usage-widget-heading strong")!.textContent!, /^Claude Code · claude-opus-4-1$/);
    assert.deepEqual(card.all(".usage-limits-group > h3 > span").map((node) => node.textContent), ["Claude"]);
    // The headline already names the one source: its heading is for assistive
    // tech only, and the plan sits beside the headline instead.
    assert.equal(card.element.querySelector(".usage-limits-group > h3")!.className, "sr-only");
    assert.equal(card.element.querySelector(".usage-limits-plan")!.textContent, "Max 5x");
    assert.equal(card.element.querySelector(".usage-widget-heading > div > span")!.className, "sr-only", "the source label yields to the headline");
    assert.deepEqual(
      card.all(".usage-limits-row-head > span").map((node) => node.textContent),
      ["5h", "7d", "Opus 7d"],
    );
    assert.doesNotMatch(card.text(), /Sonnet|Codex|Cursor/);
  } finally { await card.dispose(); }

  const sonnet = await mount(widget({}, session("claude", "anthropic", "claude-sonnet-4-5")));
  try {
    assert.deepEqual(sonnet.all(".usage-limits-row-head > span").map((node) => node.textContent), ["5h", "7d", "Sonnet 7d"]);
  } finally { await sonnet.dispose(); }
});

test("the current harness states why nothing is shown: no session, no matching source", async () => {
  const none = await mount(widget({}, null));
  try {
    assert.match(none.text(), /No active session/);
    assert.equal(none.all("[role=meter]").length, 0);
  } finally { await none.dispose(); }

  const unmatched = await mount(widget({}, session("pi", "xiaomi", "mimo-v2.5-pro")));
  try {
    assert.match(unmatched.text(), /No active limits for Pi · mimo-v2\.5-pro/);
    assert.equal(unmatched.all(".usage-limits-group").length, 0);
  } finally { await unmatched.dispose(); }
});

test("selected shows exactly the chosen sources, and says so when none is chosen", async () => {
  const some = await mount(widget({ source: "selected", sources: ["opencode-go", "codex"] }, claudeOpus));
  try {
    assert.deepEqual(some.all(".usage-limits-group > h3 > span").map((node) => node.textContent), ["Codex", "OpenCode Go"]);
    assert.equal(some.element.querySelector(".usage-widget-heading strong")!.textContent, "Codex, OpenCode Go");
    assert.doesNotMatch(some.text(), /Claude/);
  } finally { await some.dispose(); }

  const nothing = await mount(widget({ source: "selected" }, claudeOpus));
  try {
    assert.match(nothing.text(), /No limit sources/);
    assert.match(nothing.text(), /Select one or more sources in the widget settings/);
  } finally { await nothing.dispose(); }
});

test("all shows every visible source, keeps an unreachable one as a note, and honours hidden sources", async () => {
  const everything = await mount(widget({ source: "all" }));
  try {
    assert.deepEqual(everything.all(".usage-limits-group > h3 > span").map((node) => node.textContent), ["Claude", "Codex", "OpenCode Go"]);
    assert.equal(everything.element.querySelector(".usage-widget-heading strong"), null);
    assert.match(everything.all(".usage-widget-note").map((node) => node.textContent).join("|"), /Cursor: no limit data yet/);
    assert.doesNotMatch(everything.text(), /Showing the last successful report/, "a source with nothing to show is not stale data");
    assert.equal(everything.all(".usage-limits-group > h3 small")[0]!.textContent, "Max 5x");
    assert.equal(everything.element.querySelector(".usage-limits-plan"), null, "several sources keep their own headings and plans");
  } finally { await everything.dispose(); }

  replaceUsageLimitsPrefs({ ...DEFAULT_USAGE_LIMITS_PREFS, hiddenSources: ["claude", "cursor"] });
  const hidden = await mount(widget({ source: "all" }));
  try {
    assert.deepEqual(hidden.all(".usage-limits-group > h3 > span").map((node) => node.textContent), ["Codex", "OpenCode Go"]);
    assert.doesNotMatch(hidden.text(), /Cursor/);
  } finally { await hidden.dispose(); }
});

test("every display style renders the same limits in its own markup", async () => {
  const render = async (style: string, config: JsonObject = {}) => mount(widget({ source: "all", style, ...config }));
  const rows = (card: Awaited<ReturnType<typeof mount>>) => card.all(".usage-limits-widget [data-tone]");

  const bars = await render("bars");
  try {
    assert.equal(bars.element.querySelector(".usage-limits-widget")!.getAttribute("data-style"), "bars");
    assert.equal(bars.all(".usage-limits-meter--bar").length, 6, "one bar per measurable window");
    assert.equal(bars.all(".usage-limits-meter--bar b").length, 0, "no pace marker without the pace style");
    assert.equal(bars.all(".usage-limits-pace, .usage-limits-legend").length, 0, "nor a pace verdict or its legend");
    const first = bars.element.querySelector<HTMLElement>(".usage-limits-meter--bar")!;
    assert.deepEqual(
      [first.getAttribute("role"), first.getAttribute("aria-valuenow"), first.getAttribute("aria-valuetext"), first.getAttribute("aria-label")],
      ["meter", "70", "70% left", "5h"],
    );
    assert.match(bars.text(), /Resets in 3 hours/);
    assert.match(bars.text(), /\$12\.50 available/);
    assert.equal(bars.all(".usage-limits-row-head strong").map((node) => node.textContent).includes("10% left"), true);
    assert.equal(rows(bars).filter((node) => node.getAttribute("data-tone") === "warning").length, 1, "only the 7d window is low");
  } finally { await bars.dispose(); }

  const pace = await render("pace");
  try {
    assert.equal(pace.all(".usage-limits-meter--pace").length, 6);
    assert.equal(pace.all(".usage-limits-meter--pace b").length, 5, "a tick for every window that has a reset and a period");
    const verdict = pace.all(".usage-limits-pace")[0]!;
    assert.equal(verdict.textContent, "Comfortable", "the row says why the bar has its colour in a word");
    assert.match(verdict.getAttribute("title")!, /Comfortable · 10 pp below steady budget/, "the full forecast stays one hover away");
    assert.equal(pace.all(".usage-limits-legend").length, 1, "the tick is explained once");
  } finally { await pace.dispose(); }

  const segments = await render("segments");
  try {
    const meters = segments.all(".usage-limits-meter--segments");
    assert.equal(meters.length, 6);
    assert.ok(meters.every((meter) => meter.querySelectorAll("i").length === 10));
    assert.equal(meters[0]!.querySelectorAll('i[data-on="true"]').length, 7, "70% left lights seven of ten");
    assert.equal(meters[1]!.querySelectorAll('i[data-on="true"]').length, 1, "10% left still lights one segment");
  } finally { await segments.dispose(); }

  const rings = await render("rings");
  try {
    assert.equal(rings.all(".usage-limits-ring").length, 7, "every row gets a ring, text rows included");
    const arcs = rings.all(".usage-limits-ring circle + circle");
    assert.equal(arcs.length, 6);
    assert.equal(arcs[0]!.getAttribute("stroke-dasharray"), "70 100");
    assert.equal(arcs[0]!.getAttribute("pathLength"), "100");
    assert.match(rings.all(".usage-limits-ring")[0]!.textContent!, /^70%left$/);
    assert.match(rings.text(), /\$12\.50 available/);
  } finally { await rings.dispose(); }

  const chips = await render("chips");
  try {
    const items = chips.all(".usage-limits-chips > li");
    assert.equal(items.length, 7);
    assert.equal(items[0]!.querySelector("span")!.textContent, "Claude 5h", "several sources prefix the source name");
    assert.equal(items[0]!.querySelector("strong")!.textContent, "70%");
    assert.match(items[0]!.textContent!, /left/);
  } finally { await chips.dispose(); }

  const table = await render("table");
  try {
    assert.equal(table.all("table.usage-limits-table tr").length, 7);
    assert.equal(table.all("th[scope=row]")[0]!.textContent, "Claude · 5h");
    assert.match(table.all("tr")[0]!.textContent!, /Claude · 5h70% leftin 3 hoursComfortable/);
    assert.equal(table.all("tr")[1]!.querySelectorAll("td").length, 3, "the pace cell stays for every row once any row has pace");
  } finally { await table.dispose(); }

  const hero = await render("hero");
  try {
    assert.equal(hero.all(".usage-limits-hero").length, 1);
    const top = hero.element.querySelector(".usage-limits-hero")!;
    assert.equal(top.querySelector("strong")!.textContent, "10%", "the most constrained window leads");
    assert.match(top.textContent!, /Claude · 7d/);
    assert.equal(top.getAttribute("data-tone"), "warning");
    assert.equal(hero.all(".usage-limits-chips > li").length, 6, "every other row follows as a chip");
  } finally { await hero.dispose(); }

  const quiet = await render("bars", { showReset: false });
  try {
    assert.doesNotMatch(quiet.text(), /Resets/);
  } finally { await quiet.dispose(); }
});

test("the compact panel size keeps every style to a glance, with the reset and verdict on hover", async () => {
  const render = (style: string, panelSize: "compact" | "standard" = "compact") => mount(widget({ source: "all", style }, null, false, panelSize));
  for (const style of ["bars", "pace", "segments"]) {
    const card = await render(style);
    try {
      assert.equal(card.element.querySelector(".usage-limits-widget")!.hasAttribute("data-compact"), true);
      assert.equal(card.all(".usage-limits-rows").length, 1, "every source's rows share one grid");
      const rows = card.all(".usage-limits-rows li");
      assert.equal(rows.length, 7);
      assert.ok(rows.every((row) => row.querySelector(".usage-limits-row-label") && row.querySelector(":scope > strong")));
      assert.equal(card.all(".usage-limits-rows li > .usage-limits-meter-gap").length, 1, "the balance keeps the value in its column");
      assert.equal(card.all(".usage-limits-row-head, .usage-limits-row-meta, .usage-limits-pace, .usage-limits-legend").length, 0);
      assert.doesNotMatch(card.text(), /Resets/);
      assert.match(rows[0]!.getAttribute("title")!, /^5h: 70% left \(30% used · 100% limit\) · Resets in 3 hours/);
      if (style === "pace") {
        assert.equal(card.all(".usage-limits-meter--pace b").length, 5, "the steady-budget tick stays on the meter");
        assert.match(rows[0]!.getAttribute("title")!, /Comfortable/, "the verdict moves into the tooltip");
      }
    } finally { await card.dispose(); }
  }

  const rings = await render("rings");
  try {
    assert.equal(rings.all(".usage-limits-ring small").length, 0, "the ring holds the number alone");
    assert.doesNotMatch(rings.text(), /in 3 hours/);
    assert.equal(rings.all(".usage-limits-rings > li > small").length, 7, "several sources keep the source under each window");
    assert.ok(rings.element.querySelector(".usage-limits-ring[data-capless]")!.textContent!.includes("$12.50 available"));
  } finally { await rings.dispose(); }

  for (const style of ["chips", "hero"]) {
    const card = await render(style);
    try {
      assert.equal(card.all(".usage-limits-reset").length, 0, `${style}: pills carry no reset`);
    } finally { await card.dispose(); }
  }
  const hero = await render("hero");
  try {
    const top = hero.element.querySelector(".usage-limits-hero")!;
    assert.equal(top.querySelector(":scope > strong")!.textContent, "10% left", "the figure leads the line");
    assert.match(top.querySelector(":scope > div")!.textContent!, /Claude · 7d.*Resets in 2 days/);
  } finally { await hero.dispose(); }

  const table = await render("table");
  try {
    assert.ok(table.all("tr").every((row) => row.querySelectorAll("td").length === 1), "label and value only");
  } finally { await table.dispose(); }

  const standard = await render("pace", "standard");
  try {
    assert.equal(standard.element.querySelector(".usage-limits-widget")!.hasAttribute("data-compact"), false);
    assert.equal(standard.all(".usage-limits-rows").length, 0);
    assert.equal(standard.all(".usage-limits-legend").length, 1);
  } finally { await standard.dispose(); }
});

test("a single source labels rows by window alone, and the shared preferences drive the numbers", async () => {
  replaceUsageLimitsPrefs({ ...DEFAULT_USAGE_LIMITS_PREFS, displayMode: "used" });
  const card = await mount(widget({ source: "selected", sources: ["claude"], style: "chips" }));
  try {
    const first = card.element.querySelector(".usage-limits-chips > li")!;
    assert.equal(first.querySelector("span")!.textContent, "5h");
    assert.equal(first.querySelector("strong")!.textContent, "30%");
    assert.match(first.textContent!, /used/);
  } finally { await card.dispose(); }
});

test("a source that failed its last poll keeps its last values and says so, with the reason on hover", async () => {
  served = [{ ...codex, stale: true, error: { code: "fetch-failed", message: "Codex usage request failed" } }, claude];
  const card = await mount(widget({ source: "all", style: "bars" }));
  try {
    const note = card.element.querySelector<HTMLElement>(".usage-widget-note span")!;
    assert.match(note.textContent!, /Showing the last successful report/);
    assert.equal(note.getAttribute("title"), "Codex usage request failed");
    assert.match(card.text(), /5h limit95% left/, "the retained values are still shown");
  } finally { await card.dispose(); }
});

test("a failed refresh keeps the last limits visible with a note; editing hides the inline actions", async () => {
  const warm = await mount(widget({ source: "all", style: "chips" }));
  await warm.dispose();
  fail = true;
  const stale = await mount(widget({ source: "all", style: "chips" }));
  try {
    assert.equal(stale.all(".usage-limits-chips > li").length, 7, "the cached limits stay on screen");
    assert.match(stale.text(), /Showing the last successful report/);
    assert.equal(stale.all(".usage-limits-widget button").length, 1, "refresh is available outside editing");
  } finally { await stale.dispose(); }
  const editing = await mount(widget({ source: "all", style: "chips" }, null, true));
  try {
    assert.equal(editing.all(".usage-limits-widget button").length, 0);
  } finally { await editing.dispose(); }
});

test("two instances keep independent styles and sources; changing the presentation repaints without refetching", async () => {
  const first = await mount(widget({ source: "all", style: "rings" }));
  const second = await mount(widget({ source: "selected", sources: ["codex"], style: "table" }));
  try {
    assert.equal(first.element.querySelector(".usage-limits-widget")!.getAttribute("data-style"), "rings");
    assert.equal(second.element.querySelector(".usage-limits-widget")!.getAttribute("data-style"), "table");
    assert.equal(first.all(".usage-limits-ring").length, 7);
    assert.equal(second.all("tr").length, 2);

    const before = requests;
    await first.render(widget({ source: "all", style: "hero" }));
    await second.render(widget({ source: "all", style: "segments" }));
    await settle();
    assert.equal(requests, before, "style and source are presentation, not a new request");
    assert.equal(first.all(".usage-limits-hero").length, 1);
    assert.equal(second.all(".usage-limits-meter--segments").length, 6);
  } finally { await first.dispose(); await second.dispose(); }
});

// ---- settings -----------------------------------------------------------------------------------

test("settings list every detected source plus a vanished selection, and toggling writes the whole config", async () => {
  const updates: JsonObject[] = [];
  const config: JsonObject = { source: "selected", sources: ["codex", "gone"], style: "pace", extra: "kept" };
  const settings = await mount(createElement(LimitsWidgetSettings, {
    widgetId: "usage.limits", projectId: null, sessionId: null, editing: true, instanceId: "i",
    config, updateConfig: (next: JsonObject) => { updates.push(next); },
  }));
  try {
    const labels = settings.all(".ui-checkbox-label").map((node) => node.textContent);
    assert.deepEqual(labels.slice(0, 5), ["Claude", "Codex", "OpenCode Go", "Cursor", "Gone"]);
    const inputs = settings.all('.usage-widget-settings fieldset input[type="checkbox"]') as HTMLInputElement[];
    assert.deepEqual(inputs.map((input) => input.checked), [false, true, false, false, true]);
    await act(async () => { inputs[0]!.click(); });
    assert.deepEqual(updates.at(-1), { source: "selected", sources: ["codex", "gone", "claude"], style: "pace", extra: "kept" });
    await act(async () => { inputs[1]!.click(); });
    assert.deepEqual(updates.at(-1)!.sources, ["gone"]);
    const reset = settings.all(".usage-widget-settings > .ui-checkbox input")[0] as HTMLInputElement;
    await act(async () => { reset.click(); });
    assert.equal(updates.at(-1)!.showReset, false);
  } finally { await settings.dispose(); }

  const current = await mount(createElement(LimitsWidgetSettings, {
    widgetId: "usage.limits", projectId: null, sessionId: null, editing: true, instanceId: "i",
    config: {}, updateConfig() {},
  }));
  try {
    assert.equal(current.all("fieldset").length, 0, "a source list only exists for the selected mode");
  } finally { await current.dispose(); }
});

test("a per-Space limits estimate is never persisted, restored or merged into another Space", async () => {
  const fresh = () => import(`../widgets/usage/limitsClient.ts?space=${Math.random()}`) as Promise<typeof import("../widgets/usage/limitsClient.ts")>;
  localStorage.clear();
  const fetchedAt = Date.now();
  const claude = snapshot("claude", [win("s", "Session", 40, 3 * H, 5 * H)]);
  const estimateA = snapshot("alibaba-coding-plan", [win("5h", "5h", 7, H, 5 * H, "requests", 1200)], { scope: "space" });
  const spaceA = { serverInstanceId: "server-1", spaceId: "space-a" };
  const spaceB = { serverInstanceId: "server-1", spaceId: "space-b" };
  const ids = (response: { providers: Array<{ providerId: string }> } | null) => response?.providers.map((provider) => provider.providerId) ?? [];
  // A Space-agnostic snapshot written by the previous version carried the estimate too.
  localStorage.setItem("polyth.usageLimits.1", JSON.stringify({ providers: [claude, estimateA], fetchedAt }));
  let answer: unknown = { ...spaceA, providers: [claude, estimateA], fetchedAt };
  globalThis.fetch = async () => Response.json(answer);
  try {
    const tab = await fresh();
    assert.equal(localStorage.getItem("polyth.usageLimits.1"), null, "the unscoped legacy snapshot is discarded");
    assert.deepEqual(ids(tab.cachedUsageLimits()), [], "nothing from the legacy snapshot is restored");

    assert.deepEqual(ids(await tab.loadUsageLimits()), ["claude", "alibaba-coding-plan"], "Space A sees its own estimate");
    assert.deepEqual(ids(JSON.parse(localStorage.getItem("polyth.usageLimits.2")!)), ["claude"], "the estimate is never persisted");
    assert.deepEqual(ids(tab.cachedUsageLimits()), ["claude"], "nor painted before the Space is confirmed");

    // The tab moved to Space B: a one-source refresh must not carry Space A's estimate.
    answer = { ...spaceB, providers: [claude], fetchedAt };
    assert.deepEqual(ids(await tab.refreshUsageLimitSource("claude")), ["claude"]);

    // Back in Space A, its estimate merges into a refresh from the same Space only.
    answer = { ...spaceA, providers: [claude, estimateA], fetchedAt };
    await tab.loadUsageLimits();
    answer = { ...spaceA, providers: [claude], fetchedAt };
    assert.deepEqual(ids(await tab.refreshUsageLimitSource("claude")), ["claude", "alibaba-coding-plan"]);
    answer = { providers: [claude], fetchedAt };
    assert.deepEqual(ids(await tab.refreshUsageLimitSource("claude")), ["claude"], "a response naming no Space keeps none");
    answer = { providers: [estimateA], fetchedAt };
    assert.deepEqual(ids(await tab.refreshUsageLimitSource("alibaba-coding-plan")), ["claude"], "an unattributed estimate is dropped");

    // A reload into Space B paints only host-wide sources while it revalidates.
    answer = { ...spaceA, providers: [claude, estimateA], fetchedAt };
    await tab.loadUsageLimits();
    globalThis.fetch = async () => new Promise<Response>(() => undefined);
    const reloaded = await fresh();
    const seen: string[][] = [];
    function Probe() {
      seen.push(reloaded.useUsageLimits().providers.map((provider) => provider.providerId));
      return null;
    }
    const element = document.createElement("div");
    document.body.appendChild(element);
    const root = createRoot(element);
    try {
      await act(async () => root.render(createElement(Probe)));
      assert.deepEqual(seen[0], ["claude"]);
    } finally {
      await act(async () => root.unmount());
      element.remove();
    }
  } finally {
    localStorage.clear();
  }
});

test("the last limits snapshot persists across a reload and paints before the first answer", async () => {
  const fresh = () => import(`../widgets/usage/limitsClient.ts?tab=${Math.random()}`) as Promise<typeof import("../widgets/usage/limitsClient.ts")>;
  localStorage.clear();
  const fetchedAt = Date.now();
  globalThis.fetch = async () => Response.json({ providers: [snapshot("claude", [win("s", "Session", 40, 3 * H, 5 * H)])], fetchedAt });
  try {
    const firstTab = await fresh();
    await firstTab.prefetchUsageLimits();
    assert.ok(localStorage.getItem("polyth.usageLimits.2"), "the snapshot is persisted");

    let answered = false;
    globalThis.fetch = async () => { answered = true; return new Promise<Response>(() => undefined); };
    const secondTab = await fresh();
    const seen: Array<{ loading: boolean; providers: unknown[] }> = [];
    function Probe() {
      const limits = secondTab.useUsageLimits();
      seen.push({ loading: limits.loading, providers: limits.providers });
      return null;
    }
    const element = document.createElement("div");
    document.body.appendChild(element);
    const root = createRoot(element);
    try {
      await act(async () => root.render(createElement(Probe)));
      assert.equal(seen[0]!.loading, false, "a reload does not start from a blank loading state");
      assert.equal(seen[0]!.providers.length, 1);
      assert.ok(answered, "while the mount still revalidates");
    } finally {
      await act(async () => root.unmount());
      element.remove();
    }

    // A day-old snapshot is not worth painting.
    localStorage.setItem("polyth.usageLimits.2", JSON.stringify({ providers: [snapshot("claude", [win("s", "Session", 40, 3 * H, 5 * H)])], fetchedAt: Date.now() - 2 * 86_400_000 }));
    const thirdTab = await fresh();
    const stale: boolean[] = [];
    function StaleProbe() { stale.push(thirdTab.useUsageLimits().loading); return null; }
    const staleElement = document.createElement("div");
    document.body.appendChild(staleElement);
    const staleRoot = createRoot(staleElement);
    try {
      await act(async () => staleRoot.render(createElement(StaleProbe)));
      assert.equal(stale[0], true);
    } finally {
      await act(async () => staleRoot.unmount());
      staleElement.remove();
    }
  } finally {
    localStorage.clear();
  }
});

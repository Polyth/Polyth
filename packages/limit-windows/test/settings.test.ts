// The settings page against a fake server: what an account shows, that a control
// saves the whole plan, and that a person only sees what they may do.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  StorageEvent: dom.StorageEvent,
  MutationObserver: dom.MutationObserver,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  getComputedStyle: dom.getComputedStyle,
  localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (at: number) => void) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
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
const { default: LimitWindowsSettings, nextSentence } = await import("../widgets/LimitWindowsSettings.tsx");
const { createCopy } = await import("../widgets/copy.ts");
type State = import("../src/types.ts").LimitWindowsState;
type Source = import("../src/types.ts").SourceView;
type Meter = import("../src/types.ts").MeterView;

const HOUR = 60 * 60_000;
const NOW = Date.parse("2026-11-05T02:00:00Z");

const meter = (patch: Partial<Meter> = {}): Meter => ({
  id: "all",
  windows: [{ id: "5h", label: "5h", phase: "idle", used: 0, periodMs: 5 * HOUR }],
  primaryId: "5h",
  planned: [],
  options: [{ providerID: "anthropic", modelID: "haiku", name: "Haiku" }, { providerID: "anthropic", modelID: "opus", name: "Opus" }],
  model: { providerID: "anthropic", modelID: "haiku", name: "Haiku" },
  history: [],
  busy: false,
  ...patch,
});

const account = (patch: Partial<Source> = {}): Source => ({
  id: "claude",
  title: "Claude",
  harnessId: "claude",
  private: false,
  access: "edit",
  plan: { mode: "off", times: ["09:00"], days: [], lead: 1, rolling: false, timeZone: "UTC" },
  saved: false,
  fetchedAt: NOW,
  stale: false,
  meters: [meter()],
  ...patch,
});

interface Call { method: string; path: string; body?: unknown }

function serve(state: State, answers: { start?: { status: number; body: unknown } } = {}) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (method === "GET") return reply(200, state);
    if (method === "PUT") return reply(200, { ...state.sources[0], plan: body });
    return answers.start ? reply(answers.start.status, answers.start.body) : reply(200, { record: {} });
  }) as typeof fetch;
  return calls;
}

async function mount(t: test.TestContext) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(LimitWindowsSettings)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  t.after(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });
  return container;
}

const buttons = (container: Element): HTMLButtonElement[] => [...container.querySelectorAll("button")] as unknown as HTMLButtonElement[];
const buttonNamed = (container: Element, name: string): HTMLButtonElement | undefined =>
  buttons(container).find((button) => button.textContent?.trim() === name);
const click = async (button: HTMLButtonElement | undefined) => {
  assert.ok(button, "button exists");
  await act(async () => { button!.click(); });
};
const settle = async (ms = 0) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
const has = (container: Element, text: string): boolean => (container.textContent ?? "").includes(text);

const copy = createCopy("en");

test("without an account with time windows the page says so", async (t) => {
  serve({ available: true, now: NOW, sources: [] });
  const container = await mount(t);
  assert.equal(has(container, copy.emptyTitle), true);
});

test("a deployment without host logins says so", async (t) => {
  serve({ available: false, now: NOW, sources: [] });
  const container = await mount(t);
  assert.equal(has(container, copy.unavailableTitle), true);
});

test("each account is one line with its plan, every one of them", async (t) => {
  serve({
    available: true,
    now: NOW,
    sources: [
      account(),
      account({ id: "claude-work", title: "Claude · Work", plan: { mode: "hour", times: ["09:00"], days: [], lead: 1, rolling: false, timeZone: "UTC" }, meters: [meter({ next: { at: Date.parse("2026-11-05T04:00:45Z"), reason: "lead", targetAt: Date.parse("2026-11-05T09:00:00Z") } })] }),
      account({ id: "codex", title: "Codex", plan: { mode: "reset", times: [], days: [], lead: 0, rolling: false, timeZone: "UTC" } }),
    ],
  });
  const container = await mount(t);
  const heads = [...container.querySelectorAll(".settings-disclosure-head")].map((head) => head.textContent ?? "");
  assert.equal(heads.length, 3);
  assert.ok(heads[0]!.includes("Claude") && heads[0]!.includes(copy.off));
  assert.ok(heads[1]!.includes("Claude · Work") && heads[1]!.includes("At 09:00"));
  assert.ok(heads[2]!.includes("Codex") && heads[2]!.includes(copy.summaryReset));
});

test("opening an account shows what happens next and draws it", async (t) => {
  const planned = [
    { from: Date.parse("2026-11-05T04:00:45Z"), to: Date.parse("2026-11-05T09:00:45Z"), reason: "lead" as const, targetAt: Date.parse("2026-11-05T09:00:00Z") },
    { from: Date.parse("2026-11-05T09:00:50Z"), to: Date.parse("2026-11-05T14:00:50Z"), reason: "hour" as const, targetAt: Date.parse("2026-11-05T09:00:00Z") },
  ];
  serve({
    available: true,
    now: NOW,
    sources: [account({
      plan: { mode: "hour", times: ["09:00"], days: [], lead: 1, rolling: false, timeZone: "UTC" },
      meters: [meter({ planned, next: { at: planned[0]!.from, reason: "lead", targetAt: planned[0]!.targetAt } })],
    })],
  });
  const container = await mount(t);
  await click(buttons(container).find((button) => button.classList.contains("settings-disclosure-head")));
  const sentence = container.querySelector(".limit-windows-next")?.textContent ?? "";
  assert.ok(/Its window ends at \d\d:\d\d/.test(sentence), sentence);
  const strip = container.querySelector(".limit-windows-strip");
  assert.ok(strip?.getAttribute("aria-label")?.includes("Planned starts"));
  assert.equal(container.querySelectorAll('.limit-windows-strip-window[data-kind="planned"]').length, 2);
  assert.equal(container.querySelectorAll(".limit-windows-strip-hour").length, 1);
});

test("a control saves the whole plan, in this device's time zone", async (t) => {
  const calls = serve({ available: true, now: NOW, sources: [account()] });
  const container = await mount(t);
  await click(buttons(container).find((button) => button.classList.contains("settings-disclosure-head")));
  await click(buttonNamed(container, copy.modeHour));
  // The controls of the mode appear at once, before the save has landed.
  assert.equal(has(container, copy.hours), true);
  await click(buttonNamed(container, copy.dayNames[1]!));
  await settle(600);
  const puts = calls.filter((call) => call.method === "PUT");
  assert.equal(puts.length, 1, "edits close together are one save");
  assert.equal(puts[0]!.path, "/api/limit-windows/plans/claude");
  const body = puts[0]!.body as Record<string, unknown>;
  assert.equal(body.mode, "hour");
  assert.deepEqual(body.times, ["09:00"]);
  assert.deepEqual(body.days, [1]);
  assert.equal(typeof body.timeZone, "string");
});

test("Start now is offered only on a window that can start", async (t) => {
  const running = meter({
    windows: [{ id: "5h", label: "5h", phase: "running", used: 0.1, periodMs: 5 * HOUR, resetsAt: NOW + HOUR }],
    running: { from: NOW - 4 * HOUR, to: NOW + HOUR },
  });
  serve({ available: true, now: NOW, sources: [account({ meters: [running] })] });
  const container = await mount(t);
  await click(buttons(container).find((button) => button.classList.contains("settings-disclosure-head")));
  assert.equal(buttonNamed(container, copy.startNow)?.disabled, true);
});

test("Start now is not offered on a used-up window, which would be refused", async (t) => {
  serve({ available: true, now: NOW, sources: [account({ meters: [meter({ hold: "exhausted", holdUntil: NOW + HOUR })] })] });
  const container = await mount(t);
  await click(buttons(container).find((button) => button.classList.contains("settings-disclosure-head")));
  assert.equal(buttonNamed(container, copy.startNow)?.disabled, true);
});

test("Start now reports why the server refused", async (t) => {
  const calls = serve({ available: true, now: NOW, sources: [account()] }, { start: { status: 409, body: { error: "exhausted", message: "x" } } });
  const container = await mount(t);
  await click(buttons(container).find((button) => button.classList.contains("settings-disclosure-head")));
  await click(buttonNamed(container, copy.startNow));
  await settle();
  const posts = calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.path, "/api/limit-windows/plans/claude/start");
  assert.deepEqual(posts[0]!.body, { meterId: "all" });
  assert.equal(container.querySelector(".limit-windows-failure")?.textContent, copy.startExhausted);
});

test("someone who may only read gets no live control", async (t) => {
  serve({ available: true, now: NOW, sources: [account({ access: "view", plan: { mode: "hour", times: ["09:00"], days: [], lead: 1, rolling: false, timeZone: "UTC" } })] });
  const container = await mount(t);
  await click(buttons(container).find((button) => button.classList.contains("settings-disclosure-head")));
  assert.equal(has(container, copy.viewOnly), true);
  assert.equal(buttonNamed(container, copy.startNow), undefined);
  assert.equal(buttonNamed(container, copy.modeHour)?.disabled, true);
  assert.equal((container.querySelector('input[type="time"]') as HTMLInputElement | null)?.disabled, true);
});

test("an account with two model groups shows both and can leave one out", async (t) => {
  const calls = serve({
    available: true,
    now: NOW,
    sources: [account({
      id: "antigravity",
      title: "Antigravity",
      plan: { mode: "reset", times: [], days: [], lead: 0, rolling: false, timeZone: "UTC" },
      meters: [
        meter({ id: "google", label: "Google models", windows: [{ id: "google-5h", label: "5h", phase: "idle", used: 0, periodMs: 5 * HOUR }], primaryId: "google-5h" }),
        meter({ id: "third-party", label: "Third-party models", windows: [{ id: "third-party-5h", label: "5h", phase: "idle", used: 0, periodMs: 5 * HOUR }], primaryId: "third-party-5h", hold: "exhausted", holdUntil: NOW + 100 * HOUR }),
      ],
    })],
  });
  const container = await mount(t);
  await click(buttons(container).find((button) => button.classList.contains("settings-disclosure-head")));
  assert.equal(container.querySelectorAll(".limit-windows-strip").length, 2);
  assert.equal(has(container, "Third-party models"), true);
  const sentences = [...container.querySelectorAll(".limit-windows-next")].map((node) => node.getAttribute("data-attention"));
  assert.deepEqual(sentences, [null, "true"]);
  const toggle = container.querySelector('.limit-windows-meter-toggles [role="switch"], .limit-windows-meter-toggles input') as HTMLElement | null;
  assert.ok(toggle);
  await act(async () => { toggle!.click(); });
  await settle(600);
  const put = calls.find((call) => call.method === "PUT");
  assert.deepEqual((put?.body as { skipMeters?: string[] }).skipMeters, ["google"]);
});

test("the next-step sentence names every hold", () => {
  const moments = { now: NOW, locale: "en", timeZone: "UTC" };
  const at = NOW + HOUR;
  assert.ok(nextSentence(meter({ hold: "exhausted", holdUntil: at }), copy, moments).includes("used up"));
  assert.ok(nextSentence(meter({ hold: "failing", holdUntil: at }), copy, moments).includes("failed"));
  assert.ok(nextSentence(meter({ hold: "no-effect", holdUntil: at }), copy, moments).includes("didn't start"));
  assert.ok(nextSentence(meter({ hold: "budget", holdUntil: at }), copy, moments).includes("24 hours"));
  assert.equal(nextSentence(meter({ problem: "no-route" }), copy, moments), copy.noRoute);
  assert.equal(nextSentence(meter({ problem: "no-model" }), copy, moments), copy.noModel);
  assert.equal(nextSentence(meter(), copy, moments), copy.noNext);
});

test("Ukrainian copy is complete and other languages read English", () => {
  const uk = createCopy("uk-UA");
  assert.equal(createCopy("de"), copy);
  assert.deepEqual(Object.keys(uk).sort(), Object.keys(copy).sort());
  assert.notEqual(uk.page, copy.page);
});

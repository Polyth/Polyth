// A Relay's accounts live in the Relay's card: their own cards leave the
// Limits list unless the person asks for them, and an opened queue row shows
// the account's windows.
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
  Element: dom.Element, Node: dom.Node,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = originalFetch;
  await dom.happyDOM.close();
});

const now = Date.now();
const window5h = (remaining: number) => ({
  id: "5h", label: "5h", used: Math.round((1 - remaining) * 100), limit: 100, unit: "percent",
  resetsAt: now + 3_600_000, periodMs: 5 * 3_600_000,
});
const source = (providerId: string, label?: string, remaining = 1) => ({
  providerId, fetchedAt: now, stale: false, balances: [], pace: {}, windows: [window5h(remaining)],
  ...(label ? { account: { family: "claude", harnessId: providerId, label }, accountLabel: label } : {}),
});
const providers = [source("claude", undefined, 0.62), source("claude-iryna", "Iryna"), source("codex")];
const relays = [{
  id: "claude-relay", family: "claude", label: "Claude Code",
  members: [
    { harnessId: "claude", name: "Claude Code", included: true, position: 1, state: "now", tightest: { label: "5h", remaining: 0.62 } },
    { harnessId: "claude-iryna", name: "Claude Code · Iryna", included: true, position: 2, state: "next", tightest: { label: "5h", remaining: 1 } },
  ],
}];

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LimitsView } = await import("../widgets/usage/LimitsView.tsx");
const {
  DEFAULT_USAGE_LIMITS_PREFS,
  getUsageLimitsPrefs,
  replaceUsageLimitsPrefs,
} = await import("../widgets/usage/limitsPrefs.ts");

beforeEach(() => {
  replaceUsageLimitsPrefs(DEFAULT_USAGE_LIMITS_PREFS);
  dom.localStorage.clear();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/usage/limits")) return Response.json({ fetchedAt: now, providers });
    if (url.includes("/api/harness-relay/relays")) return Response.json({ relays });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(LimitsView)); });
  for (let i = 0; i < 100 && !(container.querySelector("[data-testid=relay-pool]") && container.querySelector("[data-source-id]")); i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  const cards = () => [...container.querySelectorAll<HTMLElement>("[data-source-id]")].map((card) => card.dataset.sourceId);
  return {
    container,
    cards,
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("by default a Relay's accounts show only inside its card", async () => {
  assert.equal(getUsageLimitsPrefs().showRelayMembers, false);
  const view = await mount();
  try {
    assert.deepEqual(view.cards(), ["codex"]);
    const rows = [...view.container.querySelectorAll<HTMLElement>("[data-testid=relay-pool] [data-member]")];
    assert.deepEqual(rows.map((row) => row.dataset.member), ["claude", "claude-iryna"]);
  } finally {
    await view.unmount();
  }
});

test("the Settings choice brings the accounts' own cards back", async () => {
  replaceUsageLimitsPrefs({ ...DEFAULT_USAGE_LIMITS_PREFS, showRelayMembers: true });
  const view = await mount();
  try {
    assert.deepEqual(view.cards(), ["claude", "claude-iryna", "codex"]);
  } finally {
    await view.unmount();
  }
});

test("opening a queue row shows that account's windows and closing it hides them", async () => {
  const view = await mount();
  try {
    const button = view.container.querySelector<HTMLButtonElement>("[data-member='claude'] button")!;
    assert.equal(button.getAttribute("aria-expanded"), "false");
    await act(async () => { button.click(); });
    assert.equal(button.getAttribute("aria-expanded"), "true");
    const detail = view.container.querySelector<HTMLElement>(`#${button.getAttribute("aria-controls")}`);
    assert.ok(detail);
    assert.equal(detail!.querySelectorAll(".usage-limit-window").length, 1);
    assert.match(detail!.textContent ?? "", /62% left/);
    await act(async () => { button.click(); });
    assert.equal(view.container.querySelector("[data-member='claude'] .usage-relay-member-detail"), null);
  } finally {
    await view.unmount();
  }
});

test("the preference is kept only as a real boolean", () => {
  replaceUsageLimitsPrefs({ ...DEFAULT_USAGE_LIMITS_PREFS, showRelayMembers: "yes" });
  assert.equal(getUsageLimitsPrefs().showRelayMembers, false);
  replaceUsageLimitsPrefs({ ...DEFAULT_USAGE_LIMITS_PREFS, showRelayMembers: true });
  assert.equal(getUsageLimitsPrefs().showRelayMembers, true);
});

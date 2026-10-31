// The Limits page reuses the navigator's direct-manipulation engine: panels
// lift, glide and are saved once on landing, and hidden panels keep their slot.
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
const provider = (providerId: string) => ({
  providerId, fetchedAt: now, stale: false, windows: [], balances: [], pace: {},
});
const providers = ["claude", "codex", "opencode-go", "cursor"].map(provider);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LimitsView } = await import("../widgets/usage/LimitsView.tsx");
const model = await import("../widgets/usage/limitsModel.ts");
const {
  DEFAULT_USAGE_LIMITS_PREFS,
  getUsageLimitsPrefs,
  replaceUsageLimitsPrefs,
} = await import("../widgets/usage/limitsPrefs.ts");

beforeEach(() => {
  replaceUsageLimitsPrefs(DEFAULT_USAGE_LIMITS_PREFS);
  dom.localStorage.clear();
});

test("a user order wins while unnamed sources keep their family grouping", () => {
  const ids = (order?: string[]) => model.orderLimitSources(providers, order).map((entry) => entry.providerId);
  assert.deepEqual(ids(), ["claude", "codex", "opencode-go", "cursor"]);
  assert.deepEqual(ids(["cursor", "claude"]), ["cursor", "claude", "codex", "opencode-go"]);
  // A new, unnamed source still lands beside its family, not at the very end.
  const withAccount = [...providers, { ...provider("claude-work"), account: { family: "claude", harnessId: "claude", label: "Work" } }];
  assert.deepEqual(
    model.orderLimitSources(withAccount, ["cursor", "codex"]).map((entry) => entry.providerId),
    ["cursor", "codex", "claude", "claude-work", "opencode-go"],
  );
});

test("a visible move leaves hidden panels in their saved slots", () => {
  const full = ["claude", "codex", "opencode-go", "cursor"];
  // codex is hidden, so only the other three can move.
  assert.deepEqual(
    model.mergeLimitSourceOrder(full, ["claude", "opencode-go", "cursor"], ["cursor", "claude", "opencode-go"]),
    ["cursor", "codex", "claude", "opencode-go"],
  );
});

test("the saved order is normalized like every other source preference", () => {
  replaceUsageLimitsPrefs({
    ...DEFAULT_USAGE_LIMITS_PREFS,
    sourceOrder: [" Cursor ", "claude", "CURSOR", 4, "", "codex"],
  });
  assert.deepEqual(getUsageLimitsPrefs().sourceOrder, ["cursor", "claude", "codex"]);
});

test("keyboard reordering from the focused panel saves the order once and announces it", async () => {
  globalThis.fetch = (async () => Response.json({ fetchedAt: now, providers })) as typeof fetch;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const order = () => [...container.querySelectorAll<HTMLElement>("[data-source-id]")]
    .map((panel) => panel.dataset.sourceId);
  try {
    await act(async () => { root.render(createElement(LimitsView)); });
    for (let i = 0; i < 100 && order().length < providers.length; i++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    assert.deepEqual(order(), ["claude", "codex", "opencode-go", "cursor"]);

    // No grip: the panel itself takes focus and moves with the navigator's
    // project shortcut.
    const panel = container.querySelector<HTMLElement>("[data-source-id='claude']")!;
    await act(async () => {
      panel.dispatchEvent(new dom.KeyboardEvent("keydown", {
        key: "ArrowDown", altKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }) as unknown as Event);
    });

    assert.deepEqual(order(), ["codex", "claude", "opencode-go", "cursor"]);
    assert.deepEqual(getUsageLimitsPrefs().sourceOrder, ["codex", "claude", "opencode-go", "cursor"]);
    assert.match(container.querySelector("[aria-live]")?.textContent ?? "", /moved to position 2 of 4/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

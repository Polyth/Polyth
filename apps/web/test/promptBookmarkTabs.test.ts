// Package tabs in the chat's bookmark popover: nothing changes without one, a
// tab with content takes over the popover's head and fills the icon, and the
// last tab used stays chosen on this device.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

globalThis.fetch = (async () => new Response(JSON.stringify({
  prompts: [{ id: "p1", seq: 1, preview: "First prompt" }],
  beforeSeq: null,
}), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerSlot } = await import("../src/slots.ts");
const { default: PromptBookmark } = await import("../src/components/PromptBookmark.tsx");

let filled = new Set<string>();
const listeners = new Set<() => void>();
const setContent = (sessionIds: string[]) => { filled = new Set(sessionIds); for (const listener of listeners) listener(); };
const placements: unknown[] = [];

const registerTab = () => registerSlot("session.prompt.tabs", "test.saved", (context) => {
  placements.push(context.promptTabPlacement);
  return createElement("div", { "data-test-tab": String(context.promptTabPlacement) }, `saved for ${String(context.sessionId)}`);
}, 10, {
  promptTab: {
    label: () => "Saved",
    hasContent: (sessionId: string) => filled.has(sessionId),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  },
});

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PromptBookmark, {
      sessionId: "s1",
      revision: "r1",
      prompt: { id: "p1", preview: "First prompt", seq: 1 },
      onJump: async () => {},
      onCancelJump: () => {},
    }));
  });
  const toggle = () => container.querySelector<HTMLButtonElement>(".prompt-bookmark-toggle")!;
  return {
    container,
    toggle,
    open: async () => {
      await act(async () => { toggle().click(); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    },
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

const tabNames = () => [...document.querySelectorAll<HTMLElement>(".prompt-bookmark-tabs [role=tab]")].map((tab) => tab.textContent);
const heading = () => document.querySelector(".prompt-bookmark-heading")?.textContent ?? null;
const promptRows = () => document.querySelectorAll(".prompt-bookmark-peek .prompt-nav-row").length;

test("without a contribution the popover is the plain prompt list", async () => {
  localStorage.clear();
  const view = await mount();
  try {
    assert.equal(view.container.querySelector("[data-filled]") === null, true);
    await view.open();
    assert.deepEqual(tabNames(), []);
    assert.equal(heading(), "Prompt navigation");
    assert.equal(promptRows(), 1);
    assert.equal(document.querySelector("[data-test-tab]") === null, true);
  } finally {
    await view.unmount();
  }
});

test("before there is content a tab only adds its footer under the list", async () => {
  localStorage.clear();
  setContent([]);
  const off = registerTab();
  const view = await mount();
  try {
    await view.open();
    assert.deepEqual(tabNames(), []);
    assert.equal(heading(), "Prompt navigation");
    assert.equal(promptRows(), 1);
    assert.equal(document.querySelector('[data-test-tab="footer"]') === null, false);
    assert.equal(view.container.querySelector("[data-filled]") === null, true);
  } finally {
    await view.unmount();
    off();
  }
});

test("content brings the tabs and the filled icon, and the choice is remembered", async () => {
  localStorage.clear();
  setContent(["s1"]);
  const off = registerTab();
  const view = await mount();
  try {
    assert.equal(view.container.querySelector("[data-filled]") === null, false);
    assert.match(view.toggle().getAttribute("aria-label") ?? "", /^Saved, Prompt navigation$/);
    await view.open();
    assert.deepEqual(tabNames(), ["Saved", "Prompts"]);
    assert.equal(heading(), null);
    assert.equal(document.querySelector('[data-test-tab="tab"]')?.textContent, "saved for s1");
    assert.equal(document.querySelector('[data-test-tab="footer"]') === null, true);

    const promptsTab = [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((tab) => tab.textContent === "Prompts")!;
    await act(async () => { promptsTab.click(); });
    assert.equal(promptRows(), 1);
    assert.equal(document.querySelector("[data-test-tab]") === null, true);
    assert.equal(localStorage.getItem("polyth.promptBookmark.tab.v1"), "prompts");
  } finally {
    await view.unmount();
  }
  const again = await mount();
  try {
    await again.open();
    assert.equal(document.querySelector(".prompt-bookmark-tabs [aria-selected='true']")?.textContent, "Prompts");
  } finally {
    await again.unmount();
    off();
  }
});

test("content for another chat changes nothing here; content arriving updates it live", async () => {
  localStorage.clear();
  setContent(["other"]);
  const off = registerTab();
  const view = await mount();
  try {
    assert.equal(view.container.querySelector("[data-filled]") === null, true);
    await act(async () => { setContent(["s1"]); });
    assert.equal(view.container.querySelector("[data-filled]") === null, false);
  } finally {
    await view.unmount();
    off();
  }
});

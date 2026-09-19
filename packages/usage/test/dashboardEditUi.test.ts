// Edit-mode dashboard blocks: outside edit mode hidden blocks are absent and
// items are not draggable; in edit mode hidden blocks reappear with show/hide
// eye toggles backed by the persisted prefs store.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SortableBlocks } = await import("../widgets/usage/UsageDashboard.tsx");
const { getUsagePrefs, setBlockHidden, parseUsagePrefs, USAGE_PREFS_KEY } = await import("../widgets/usagePrefs.ts");

const block = (id: string, hidden = false) => ({ id, label: id, hidden, content: null });

async function mount(blocks: ReturnType<typeof block>[], editing: boolean) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (next: ReturnType<typeof block>[]) => {
    root.render(createElement(SortableBlocks, {
      className: "usage-overview-blocks",
      blocks: next,
      order: [],
      editing,
      onChange: () => {},
      onHiddenChange: (id: string, hidden: boolean) => setBlockHidden(id, hidden),
    }));
  };
  await act(async () => {
    render(blocks);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    // SortableBlocks is a controlled view: the dashboard re-renders it from
    // persisted prefs, so the test must mirror that after a visibility toggle.
    async rerender(next: ReturnType<typeof block>[]) {
      await act(async () => {
        render(next);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    async close() { root.unmount(); container.remove(); },
  };
}

const named = (container: ParentNode, label: string) =>
  [...container.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === label);

test("outside edit mode blocks are not draggable and hidden blocks are absent", async () => {
  dom.localStorage.clear();
  const { container, close } = await mount([block("spend"), block("tokens"), block("cache", true)], false);
  try {
    const items = [...container.querySelectorAll("[data-usage-block]")];
    assert.deepEqual(items.map((item) => item.getAttribute("data-usage-block")), ["spend", "tokens"]);
    for (const item of items) assert.equal(item.getAttribute("draggable"), "false");
    assert.equal(container.querySelector(".usage-block-edit-bar"), null);
  } finally { await close(); }
});

test("edit mode reveals hidden blocks and the eye toggles persisted visibility", async () => {
  dom.localStorage.clear();
  const blocks = [block("spend"), block("tokens"), block("cache", true)];
  const mounted = await mount(blocks, true);
  try {
    const items = [...mounted.container.querySelectorAll("[data-usage-block]")];
    assert.deepEqual(items.map((item) => item.getAttribute("data-usage-block")), ["spend", "tokens", "cache"]);
    assert.ok(mounted.container.querySelector(".usage-block-grip"));
    for (const item of items) assert.equal(item.getAttribute("draggable"), "true");
    assert.ok(items[2]!.classList.contains("usage-block-hidden"));
    const hide = named(mounted.container, "Hide spend in breakdowns");
    assert.ok(hide);
    await act(async () => hide!.click());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(getUsagePrefs().hiddenBlocks, ["spend"]);
    assert.ok(parseUsagePrefs(dom.localStorage.getItem(USAGE_PREFS_KEY)).hiddenBlocks.includes("spend"));
    await mounted.rerender(blocks.map((item) => item.id === "spend" ? { ...item, hidden: true } : item));
    const show = named(mounted.container, "Show spend in breakdowns");
    assert.ok(show);
    await act(async () => show!.click());
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(getUsagePrefs().hiddenBlocks, []);
  } finally { await mounted.close(); }
});

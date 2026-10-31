// Regression guard for model picker stabilization: no Manage/Auto tabs in the
// harness header, catalog never swaps for in-overlay details, adjacent panel.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ModelDescriptor } from "@polyth/contracts";

const dom = new Window();
let phoneMode = false;
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    get matches() { return phoneMode && query.includes("480px"); },
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("pending catalog discovery shows loading instead of an authoritative empty state", async () => {
  phoneMode = true;
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, { models: [], catalogLoading: true, onPick: () => {} }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    assert.match(document.body.querySelector(".palette-empty")?.textContent ?? "", /loading/i);
    assert.doesNotMatch(document.body.textContent ?? "", /no models found/i);
  } finally {
    phoneMode = false;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("the model trigger keeps the selected model name visible and accessible", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, {
        models: [{ harnessId: "codex", providerID: "openai", modelID: "luna", name: "Luna" }],
        harnessId: "codex",
        recommended: { providerID: "openai", modelID: "luna" },
        onPick: () => {},
      }));
    });
    const trigger = container.querySelector<HTMLButtonElement>(".model-picker-trigger");
    assert.equal(trigger?.querySelector(".model-trigger-name")?.textContent, "Luna");
    assert.match(trigger?.getAttribute("aria-label") ?? "", /Luna/);
    await act(async () => { trigger?.click(); });
    assert.match(document.body.querySelector(".model-picker-row")?.textContent ?? "", /Luna/);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("native catalog updates preserve Luna, flat rows, and the existing picker surface", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const luna = { harnessId: "codex", providerID: "openai", modelID: "luna", name: "Luna" };
  const astra = { ...luna, modelID: "astra", name: "Astra" };
  const selected = { providerID: "openai", modelID: "luna" };
  const render = async (models: ModelDescriptor[], harnessId = "codex") => act(async () => {
    root.render(createElement(ModelPicker, { models, harnessId, recommended: selected, onPick: () => {} }));
  });
  try {
    await render([]);
    assert.equal(container.querySelector(".model-trigger-name")?.textContent, "luna", "pending metadata keeps the selected identity");
    await render([astra, luna]);
    assert.equal(container.querySelector(".model-trigger-name")?.textContent, "Luna");
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    const shell = document.body.querySelector(".model-pop");
    assert.equal(shell?.className.includes("model-pop--compact"), false, "short native catalogs use the shared picker height");
    assert.equal(document.body.querySelectorAll(".model-picker-row").length, 2);
    assert.equal(document.body.querySelector(".model-provider-head"), null);
    assert.equal(document.body.querySelector(".model-star-btn"), null);
    assert.equal(document.body.querySelector(".model-picker-row.current")?.textContent?.includes("Luna"), true);
    await render([astra]);
    assert.equal(container.querySelector(".model-trigger-name")?.textContent, "luna", "a partial catalog never selects Astra");
    await render([{ harnessId: "claude", providerID: "anthropic", modelID: "sonnet", name: "Sonnet" }], "claude");
    assert.equal(document.body.querySelector(".model-pop"), shell, "harness changes update the same open surface");
    assert.equal(document.body.querySelector(".model-provider-head"), null);
    assert.equal(document.body.querySelector(".model-star-btn"), null);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("OpenCode settings default matches qualified models and disconnected rows are absent", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, {
        harnessId: "opencode",
        models: [
          { harnessId: "opencode", providerID: "openai", modelID: "first", name: "First", connected: true },
          { harnessId: "opencode", providerID: "openai", modelID: "chosen", name: "Settings choice", connected: true },
          { harnessId: "opencode", providerID: "unconfigured", modelID: "hidden", name: "Unconfigured", connected: false },
        ],
        recommended: { providerID: "openai", modelID: "chosen" },
        onPick: () => {},
      }));
    });
    assert.equal(container.querySelector(".model-trigger-name")?.textContent, "Settings choice");
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    assert.doesNotMatch(document.body.querySelector(".model-picker-shell")?.textContent ?? "", /Unconfigured/);
    assert.equal(document.body.querySelectorAll(".model-picker-row").length, 2);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("stable anchoring ignores composer layout movement and still clamps after viewport resize", async () => {
  const { act, createElement, useRef } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useAnchoredPosition } = await import("../src/components/ui/useAnchoredPosition.ts");
  let left = 200;
  let stable = true;
  let position: { left: number; top: number; ready: boolean } | undefined;
  const anchor = { getBoundingClientRect: () => ({ left, right: left + 100, top: 400, bottom: 430, width: 100, height: 30 }) } as HTMLElement;
  const surface = { getBoundingClientRect: () => ({ width: 360, height: 300 }) } as HTMLElement;
  function Harness() {
    position = useAnchoredPosition(true, useRef(anchor), useRef(surface), { side: "up", stableAnchor: stable });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalWidth = window.innerWidth;
  try {
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(position?.left, 200);
    left = 80;
    await act(async () => { window.dispatchEvent(new window.Event("scroll")); });
    assert.equal(position?.left, 200, "a new model label cannot move the open picker");
    Object.defineProperty(window, "innerWidth", { value: 420, configurable: true });
    await act(async () => { window.dispatchEvent(new window.Event("resize")); });
    assert.equal(position?.left, 52, "viewport changes still enforce collision bounds");
    Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
    stable = false;
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(position?.left, 80, "ordinary popovers retain live anchor tracking");
  } finally {
    Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("compact stable anchoring follows visual viewport changes but ignores catalog reflow", async () => {
  const { act, createElement, useRef } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useAnchoredPosition } = await import("../src/components/ui/useAnchoredPosition.ts");
  let left = 120;
  let position: { left: number; ready: boolean } | undefined;
  const anchor = { getBoundingClientRect: () => ({ left, right: left + 40, top: 100, bottom: 140, width: 40, height: 40 }) } as HTMLElement;
  const surface = { getBoundingClientRect: () => ({ width: 200, height: 240 }) } as HTMLElement;
  function Harness() {
    position = useAnchoredPosition(true, useRef(anchor), useRef(surface), {
      side: "down",
      stableAnchor: true,
      compact: true,
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  try {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(position?.left, 120);

    left = 40;
    await act(async () => { window.dispatchEvent(new window.Event("scroll")); });
    assert.equal(position?.left, 120, "catalog/layout changes do not move an open picker");

    await act(async () => { window.visualViewport?.dispatchEvent(new window.Event("scroll")); });
    assert.equal(position?.left, 120, "Safari visual-viewport pans must not retarget harness tabs");

    await act(async () => {
      window.dispatchEvent(new window.Event("pointerdown"));
      window.dispatchEvent(new window.Event("resize"));
    });
    assert.equal(position?.left, 120, "an in-flight press keeps the picker still");
    await act(async () => { window.dispatchEvent(new window.Event("pointerup")); });
    assert.equal(position?.left, 40, "keyboard re-anchor flushes after the press");

    const { setNativeKeyboardInset } = await import("../src/mobileViewport.ts");
    left = 80;
    await act(async () => { setNativeKeyboardInset(300); });
    assert.equal(position?.left, 80, "a real keyboard inset change re-anchors to the settled composer");
  } finally {
    Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: originalHeight, configurable: true });
    const { setNativeKeyboardInset } = await import("../src/mobileViewport.ts");
    await act(async () => {
      setNativeKeyboardInset(0);
      root.unmount();
    });
    container.remove();
  }
});

// iPhone report: with the keyboard held open, iOS WebKit reports client rects
// against the panned band while `position: fixed` places the surface in the
// layout viewport, so the composer's approval switch opened one pan offset
// above its button. The fixed-origin probe converts the anchor first.
test("anchored surfaces convert client rects into fixed coordinates under a panned band", async () => {
  const { act, createElement, useRef } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useAnchoredPosition } = await import("../src/components/ui/useAnchoredPosition.ts");
  const pan = 250;
  const elementProto = dom.Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
  const originalRect = elementProto.getBoundingClientRect;
  elementProto.getBoundingClientRect = function (this: Element) {
    if (this.hasAttribute("data-anchor-origin-probe")) {
      return { left: 0, right: 0, top: -pan, bottom: -pan, width: 0, height: 0 } as DOMRect;
    }
    return originalRect.call(this);
  };
  // The button sits 459px down the visible band, i.e. 709px in the layout.
  const anchor = { getBoundingClientRect: () => ({ left: 70, right: 114, top: 459, bottom: 503, width: 44, height: 44 }) } as HTMLElement;
  const surface = { getBoundingClientRect: () => ({ width: 150, height: 50 }) } as HTMLElement;
  let position: { top: number; left: number; side: string } | undefined;
  function Harness() {
    position = useAnchoredPosition(true, useRef(anchor), useRef(surface), { side: "up", align: "center", compact: true, stableAnchor: true });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  try {
    Object.defineProperty(window, "innerWidth", { value: 430, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 932, configurable: true });
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(position?.side, "up");
    assert.equal(position?.top, 459 + pan - 6 - 50, "the surface sits just above its button in layout coordinates");
    assert.equal(document.querySelectorAll("[data-anchor-origin-probe]").length, 1);
    await act(async () => { root.unmount(); });
    assert.equal(document.querySelectorAll("[data-anchor-origin-probe]").length, 0, "the probe goes with the surface");
  } finally {
    elementProto.getBoundingClientRect = originalRect;
    Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: originalHeight, configurable: true });
    container.remove();
  }
});

test("anchored surfaces stay in the visible band when both sides are short", async () => {
  const { act, createElement, useRef } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useAnchoredPosition } = await import("../src/components/ui/useAnchoredPosition.ts");
  const anchor = { getBoundingClientRect: () => ({ left: 20, right: 120, top: 40, bottom: 60, width: 100, height: 20 }) } as HTMLElement;
  const surface = { getBoundingClientRect: () => ({ width: 160, height: 300 }) } as HTMLElement;
  let position: { top: number; maxHeight: number; side: string } | undefined;
  function Harness() {
    position = useAnchoredPosition(true, useRef(anchor), useRef(surface));
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalHeight = window.innerHeight;
  try {
    Object.defineProperty(window, "innerHeight", { value: 100, configurable: true });
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(position?.side, "down");
    assert.equal(position?.maxHeight, 26);
    assert.equal(position?.top, 66);
    assert.ok((position?.top ?? 0) + (position?.maxHeight ?? 0) <= 92, "surface stays above the viewport margin");
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    await act(async () => { window.dispatchEvent(new window.Event("resize")); });
    assert.equal(position?.maxHeight, 826, "available height is not capped at the previously measured content height");
  } finally {
    Object.defineProperty(window, "innerHeight", { value: originalHeight, configurable: true });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("horizontal anchored surfaces stay beside the trigger and flip when needed", async () => {
  const { act, createElement, useRef } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useAnchoredPosition } = await import("../src/components/ui/useAnchoredPosition.ts");
  const anchor = { getBoundingClientRect: () => ({ left: 100, right: 140, top: 200, bottom: 240, width: 40, height: 40 }) } as HTMLElement;
  const surface = { getBoundingClientRect: () => ({ width: 160, height: 40 }) } as HTMLElement;
  let position: { top: number; left: number; maxWidth: number; side: string } | undefined;
  function Harness() {
    position = useAnchoredPosition(true, useRef(anchor), useRef(surface), { side: "right", align: "center" });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  try {
    Object.defineProperty(window, "innerWidth", { value: 220, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
    await act(async () => { root.render(createElement(Harness)); });
    assert.equal(position?.side, "left", "the surface flips to the side with more room");
    assert.equal(position?.left, 8);
    assert.equal(position?.top, 200, "center alignment uses the trigger's vertical center");
    assert.equal(position?.maxWidth, 86, "horizontal placement caps width to the available side");
  } finally {
    Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: originalHeight, configurable: true });
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("non-searchable Picker supports keyboard selection and restores trigger focus", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: Picker } = await import("../src/components/Picker.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const picked: string[] = [];
  try {
    await act(async () => { root.render(createElement(Picker, {
      label: "Choice", searchable: false,
      items: [{ id: "one", label: "One", group: "" }, { id: "two", label: "Two", group: "" }],
      onPick: (id: string) => picked.push(id),
    })); });
    const trigger = container.querySelector<HTMLButtonElement>(".picker-chip")!;
    await act(async () => { trigger.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    const list = document.body.querySelector<HTMLElement>(".picker-list")!;
    assert.equal(document.activeElement, list);
    await act(async () => { list.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    assert.equal(document.getElementById(list.getAttribute("aria-activedescendant")!)?.textContent?.includes("Two"), true);
    await act(async () => { list.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.deepEqual(picked, ["two"]);
    assert.equal(document.body.querySelector(".picker-list"), null);
    assert.equal(document.activeElement, trigger);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("phone Picker exposes multi-selection on its listbox", async () => {
  phoneMode = true;
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: Picker } = await import("../src/components/Picker.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(Picker, {
      label: "Choices", mobileSheet: true, values: ["one"],
      items: [{ id: "one", label: "One", group: "" }], onPick: () => {},
    })); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".picker-chip")!.click(); });
    assert.equal(document.body.querySelector('.picker-sheet [role="listbox"]')?.getAttribute("aria-multiselectable"), "true");
    assert.equal(document.body.querySelector('.picker-sheet [role="option"]')?.getAttribute("aria-selected"), "true");
  } finally {
    phoneMode = false;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("harness picker header omits Manage and Auto tabs", async () => {
  const source = await read("../../../packages/harness-runtime/widgets/runtime.tsx");
  assert.doesNotMatch(source, /pkg-harnesses-manage/);
  assert.doesNotMatch(source, /id:\s*"auto"/);
  assert.match(source, /mode:\s*"pinned"/);
  // An unusable harness has no tab; a session bound to one keeps a recovery
  // hint that does not name it.
  assert.match(source, /t\("runtime\.boundHidden"\)/);
  const catalog = await read("../../../packages/harness-runtime/src/i18n/en.ts");
  assert.match(catalog, /"harnessruntime\.runtime\.boundHidden": "[^"]*Choose another harness or open Harnesses in Settings/);
});

test("model picker keeps catalog in the shell and details in a sibling panel", async () => {
  const source = await read("../../../packages/models/widgets/ModelPicker.tsx");
  assert.doesNotMatch(source, /\{detail \? detailsView/);
  assert.doesNotMatch(source, /model-hover-card/);
  assert.match(source, /AdjacentDetailsPanel/);
  assert.match(source, /className="model-details-panel"/);
  assert.match(source, /className="model-picker-shell"/);
});

test("model picker loads details only after a row interaction", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let picks = 0;
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, {
        models: [{ providerID: "openai", modelID: "gpt-test", name: "GPT Test" }],
        onPick: () => { picks += 1; },
      }));
    });
    assert.equal(document.body.querySelector(".model-hover-details"), null, "details card is absent before opening");
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    assert.equal(document.body.querySelector(".model-hover-details"), null, "opening the picker does not preload a card");
    const row = document.body.querySelector<HTMLElement>(".model-picker-row");
    assert.ok(row, "catalog row renders");
    await act(async () => { row!.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })); });
    await act(async () => { await import("../../../packages/models/widgets/ModelDetails.tsx"); });
    assert.match(document.body.querySelector(".model-hover-details")?.textContent ?? "", /GPT Test/);
    assert.equal(picks, 0, "hovering for details does not choose a model");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("model picker shell keeps fixed geometry while details open beside it", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const styles = await read("../../../packages/models/widgets/model-picker-styles.css");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(createElement(ModelPicker, {
        models: [{ providerID: "openai", modelID: "gpt-test", name: "GPT Test" }],
        onPick: () => {},
        header: createElement("div", { "data-test-header": true }, "OpenCode"),
      }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });

    const pop = document.body.querySelector<HTMLElement>(".model-pop");
    assert.ok(pop, "desktop popover renders");
    const before = pop!.getBoundingClientRect();
    assert.ok(document.body.querySelector(".model-picker-shell"), "catalog stays inside the shell");
    assert.ok(document.body.querySelector("#model-pop-listbox"), "listbox stays in the shell");
    assert.equal(document.body.querySelector(".model-details-panel"), null, "details stay closed initially");
    assert.match(styles, /\.model-pop\s*\{[^}]*height:\s*min\(560px,\s*72vh\)/s, "popover height is pinned");
    assert.doesNotMatch(styles, /\.model-pop\s*\{[^}]*min-height:/s, "collision bounds may shrink the preferred height on short viewports");

    const row = document.body.querySelector<HTMLElement>(".model-picker-row");
    assert.ok(row, "catalog row renders");
    assert.equal(document.body.querySelector(".model-picker-row .model-row-info"), null, "desktop rows do not expose an info control");
    await act(async () => { row!.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })); });

    const panel = document.body.querySelector<HTMLElement>(".model-details-panel");
    assert.ok(panel, "details panel opens");
    assert.ok(!document.body.querySelector(".model-picker-shell")?.contains(panel), "details are outside the shell");
    assert.ok(document.body.querySelector("#model-pop-listbox"), "listbox remains in the shell");

    const after = pop!.getBoundingClientRect();
    assert.equal(after.width, before.width, "popover width stays fixed after details open");
    assert.equal(after.left, before.left, "popover anchor left stays fixed after details open");
    assert.equal(after.height, before.height, "popover height stays fixed after details open");
    assert.equal(after.top, before.top, "popover anchor top stays fixed after details open");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("phone model rows place thinking effort in the former info slot", async () => {
  phoneMode = true;
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (models: ModelDescriptor[], harnessId: string, catalogLoading = false) => act(async () => {
    root.render(createElement(ModelPicker, { models, harnessId, catalogLoading, onPick: () => {} }));
  });
  try {
    await render([
      { harnessId: "codex", providerID: "openai", modelID: "gpt-test", name: "GPT Test", variants: ["high"] },
    ], "codex");
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    const pop = document.body.querySelector<HTMLElement>(".model-pop");
    assert.ok(pop, "phone picker uses the compact anchored popover");
    assert.equal(document.body.querySelector(".model-sheet"), null, "phone picker does not open a bottom sheet");
    assert.equal(pop!.querySelector(".model-picker-row .model-row-info"), null, "rows do not expose an info control");
    assert.ok(pop!.querySelector(".model-thinking-trigger"), "rows expose thinking effort in the former info slot");

    await render(Array.from({ length: 10 }, (_, index) => ({
      harnessId: "claude",
      providerID: "anthropic",
      modelID: `claude-${index}`,
      name: `Claude ${index}`,
    })), "claude");
    assert.equal(document.body.querySelector(".model-pop"), pop, "switching harnesses keeps the same open phone surface");

    await render([], "claude", true);
    assert.equal(document.body.querySelector(".model-pop"), pop, "loading updates reuse the open phone surface");
    assert.match(pop!.textContent ?? "", /loading/i);
  } finally {
    phoneMode = false;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("thinking effort commits once, keeps the model picker open, and survives reopening", async () => {
  const { act, createElement, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const model = {
    harnessId: "codex",
    providerID: "openai",
    modelID: "reasoning",
    name: "Reasoning model",
    variants: ["low", "high"],
    defaultVariant: "low",
  };
  const picks: Array<{ variant?: string }> = [];

  function Harness() {
    const [thinking, setThinking] = useState<string | null>("low");
    return createElement(ModelPicker, {
      harnessId: "codex",
      models: [model],
      value: { harnessId: "codex", providerID: "openai", modelID: "reasoning" },
      thinking,
      onPick: (picked) => {
        if (!picked) return;
        picks.push(picked);
        setThinking(picked.variant || null);
      },
    });
  }

  try {
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    await act(async () => { document.body.querySelector<HTMLButtonElement>(".model-thinking-trigger")!.click(); });
    const high = [...document.body.querySelectorAll<HTMLButtonElement>(".model-thinking-menu .ui-menu-item")]
      .find((button) => button.textContent?.trim() === "High");
    assert.ok(high, "thinking menu offers High");
    await act(async () => { high!.click(); });

    assert.equal(picks.length, 1, "the portalled effort action must not bubble into model selection");
    assert.equal(picks[0]?.variant, "high");
    assert.ok(document.body.querySelector(".model-pop"), "choosing thinking effort keeps the picker open");
    assert.equal(document.body.querySelector(".model-thinking-trigger span")?.textContent, "High");

    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    assert.equal(document.body.querySelector(".model-pop"), null);
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    assert.equal(document.body.querySelector(".model-thinking-trigger span")?.textContent, "High", "the committed effort is restored on reopen");

    await act(async () => { document.body.querySelector<HTMLButtonElement>(".model-thinking-trigger")!.click(); });
    const auto = [...document.body.querySelectorAll<HTMLButtonElement>(".model-thinking-menu .ui-menu-item")]
      .find((button) => button.textContent?.trim() === "Auto");
    assert.ok(auto, "thinking menu offers explicit Auto");
    await act(async () => { auto!.click(); });
    assert.equal(picks.length, 2, "Auto also commits exactly once");
    assert.equal(picks[1]?.variant, "", "Auto keeps its explicit empty-variant sentinel");
    assert.ok(document.body.querySelector(".model-pop"), "choosing Auto also keeps the picker open");
    assert.equal(document.body.querySelector(".model-thinking-trigger span")?.textContent, "Auto");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("explicit Auto affects only the selected row and omitted thinking preserves its model ref", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const models = [
    {
      harnessId: "codex",
      providerID: "openai",
      modelID: "selected",
      name: "Selected",
      variants: ["low", "high"],
      defaultVariant: "low",
    },
    {
      harnessId: "codex",
      providerID: "openai",
      modelID: "other",
      name: "Other",
      variants: ["low", "high"],
      defaultVariant: "high",
    },
  ];
  const picks: Array<{ variant?: string }> = [];
  const base = {
    harnessId: "codex",
    models,
    onPick: (picked?: { variant?: string }) => { if (picked) picks.push(picked); },
  };
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, {
        ...base,
        value: { harnessId: "codex", providerID: "openai", modelID: "selected" },
        thinking: null,
      }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    const labels = [...document.body.querySelectorAll(".model-picker-row .model-thinking-trigger span")]
      .map((label) => label.textContent);
    assert.deepEqual(labels, ["Auto", "High"], "selected Auto must not replace another model's default label");

    await act(async () => {
      root.render(createElement(ModelPicker, {
        ...base,
        value: { harnessId: "codex", providerID: "openai", modelID: "selected", variant: "high" },
      }));
    });
    assert.equal(
      document.body.querySelector(".model-picker-row.current .model-thinking-trigger span")?.textContent,
      "High",
      "an omitted controlled choice falls back to the canonical model ref",
    );
    await act(async () => { document.body.querySelector<HTMLElement>(".model-picker-row.current")!.click(); });
    assert.equal(picks[0]?.variant, "high", "reselecting the current row preserves its canonical effort");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("all picker groups restore and react to each model's saved effort on desktop and phone", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("@polyth/models/model-picker");
  const { modelKey } = await import("@polyth/models");
  const {
    getModelPrefs, getThinkingPrefs, replaceModelPrefs, replaceThinkingPrefs,
    setModelThinking, thinkingModelKey,
  } = await import("@polyth/models/web-prefs");
  const originalModels = getModelPrefs();
  const originalThinking = getThinkingPrefs();
  const models: ModelDescriptor[] = ["Selected", "Favorite", "Recent", "Unsupported"].map((name) => ({
    harnessId: "opencode", providerID: "openai", modelID: name.toLowerCase(), name,
    variants: ["low", "high"], defaultVariant: "high",
  }));
  const [selected, favorite, recent, unsupported] = models as [ModelDescriptor, ModelDescriptor, ModelDescriptor, ModelDescriptor];
  const row = (model: ModelDescriptor) => document.getElementById(`model-option-${modelKey(model)}`)!;
  const label = (model: ModelDescriptor) => row(model).querySelector(".model-thinking-trigger span")?.textContent;

  try {
    for (const phone of [false, true]) {
      phoneMode = phone;
      replaceModelPrefs({ ...originalModels, favorites: [modelKey(favorite)], recents: [modelKey(recent)] });
      replaceThinkingPrefs({
        [thinkingModelKey(selected)]: "low",
        [thinkingModelKey(favorite)]: "low",
        [thinkingModelKey(recent)]: "",
        [thinkingModelKey(unsupported)]: "max",
      });
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const picks: Array<{ variant?: string }> = [];
      try {
        await act(async () => { root.render(createElement(ModelPicker, {
          models, harnessId: "opencode", value: { ...selected, variant: "low" }, thinking: "high",
          onPick: (picked) => { if (picked) picks.push(picked); },
        })); });
        const toggle = () => act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
        await toggle();
        assert.equal(label(selected), "High", "the controlled choice overrides saved effort and ModelRef.variant");
        assert.equal(label(favorite), "Low", "an inactive favorite restores its own effort");
        assert.equal(label(recent), "Auto", "an inactive recent restores explicit Auto");
        assert.equal(label(unsupported), "High", "unsupported saved effort falls back to the catalog default");
        await act(async () => { row(favorite).querySelector<HTMLButtonElement>(".model-thinking-trigger")!.click(); });
        const checked = () => document.body.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent?.trim();
        assert.equal(checked(), "Low", "the inactive row's radio check follows its preference");
        await act(async () => { setModelThinking(favorite, "high"); });
        assert.equal(label(favorite), "High", "composer changes refresh the open list");
        assert.equal(checked(), "High", "the open effort menu refreshes too");
        await act(async () => { row(favorite).querySelector<HTMLButtonElement>(".model-thinking-trigger")!.click(); });
        await act(async () => { row(favorite).click(); });
        assert.equal(picks.at(-1)?.variant, "high", "row selection restores the displayed effort");
        await toggle();
        await act(async () => { row(recent).click(); });
        assert.equal(picks.at(-1)?.variant, "", "row selection preserves the explicit Auto sentinel");
        await toggle();
        await act(async () => { row(unsupported).click(); });
        assert.equal(Object.hasOwn(picks.at(-1)!, "variant"), false, "an unsupported effort is never selected");
      } finally {
        await act(async () => { root.unmount(); });
        container.remove();
      }
    }
  } finally {
    phoneMode = false;
    replaceModelPrefs(originalModels);
    replaceThinkingPrefs(originalThinking);
  }
});

test("effort choices survive picker remounts and synchronize server and account-scoped tab updates", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("@polyth/models/model-picker");
  const {
    THINKING_PREFS_KEY, getThinkingPrefs, replaceThinkingPrefs, thinkingModelKey, useModelThinking,
  } = await import("@polyth/models/web-prefs");
  const { accountStorageKey } = await import("../src/accountStorage.ts");
  const original = getThinkingPrefs();
  const model: ModelDescriptor = {
    harnessId: "codex", providerID: "openai", modelID: "shared-effort", name: "Shared effort",
    variants: ["low", "high"], defaultVariant: "low",
  };
  const otherHarness = { ...model, harnessId: "claude" };
  const picks: Array<{ variant?: string }> = [];
  function Harness({ descriptor }: { descriptor: ModelDescriptor }) {
    const effort = useModelThinking(descriptor);
    return createElement("div", null,
      createElement("output", { id: "saved-effort" }, effort ?? "untouched"),
      createElement(ModelPicker, {
        models: [descriptor], harnessId: descriptor.harnessId, value: descriptor,
        onPick: (picked) => { if (picked) picks.push(picked); },
      }));
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (descriptor: ModelDescriptor, key: string) => act(async () => {
    root.render(createElement(Harness, { descriptor, key }));
  });
  const open = () => act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
  const label = () => document.body.querySelector(".model-thinking-trigger span")?.textContent;
  const chooseEffort = async (effort: string) => {
    await act(async () => { document.body.querySelector<HTMLButtonElement>(".model-thinking-trigger")!.click(); });
    const choice = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((button) => button.textContent?.trim() === effort)!;
    await act(async () => { choice.click(); });
  };
  try {
    replaceThinkingPrefs({});
    await render(model, "first-picker");
    await open();
    await chooseEffort("High");
    assert.equal(picks.length, 1, "the effort action selects once without bubbling into its row");
    assert.equal(label(), "High", "the picker persists without requiring its consumer to save");
    assert.equal(container.querySelector("output")?.textContent, "high", "composer subscriptions refresh");
    await render(model, "second-picker");
    await open();
    assert.equal(label(), "High", "another picker restores the saved choice");
    await chooseEffort("Auto");
    await render(otherHarness, "other-harness");
    await open();
    assert.equal(label(), "Low", "matching provider/model ids do not share effort across harnesses");
    await render(model, "returned-picker");
    await open();
    assert.equal(label(), "Auto", "Auto is remembered across picker and harness changes");
    await act(async () => { replaceThinkingPrefs({ [thinkingModelKey(model)]: "high" }); });
    assert.equal(label(), "High", "a server settings snapshot refreshes the open picker");
    const update = JSON.stringify({ [thinkingModelKey(model)]: "low" });
    await act(async () => { window.dispatchEvent(new window.StorageEvent("storage", {
      key: accountStorageKey(THINKING_PREFS_KEY, "usr_foreign"), newValue: update,
    })); });
    assert.equal(label(), "High", "another account's storage event is ignored");
    await act(async () => { window.dispatchEvent(new window.StorageEvent("storage", {
      key: accountStorageKey(THINKING_PREFS_KEY), newValue: update,
    })); });
    assert.equal(label(), "Low", "the same account's tab update refreshes the open picker");
    assert.equal(container.querySelector("output")?.textContent, "low");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    replaceThinkingPrefs(original);
  }
});

test("the shell-owned picker and provider logo ship their own stylesheets", async () => {
  // The composer imports these components into the shell bundle. The Models
  // package stylesheet attaches only when that package activates, so a phone
  // that opened the picker before (or without) activation got an unstyled
  // popover with a full-width provider mark.
  const picker = await read("../../../packages/models/widgets/ModelPicker.tsx");
  const logo = await read("../../../packages/models/widgets/ProviderLogo.tsx");
  const packageStyles = await read("../../../packages/models/widgets/styles.css");
  const logoStyles = await read("../../../packages/models/widgets/provider-logo-styles.css");
  assert.match(picker, /^import "\.\/model-picker-styles\.css";$/m);
  assert.match(logo, /^import "\.\/provider-logo-styles\.css";$/m);
  assert.match(logoStyles, /\.provider-logo > svg\s*\{[^}]*width:\s*100%;\s*height:\s*100%;/s);
  assert.doesNotMatch(packageStyles, /\.model-pop\b|\.model-picker-row\b|(^|[\s,}])\.provider-logo\s*\{/m,
    "the activation-scoped package stylesheet does not own shell picker rules");
});

test("every harness catalog uses the same compact popover surface on desktop and phone", async () => {
  const source = await read("../../../packages/models/widgets/ModelPicker.tsx");
  const styles = await read("../../../packages/models/widgets/model-picker-styles.css");
  assert.doesNotMatch(source, /compactCatalog|--model-pop-rows|model-pop--compact/);
  assert.doesNotMatch(source, /common\.edit|common\.done|setEditing|reorderableOnPhone/);
  assert.match(source, /className="model-pop"/);
  assert.match(source, /model-pop-search-input/);
  assert.doesNotMatch(source, /sheetSize="tall"/);
  assert.doesNotMatch(styles, /\.model-pop--compact/);
  assert.match(styles, /\.model-pop\s*\{[^}]*height:\s*min\(560px,\s*72vh\)/s);
  assert.match(styles, /\.model-pop-search-input\s*\{[^}]*min-height:\s*var\(--control-h-sm\);/s);
  assert.match(styles, /\.model-provider-head strong\s*\{[^}]*font-size:\s*max\(var\(--font-label\),\s*1rem\);/s);
  assert.match(
    styles,
    /\.model-pop \.pkg-harnesses-tablist \.provider-logo\s*\{[^}]*color:\s*currentColor;/s,
    "compact picker harness logos inherit selected-tab color",
  );
  assert.match(source, /getViewportMetrics\(\)/, "phone opening checks whether the keyboard is actually open");
  assert.match(source, /if \(keyboardWasOpen\) void dismissal\.then\(reveal\)/,
    "phone opening waits for keyboard geometry only when needed");
  assert.match(
    styles,
    /@media \(pointer: coarse\) \{[\s\S]*?\.model-pop\s*\{[\s\S]*?height:\s*min\(560px,\s*calc\(var\(--visual-vh,\s*100dvh\)\s*\*\s*0\.52\)\);[\s\S]*?max-height:\s*min\(560px,\s*calc\(var\(--visual-vh,\s*100dvh\)\s*\*\s*0\.52\)\);[\s\S]*?border-radius:\s*var\(--radius-surface\);/s,
    "phone picker keeps a fixed compact size and uses the user-scaled surface radius",
  );
  assert.doesNotMatch(
    styles,
    /@media \(pointer: coarse\) \{[\s\S]*?\.model-pop\s*\{[^}]*height:\s*auto/s,
    "phone catalog changes cannot switch the popover back to content-sized geometry",
  );
  const hook = await read("../src/components/ui/useAnchoredPosition.ts");
  const popover = await read("../src/components/ui/Popover.tsx");
  assert.match(hook, /addEventListener\("scroll", onVisualScroll\)/,
    "visual-viewport pans update geometry without resetting the opening anchor");
  assert.match(hook, /keyboardOrSizeChanged/,
    "native/visual keyboard inset is the only compact re-anchor signal besides layout resize");
  assert.match(hook, /pointerActive && reanchorOnViewportChange/,
    "a finger down on a harness tab freezes re-anchor until release");
  assert.match(
    popover,
    /event\.detail > 0 && !pointerInside\.current[\s\S]*?event\.preventDefault\(\)/,
    "the opening gesture's ghost click cannot select a harness tab",
  );
});

test("a pending route anchor keeps the last known label instead of the first catalogue entry", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker, modelChipDisplay } =
    await import("../../../packages/models/widgets/ModelPicker.tsx");
  const target = [{ harnessId: "cursor", providerID: "cursor", modelID: "auto", name: "Cursor Auto" }];
  const anchor = { providerID: "opencode", modelID: "big-pickle", name: "Big Pickle" };

  // The rule itself: a route change has no confirmed model, so the last known
  // identity is shown — never the first entry of the target catalogue.
  assert.deepEqual(
    modelChipDisplay({ models: target, pending: anchor, emptyLabel: "No model" }),
    { label: "Big Pickle", pending: true },
  );
  assert.deepEqual(
    modelChipDisplay({ models: target, pending: { providerID: "cursor", modelID: "auto" }, emptyLabel: "No model" }),
    { label: "Cursor Auto", model: target[0], pending: true },
    "an anchor the target catalogue knows shows its real name",
  );
  assert.deepEqual(
    modelChipDisplay({ models: target, emptyLabel: "No model" }),
    { label: "Cursor Auto", model: target[0], pending: false },
    "without an anchor the first entry still stands in as the recommendation",
  );

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, {
        models: target,
        harnessId: "cursor",
        pendingModel: anchor,
        onPick: () => {},
      }));
    });
    const trigger = container.querySelector<HTMLButtonElement>(".model-picker-trigger");
    assert.equal(trigger?.querySelector(".model-trigger-name")?.textContent, "Big Pickle");
    assert.equal(trigger?.getAttribute("data-pending"), "true");
    assert.match(trigger?.getAttribute("aria-label") ?? "", /Big Pickle/);

    await act(async () => {
      root.render(createElement(ModelPicker, {
        models: target,
        harnessId: "cursor",
        value: { providerID: "cursor", modelID: "auto", harnessId: "cursor" },
        pendingModel: anchor,
        onPick: () => {},
      }));
    });
    assert.equal(
      container.querySelector(".model-trigger-name")?.textContent,
      "Cursor Auto",
      "a confirmed selection for the new route always wins over the anchor",
    );
    assert.equal(trigger?.getAttribute("data-pending"), null);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("an explicit empty selection shows the empty label and can be re-cleared", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const picks: Array<{ providerID: string; modelID: string } | undefined> = [];
  const models: ModelDescriptor[] = [
    { harnessId: "opencode", providerID: "openai", modelID: "luna", name: "Luna", connected: true },
    { harnessId: "opencode", providerID: "openai", modelID: "astra", name: "Astra", connected: true },
  ];
  const onPick = (model?: { providerID: string; modelID: string; variant?: string; harnessId?: string }) => picks.push(model);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, {
        models,
        harnessId: "opencode",
        emptyLabel: "OpenCode default",
        onPick,
      }));
    });
    assert.equal(
      container.querySelector(".model-trigger-name")?.textContent,
      "OpenCode default",
      "an unset route never pretends the first catalogue entry is selected",
    );
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    const emptyRow = document.body.querySelector(".model-picker-row-empty");
    assert.equal(emptyRow?.textContent, "OpenCode default");
    assert.equal(emptyRow?.classList.contains("current"), true);
    // No selection yet, so the empty route still expands the first provider.

    await act(async () => {
      const lunaRow = [...document.body.querySelectorAll<HTMLElement>(".model-picker-row")]
        .find((row) => row.textContent?.includes("Luna"));
      assert.ok(lunaRow, "the open catalogue exposes the Luna row");
      lunaRow.click();
    });
    assert.deepEqual(picks.at(-1), { providerID: "openai", modelID: "luna", harnessId: "opencode" });

    await act(async () => {
      root.render(createElement(ModelPicker, {
        models,
        harnessId: "opencode",
        value: { providerID: "openai", modelID: "luna" },
        emptyLabel: "OpenCode default",
        onPick,
      }));
    });
    assert.equal(container.querySelector(".model-trigger-name")?.textContent, "Luna");
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    await act(async () => { document.querySelector<HTMLElement>(".model-picker-row-empty")!.click(); });
    assert.equal(picks.at(-1), undefined, "the empty row clears the route");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("the empty row is the first keyboard stop and Enter clears the route", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const picks: Array<{ providerID: string; modelID: string } | undefined> = [];
  const models: ModelDescriptor[] = [
    { harnessId: "opencode", providerID: "openai", modelID: "luna", name: "Luna", connected: true },
    { harnessId: "opencode", providerID: "openai", modelID: "astra", name: "Astra", connected: true },
  ];
  const onPick = (model?: { providerID: string; modelID: string; variant?: string; harnessId?: string }) => picks.push(model);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const searchInput = () => document.body.querySelector<HTMLElement>(".model-picker-list")!;
  const press = async (key: string) => {
    await act(async () => { searchInput().dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true })); });
  };
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, {
        models,
        harnessId: "opencode",
        value: { providerID: "openai", modelID: "luna" },
        emptyLabel: "OpenCode default",
        onPick,
      }));
    });
    const trigger = container.querySelector<HTMLButtonElement>(".model-picker-trigger")!;
    await act(async () => { trigger.click(); });
    const emptyRow = document.body.querySelector<HTMLElement>(".model-picker-row-empty")!;
    assert.equal(emptyRow.classList.contains("active"), false, "opens on the model rows, not the empty route");

    await press("ArrowUp");
    assert.equal(emptyRow.classList.contains("active"), true, "ArrowUp from the first model reaches the empty row");
    assert.equal(searchInput().getAttribute("aria-activedescendant"), emptyRow.id);
    assert.equal(document.body.querySelectorAll(".model-picker-row.active").length, 1, "one keyboard stop at a time");

    await press("ArrowDown");
    assert.equal(emptyRow.classList.contains("active"), false, "ArrowDown leaves the empty row");
    assert.notEqual(searchInput().getAttribute("aria-activedescendant"), emptyRow.id);
    assert.equal(document.body.querySelectorAll(".model-picker-row.active").length, 1);

    await press("End");
    await press("Home");
    assert.equal(emptyRow.classList.contains("active"), true, "Home lands on the first row, which is the empty one");

    await press("Enter");
    assert.equal(picks.length, 1);
    assert.equal(picks[0], undefined, "Enter on the empty row clears the route");
    assert.equal(document.body.querySelector(".model-picker-row-empty"), null, "the picker closes after clearing");
    assert.equal(document.activeElement, trigger, "focus returns to the trigger like any other pick");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("a picker without an empty route keeps model rows as its only keyboard stops", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const picks: string[] = [];
  const models: ModelDescriptor[] = [
    { harnessId: "opencode", providerID: "openai", modelID: "luna", name: "Luna", connected: true },
    { harnessId: "opencode", providerID: "openai", modelID: "astra", name: "Astra", connected: true },
  ];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, {
        models,
        harnessId: "opencode",
        value: { providerID: "openai", modelID: "luna" },
        onPick: (model?: { modelID: string }) => picks.push(model?.modelID ?? "none"),
      }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    assert.equal(document.body.querySelector(".model-picker-row-empty"), null, "no empty row unless a consumer asks for one");
    const input = document.body.querySelector<HTMLElement>(".model-picker-list")!;
    const before = input.getAttribute("aria-activedescendant");
    await act(async () => { input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    assert.equal(input.getAttribute("aria-activedescendant"), before, "ArrowUp at the top stays on the first model");
    await act(async () => { input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.equal(picks.length, 1, "Enter still picks the highlighted model");
    assert.notEqual(picks[0], "none");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("search is a standing field beside the trigger: harness tabs stay, typing on the list continues there, Escape clears first", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const models: ModelDescriptor[] = [
    { harnessId: "opencode", providerID: "openai", modelID: "luna", name: "Luna", connected: true },
    { harnessId: "opencode", providerID: "openai", modelID: "astra", name: "Astra", connected: true },
  ];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const field = () => document.body.querySelector<HTMLInputElement>(".model-pop-search input");
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, { models, harnessId: "opencode", direction: "up", header: createElement("span", { id: "tabs" }, "tabs"), onPick: () => undefined }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    assert.ok(field(), "the field is mounted with the picker, so a tap focuses a real input");
    assert.ok(document.body.querySelector(".model-pop-content.search-end"), "an upward picker keeps the field at the edge nearest its trigger");
    assert.equal(document.body.querySelector(".model-provider-head.static"), null, "no Favorites/Recent titles");
    const list = document.body.querySelector<HTMLElement>(".model-picker-list")!;
    await act(async () => { list.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a", bubbles: true })); });
    assert.equal(field()?.value, "a", "a character typed on the list continues in the field");
    assert.equal(document.activeElement, field());
    assert.ok(document.body.querySelector("#tabs"), "the harness tabs stay while searching");
    assert.ok(document.body.querySelector(".model-pop-search-clear"), "a query offers a clear button");
    await act(async () => { window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(field()?.value, "", "Escape clears the query");
    assert.ok(document.body.querySelector(".model-pop"), "and keeps the picker open");
    assert.equal(document.body.querySelectorAll(".model-picker-row").length, 2, "every row is back");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("phone picker has no search: typing on the list cannot filter it, and a capped catalog pages with Show more", async () => {
  phoneMode = true;
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const models: ModelDescriptor[] = Array.from({ length: 230 }, (_, index) => ({
    harnessId: "claude", providerID: "anthropic", modelID: `phone-${index}`, name: `Phone ${index}`,
  }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const rows = () => document.body.querySelectorAll(".model-pop .model-picker-row").length;
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, {
        models,
        harnessId: "claude",
        direction: "up",
        value: { harnessId: "claude", providerID: "anthropic", modelID: "phone-0" },
        header: createElement("span", { id: "tabs" }, "tabs"),
        onPick: () => undefined,
      }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    const pop = document.body.querySelector<HTMLElement>(".model-pop")!;
    assert.ok(pop, "the phone picker opens");
    assert.equal(pop.querySelector(".model-pop-search"), null, "phone has no search field");
    assert.equal(pop.querySelector("input"), null, "nothing in the phone picker raises the keyboard");
    assert.equal(pop.querySelector(".model-pop-content.search-end"), null, "no edge is reserved for a field");
    assert.ok(pop.querySelector("#tabs"), "harness tabs stay the phone's catalog navigation");
    assert.equal(rows(), 200, "the render cap still bounds one overlay");

    const list = pop.querySelector<HTMLElement>(".model-picker-list")!;
    await act(async () => { list.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", bubbles: true })); });
    assert.equal(rows(), 200, "a typed character cannot leave an invisible filter behind");

    assert.equal(pop.querySelector(".picker-more"), null, "no 'refine the filter' hint without a filter");
    const more = pop.querySelector<HTMLButtonElement>("button.model-picker-more");
    assert.match(more?.textContent ?? "", /30/, "Show more names what is left");
    await act(async () => { more!.click(); });
    assert.equal(rows(), 230, "Show more renders the rest of the catalog");
    assert.equal(pop.querySelector(".model-picker-more"), null);
  } finally {
    phoneMode = false;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("search reaches other harnesses: grouped after this harness, picking hands over the harness id", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const models: ModelDescriptor[] = [
    { harnessId: "opencode", providerID: "openai", modelID: "luna", name: "Luna", connected: true },
  ];
  const otherHarnesses = [
    { harnessId: "claude", name: "Claude Code", models: [{ harnessId: "claude", providerID: "anthropic", modelID: "luna-max", name: "Luna Max" }] },
    { harnessId: "codex", name: "Codex", models: [{ harnessId: "codex", providerID: "openai", modelID: "sun", name: "Sun" }] },
  ];
  const picks: Array<{ modelID: string; harnessId?: string } | undefined> = [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const names = () => [...document.body.querySelectorAll(".model-picker-row strong")].map((node) => node.firstChild?.textContent);
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, { models, harnessId: "opencode", otherHarnesses, onPick: (model) => picks.push(model) }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    assert.deepEqual(names(), ["Luna"], "other harnesses are never listed without a query");
    const list = document.body.querySelector<HTMLElement>(".model-picker-list")!;
    await act(async () => { list.dispatchEvent(new window.KeyboardEvent("keydown", { key: "l", bubbles: true })); });
    assert.deepEqual(names(), ["Luna", "Luna Max"], "this harness first, then matches elsewhere");
    assert.equal(document.body.querySelector(".model-picker-elsewhere strong")?.textContent, "Claude Code", "grouped under the harness name");
    const field = document.body.querySelector<HTMLInputElement>(".model-pop-search input")!;
    await act(async () => { field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    await act(async () => { field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    assert.equal(picks.at(-1)?.modelID, "luna-max", "keyboard reaches the cross-harness row");
    assert.equal(picks.at(-1)?.harnessId, "claude", "the pick carries the target harness");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("multi-select toggles a set in place, clears through the empty row and honours its cap", async () => {
  const { act, createElement, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("@polyth/models/model-picker");
  const { modelKey } = await import("@polyth/models");
  const models: ModelDescriptor[] = ["One", "Two", "Three"].map((name) => ({
    harnessId: "opencode", providerID: "openai", modelID: name.toLowerCase(), name,
    variants: ["low", "high"],
  }));
  const [one, two, three] = models as [ModelDescriptor, ModelDescriptor, ModelDescriptor];
  type Ref = { providerID: string; modelID: string; harnessId?: string };
  let current: Ref[] = [];
  function Harness() {
    const [selection, setSelection] = useState<Ref[]>([]);
    current = selection;
    return createElement(ModelPicker, {
      models, harnessId: "opencode", selection, maxSelection: 2, emptyLabel: "Any model",
      onPick: () => setSelection([]),
      onToggle: (picked) => setSelection((previous) => previous.some((entry) => entry.modelID === picked.modelID)
        ? previous.filter((entry) => entry.modelID !== picked.modelID)
        : [...previous, picked]),
    });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const row = (model: ModelDescriptor) => document.getElementById(`model-option-${modelKey(model)}`)!;
  const trigger = () => container.querySelector<HTMLButtonElement>(".model-picker-trigger")!;
  try {
    await act(async () => { root.render(createElement(Harness)); });
    assert.match(trigger().textContent ?? "", /Any model/, "an empty set shows the empty label");
    await act(async () => { trigger().click(); });
    assert.equal(document.querySelector('[role="listbox"]')?.getAttribute("aria-multiselectable"), "true");
    assert.equal(row(one).querySelector(".model-thinking-trigger"), null, "a set has no per-route thinking menu");
    await act(async () => { row(one).click(); });
    await act(async () => { row(two).click(); });
    assert.deepEqual(current.map((entry) => entry.modelID), ["one", "two"], "rows toggle without closing the popover");
    assert.equal(Object.hasOwn(current[0]!, "variant"), false, "set members never carry an effort");
    assert.equal(row(one).getAttribute("aria-selected"), "true");
    assert.equal(row(three).getAttribute("aria-disabled"), "true", "the cap blocks another member");
    await act(async () => { row(three).click(); });
    assert.equal(current.length, 2, "a capped set ignores unselected rows");
    assert.match(trigger().textContent ?? "", /2 models/);
    await act(async () => { row(one).click(); });
    assert.deepEqual(current.map((entry) => entry.modelID), ["two"], "a selected row toggles off");
    assert.equal(row(three).getAttribute("aria-disabled"), null, "removing a member frees the cap");
    await act(async () => { document.getElementById("model-option-empty")!.click(); });
    assert.equal(current.length, 0, "the empty row clears the set");
    assert.ok(document.getElementById("model-option-empty"), "clearing keeps the popover open");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("multi-select Enter toggles the keyboard row in place", async () => {
  const { act, createElement, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("@polyth/models/model-picker");
  const models: ModelDescriptor[] = ["One", "Two", "Three", "Four"].map((name) => ({
    harnessId: "opencode", providerID: "openai", modelID: name.toLowerCase(), name,
  }));
  type Ref = { providerID: string; modelID: string; harnessId?: string };
  let current: Ref[] = [];
  function Harness() {
    const [selection, setSelection] = useState<Ref[]>(() => [models[1]!, models[3]!]);
    current = selection;
    return createElement(ModelPicker, {
      models, harnessId: "opencode", selection,
      onPick: () => setSelection([]),
      onToggle: (picked) => setSelection((previous) => previous.some((entry) => entry.modelID === picked.modelID)
        ? previous.filter((entry) => entry.modelID !== picked.modelID)
        : [...previous, picked]),
    });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const active = () => document.body.querySelector(".model-picker-row.active strong")?.textContent;
  const press = async (key: string) => {
    await act(async () => {
      document.body.querySelector<HTMLElement>(".model-picker-list")!
        .dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
    });
  };
  try {
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    await press("ArrowDown");
    const row = active();
    assert.ok(row, "the keyboard has a row");
    const before = current.map((entry) => entry.modelID).sort();
    await press("Enter");
    assert.equal(active(), row, "a toggle leaves the keyboard on its row, not on another member");
    await press("Enter");
    assert.equal(active(), row);
    assert.deepEqual(current.map((entry) => entry.modelID).sort(), before, "Enter twice toggles one row off and back on");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("the keyboard-active row starts on the selected model, also after a harness switch", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const claude: ModelDescriptor[] = ["one", "two", "three"].map((id) => (
    { harnessId: "claude", providerID: "anthropic", modelID: id, name: `Claude ${id}` }));
  const codex: ModelDescriptor[] = ["alpha", "beta", "gamma"].map((id) => (
    { harnessId: "codex", providerID: "openai", modelID: id, name: `Codex ${id}` }));
  const picks: Array<{ providerID: string; modelID: string } | undefined> = [];
  const onPick = (model?: { providerID: string; modelID: string; variant?: string; harnessId?: string }) => picks.push(model);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (props: Omit<Parameters<typeof ModelPicker>[0], "onPick">) => act(async () => {
    root.render(createElement(ModelPicker, { ...props, onPick }));
  });
  const active = () => document.body.querySelector(".model-picker-row.active strong")?.textContent;
  const press = async (key: string) => {
    await act(async () => {
      document.body.querySelector<HTMLElement>(".model-picker-list")!
        .dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
    });
  };
  try {
    await render({ models: claude, harnessId: "claude", value: { providerID: "anthropic", modelID: "two", harnessId: "claude" } });
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    assert.equal(active(), "Claude two", "opening lands on the current choice, not on row one");
    assert.equal(document.body.querySelectorAll(".model-picker-row.active").length, 1);

    // The owner switches the harness and recommends the model last chosen there.
    await render({ models: codex, harnessId: "codex", recommended: { providerID: "openai", modelID: "gamma", harnessId: "codex" } });
    assert.equal(document.body.querySelector(".model-picker-row.current strong")?.textContent, "Codex gamma");
    assert.equal(active(), "Codex gamma", "a switched harness opens on its selected model too");

    await press("ArrowUp");
    assert.equal(active(), "Codex beta", "arrows move on from the selected row");
    // Moving the keyboard and then switching harness again starts over on the new selection.
    await render({ models: claude, harnessId: "claude", recommended: { providerID: "anthropic", modelID: "three", harnessId: "claude" } });
    assert.equal(active(), "Claude three", "a harness switch resets the keyboard to that harness's selection");
    await render({ models: codex, harnessId: "codex", recommended: { providerID: "openai", modelID: "gamma", harnessId: "codex" } });
    assert.equal(active(), "Codex gamma");
    await press("Enter");
    assert.deepEqual(picks.map((pick) => pick?.modelID), ["gamma"], "Enter right away keeps the selected model");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

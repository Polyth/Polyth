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

test("harness picker header omits Manage and Auto tabs", async () => {
  const source = await read("../../../packages/harness-runtime/widgets/runtime.tsx");
  assert.doesNotMatch(source, /pkg-harnesses-manage/);
  assert.doesNotMatch(source, /id:\s*"auto"/);
  assert.match(source, /mode:\s*"pinned"/);
  assert.match(source, /Open Harnesses in Settings to finish setup/);
});

test("model picker keeps catalog in the shell and details in a sibling panel", async () => {
  const source = await read("../../../packages/models/widgets/ModelPicker.tsx");
  assert.doesNotMatch(source, /\{detail \? detailsView/);
  assert.doesNotMatch(source, /model-hover-card/);
  assert.match(source, /AdjacentDetailsPanel/);
  assert.match(source, /className="model-details-panel"/);
  assert.match(source, /className="model-picker-shell"/);
});

test("model picker shell keeps fixed geometry while details open beside it", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const styles = await read("../../../packages/models/widgets/styles.css");

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
    assert.match(styles, /\.model-pop\s*\{[^}]*min-height:\s*min\(560px,\s*72vh\)/s, "popover min-height matches pinned height");

    const info = document.body.querySelector<HTMLButtonElement>(".model-picker-row .model-row-info");
    assert.ok(info, "desktop rows expose the details control");
    await act(async () => { info!.click(); });

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

test("phone model details stay inside the shared sheet focus boundary", async () => {
  phoneMode = true;
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(ModelPicker, {
        models: [{ providerID: "openai", modelID: "gpt-test", name: "GPT Test" }],
        onPick: () => {},
      }));
    });
    await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
    const sheet = document.body.querySelector<HTMLElement>(".model-sheet");
    assert.ok(sheet, "phone picker uses the shared modal sheet");
    const info = sheet!.querySelector<HTMLButtonElement>(".sheet-row-info");
    assert.ok(info, "the sheet row exposes details");
    await act(async () => { info!.click(); });
    assert.ok(sheet!.querySelector(".model-details"), "details replace the list inside the existing sheet");
    assert.equal(document.body.querySelector(".model-details-panel"), null, "no sibling portal escapes the modal");
    assert.ok(sheet!.contains(document.activeElement), "details move focus to a control inside the sheet");
  } finally {
    phoneMode = false;
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

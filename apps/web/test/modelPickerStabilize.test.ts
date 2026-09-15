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
    assert.match(document.body.querySelector(".sheet-empty")?.textContent ?? "", /loading/i);
    assert.doesNotMatch(document.body.textContent ?? "", /no models found/i);
  } finally {
    phoneMode = false;
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
    const sheet = document.body.querySelector<HTMLElement>(".model-sheet");
    assert.ok(sheet, "phone picker uses the shared modal sheet");
    assert.ok(sheet!.classList.contains("sheet-tall"), "small harness catalogs use the stable tall sheet");
    assert.equal(sheet!.querySelector(".sheet-row-info"), null, "the sheet row does not expose an info control");
    assert.ok(sheet!.querySelector(".model-thinking-trigger"), "the sheet row exposes thinking effort in the former info slot");

    await render(Array.from({ length: 10 }, (_, index) => ({
      harnessId: "claude",
      providerID: "anthropic",
      modelID: `claude-${index}`,
      name: `Claude ${index}`,
    })), "claude");
    assert.equal(document.body.querySelector(".model-sheet"), sheet, "switching harnesses keeps the same open phone surface");
    assert.ok(sheet!.classList.contains("sheet-tall"), "large harness catalogs keep the same tall sheet mode");

    await render([], "claude", true);
    assert.equal(document.body.querySelector(".model-sheet"), sheet, "loading updates reuse the open phone surface");
    assert.ok(sheet!.classList.contains("sheet-tall"), "loading and empty states keep the same tall sheet mode");
    assert.match(sheet!.textContent ?? "", /loading/i);
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

test("every harness catalog uses the same desktop and phone picker height modes", async () => {
  const source = await read("../../../packages/models/widgets/ModelPicker.tsx");
  const styles = await read("../../../packages/models/widgets/styles.css");
  assert.doesNotMatch(source, /compactCatalog|--model-pop-rows|model-pop--compact/);
  assert.match(source, /className=\{phone \? "model-sheet" : "model-pop"\}/);
  assert.match(source, /sheetSize="tall"/);
  assert.doesNotMatch(styles, /\.model-pop--compact/);
  assert.match(styles, /\.model-pop\s*\{[^}]*height:\s*min\(560px,\s*72vh\)/s);
});

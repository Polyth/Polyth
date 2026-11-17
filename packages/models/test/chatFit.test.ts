import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ModelDescriptor, ModelRef } from "@polyth/contracts";
import { chatOverflowsModel } from "../widgets/chatFit.ts";

test("chatOverflowsModel: overflows smaller window", () => {
  // 128k window has 10% reserve (12,800), latest is 115,200.
  assert.equal(
    chatOverflowsModel({ usage: 150_000, modelLimit: 128_000, currentLimit: 200_000 }),
    true,
  );
  // 64k window has 10% reserve (6,400), latest is 57,600.
  assert.equal(
    chatOverflowsModel({ usage: 150_000, modelLimit: 64_000, currentLimit: 200_000 }),
    true,
  );
  // Boundary: usage exactly equal to latest
  assert.equal(
    chatOverflowsModel({ usage: 115_200, modelLimit: 128_000, currentLimit: 200_000 }),
    true,
  );
  // When currentLimit is undefined, any model whose latest threshold is exceeded overflows
  assert.equal(
    chatOverflowsModel({ usage: 150_000, modelLimit: 128_000, currentLimit: undefined }),
    true,
  );
});

test("chatOverflowsModel: fits", () => {
  // Usage well below compactionLatestTokens (115,200)
  assert.equal(
    chatOverflowsModel({ usage: 100_000, modelLimit: 128_000, currentLimit: 200_000 }),
    false,
  );
  assert.equal(
    chatOverflowsModel({ usage: 50_000, modelLimit: 64_000, currentLimit: 200_000 }),
    false,
  );
  assert.equal(
    chatOverflowsModel({ usage: 0, modelLimit: 128_000, currentLimit: 200_000 }),
    false,
  );
});

test("chatOverflowsModel: larger-or-equal window never marks", () => {
  // Equal window: 200k -> 200k, even if usage >= latest (latest is 180_000 for 200k)
  assert.equal(
    chatOverflowsModel({ usage: 190_000, modelLimit: 200_000, currentLimit: 200_000 }),
    false,
  );
  // Larger window: 200k -> 1M
  assert.equal(
    chatOverflowsModel({ usage: 190_000, modelLimit: 1_000_000, currentLimit: 200_000 }),
    false,
  );
  assert.equal(
    chatOverflowsModel({ usage: 950_000, modelLimit: 1_000_000, currentLimit: 200_000 }),
    false,
  );
});

test("chatOverflowsModel: unknown limit/usage never marks", () => {
  assert.equal(chatOverflowsModel({ usage: undefined, modelLimit: 128_000, currentLimit: 200_000 }), false);
  assert.equal(chatOverflowsModel({ usage: NaN, modelLimit: 128_000, currentLimit: 200_000 }), false);
  assert.equal(chatOverflowsModel({ usage: Infinity, modelLimit: 128_000, currentLimit: 200_000 }), false);
  assert.equal(chatOverflowsModel({ usage: 150_000, modelLimit: undefined, currentLimit: 200_000 }), false);
  assert.equal(chatOverflowsModel({ usage: 150_000, modelLimit: NaN, currentLimit: 200_000 }), false);
  assert.equal(chatOverflowsModel({ usage: 150_000, modelLimit: Infinity, currentLimit: 200_000 }), false);
  // modelLimit below COMPACTION_RESERVE_MIN_TOKENS (4,000)
  assert.equal(chatOverflowsModel({ usage: 5_000, modelLimit: 3_000, currentLimit: 200_000 }), false);
});

const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    get matches() { return false; },
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

test("ModelPicker render: smaller-window row shows the mark and selected row does not", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../widgets/ModelPicker.tsx");

  const catalogModels: ModelDescriptor[] = [
    {
      providerID: "test",
      modelID: "model-200k",
      name: "Model 200k",
      context: 200_000,
    },
    {
      providerID: "test",
      modelID: "model-1m",
      name: "Model 1M",
      context: 1_000_000,
    },
    {
      providerID: "test",
      modelID: "model-128k",
      name: "Model 128k",
      context: 128_000,
    },
    {
      providerID: "test",
      modelID: "model-64k",
      name: "Model 64k",
      context: 64_000,
    },
  ];

  const selectedValue: ModelRef = {
    providerID: "test",
    modelID: "model-200k",
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        createElement(ModelPicker, {
          models: catalogModels,
          value: selectedValue,
          usage: 150_000,
          onPick: () => {},
        }),
      );
    });

    // Open the picker
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click();
    });

    const rows = Array.from(document.body.querySelectorAll(".model-picker-row"));
    assert.ok(rows.length >= 4, `expected at least 4 rows, got ${rows.length}`);

    // Selected row (model-200k) should NOT show .model-row-fit
    const row200k = document.body.querySelector('[id="model-option-test/model-200k"]');
    assert.ok(row200k, "row200k found");
    assert.equal(row200k?.querySelector(".model-row-fit"), null, "selected row must not show fit mark");

    // 1M row should NOT show .model-row-fit
    const row1m = document.body.querySelector('[id="model-option-test/model-1m"]');
    assert.ok(row1m, "row1m found");
    assert.equal(row1m?.querySelector(".model-row-fit"), null, "larger model row must not show fit mark");

    // 128k row SHOULD show .model-row-fit
    const row128k = document.body.querySelector('[id="model-option-test/model-128k"]');
    assert.ok(row128k, "row128k found");
    assert.ok(row128k?.querySelector(".model-row-fit"), "128k row should show fit mark");
    assert.equal(row128k?.querySelector(".model-row-fit")?.textContent, "Chat won't fit");

    // 64k row SHOULD show .model-row-fit
    const row64k = document.body.querySelector('[id="model-option-test/model-64k"]');
    assert.ok(row64k, "row64k found");
    assert.ok(row64k?.querySelector(".model-row-fit"), "64k row should show fit mark");

    // Rows must remain selectable (no aria-disabled)
    assert.equal(row128k?.getAttribute("aria-disabled"), null, "row128k should not have aria-disabled");
    assert.equal(row64k?.getAttribute("aria-disabled"), null, "row64k should not have aria-disabled");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

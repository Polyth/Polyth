// Regression guard for model picker stabilization: no Manage/Auto tabs in the
// harness header, catalog never swaps for in-overlay details, adjacent panel.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window();
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("harness picker header omits Manage and Auto tabs", async () => {
  const source = await read("../../../packages/harness-runtime/widgets/index.tsx");
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

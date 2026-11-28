// The composer chip, mounted in a DOM: it appears only for a caution and
// follows its preference; the models seam returns this package's annotation
// while the source is registered (the models package tests the drawing).
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  MutationObserver: dom.MutationObserver,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
document.documentElement.lang = "en";

register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: PrivacyChip } = await import("../widgets/PrivacyChip.tsx");
const { getModelPrivacyPrefs, updateModelPrivacyPrefs } = await import("../widgets/prefs.ts");
const { privacyAnnotations } = await import("../widgets/presentation.ts");
const { modelAnnotations, registerModelAnnotationSource } = await import("@polyth/models/model-annotations");

const FREE = { input: 0, output: 0 };

const mount = async (node: ReturnType<typeof createElement>) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
};

test("chip shows for a model that may train on data, links the source, and hides when turned off", async () => {
  updateModelPrivacyPrefs({ composerChip: true });
  const view = await mount(createElement(PrivacyChip, { model: { providerID: "opencode", modelID: "big-pickle", cost: FREE } }));
  try {
    const chip = view.container.querySelector("a.model-privacy-chip");
    assert.ok(chip !== null, view.container.innerHTML.slice(0, 200));
    assert.equal(chip?.getAttribute("data-policy"), "may-improve");
    assert.equal(chip?.getAttribute("href"), "https://opencode.ai/docs/console/models/");
    assert.equal(chip?.getAttribute("rel"), "noopener noreferrer");
    assert.match(chip?.textContent ?? "", /Data may train the model/);
    await act(async () => { updateModelPrivacyPrefs({ composerChip: false }); });
    assert.equal(view.container.querySelector(".model-privacy-chip") === null, true);
  } finally {
    updateModelPrivacyPrefs({ composerChip: true });
    await view.unmount();
  }
});

test("no chip for zero-retention, unverified or other providers", async () => {
  for (const model of [
    { providerID: "opencode", modelID: "hy4-flash-free", cost: FREE },
    { providerID: "opencode", modelID: "brand-new-free", cost: FREE },
    { providerID: "anthropic", modelID: "claude-sonnet", cost: { input: 3, output: 15 } },
  ]) {
    const view = await mount(createElement(PrivacyChip, { model }));
    try {
      assert.equal(view.container.querySelector(".model-privacy-chip") === null, true, model.modelID);
    } finally {
      await view.unmount();
    }
  }
});

test("the models seam returns this package's annotation and forgets it on dispose", () => {
  const off = registerModelAnnotationSource({
    id: "model-privacy",
    annotate: (model) => privacyAnnotations(model, "en", getModelPrivacyPrefs()),
  });
  try {
    const iceman = { providerID: "opencode", modelID: "iceman-free", cost: FREE };
    const [found] = modelAnnotations(iceman);
    assert.equal(found?.sourceId, "model-privacy");
    assert.equal(found?.tone, "warning");
    assert.equal(found?.inline, true);
    assert.equal(found?.label, "Kept and used for training");
    off();
    assert.equal(modelAnnotations(iceman).length, 0);
  } finally {
    off();
  }
});

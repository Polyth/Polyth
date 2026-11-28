// The model-annotation seam: packages register plain facts about a model and
// the models package draws them. Registry rules first, then the real marks
// and details components in a DOM.
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
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const {
  modelAnnotations,
  notifyModelAnnotationsChanged,
  registerModelAnnotationSource,
  resetModelAnnotationSources,
} = await import("../widgets/modelAnnotations.ts");
const { ModelAnnotationMarks } = await import("../widgets/ModelAnnotationMarks.tsx");
const { ModelHoverDetails } = await import("../widgets/ModelDetails.tsx");

const pickle = { harnessId: "opencode", providerID: "opencode", modelID: "big-pickle", name: "Big Pickle" };
const warn = {
  key: "privacy",
  tone: "notice" as const,
  icon: "eye" as const,
  label: "May be used to improve the model",
  heading: "Data",
  meta: "Checked 2026-11-27",
  href: "https://opencode.ai/docs/console/models/",
  inline: true,
};

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

test("sources answer per model; disposing removes only that registration", () => {
  resetModelAnnotationSources();
  const first = { id: "privacy", annotate: (m: { modelID: string }) => (m.modelID === "big-pickle" ? [warn] : []) };
  const off = registerModelAnnotationSource(first);
  assert.deepEqual(modelAnnotations(pickle).map((a) => `${a.sourceId}:${a.key}`), ["privacy:privacy"]);
  assert.equal(modelAnnotations({ providerID: "opencode", modelID: "other" }).length, 0);
  const replacement = { id: "privacy", annotate: () => [] };
  const offReplacement = registerModelAnnotationSource(replacement);
  off();
  assert.equal(modelAnnotations(pickle).length, 0, "a stale disposer must not drop the replacement");
  offReplacement();
});

test("a throwing source or unsafe link cannot break or inject into the list", () => {
  resetModelAnnotationSources();
  registerModelAnnotationSource({ id: "broken", annotate: () => { throw new Error("boom"); } });
  registerModelAnnotationSource({ id: "links", annotate: () => [{ ...warn, href: "javascript:alert(1)" }] });
  const found = modelAnnotations(pickle);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.sourceId, "links");
  assert.equal(found[0]?.href, undefined);
  resetModelAnnotationSources();
});

test("marks render beside the name and follow source changes", async () => {
  resetModelAnnotationSources();
  let inline = true;
  registerModelAnnotationSource({ id: "privacy", annotate: () => [{ ...warn, inline }] });
  const view = await mount(createElement(ModelAnnotationMarks, { model: pickle, tooltip: true }));
  try {
    const mark = view.container.querySelector(".model-annotation-mark.tone-notice");
    assert.ok(mark !== null, view.container.innerHTML.slice(0, 200));
    assert.equal(mark?.getAttribute("aria-label"), warn.label);
    assert.equal(mark?.getAttribute("tabindex"), "0");
    inline = false;
    await act(async () => { notifyModelAnnotationsChanged(); });
    assert.equal(view.container.querySelector(".model-annotation-mark") === null, true, "non-inline facts stay out of rows");
  } finally {
    await view.unmount();
    resetModelAnnotationSources();
  }
});

test("the hover card shows every annotation with its source link", async () => {
  resetModelAnnotationSources();
  registerModelAnnotationSource({ id: "privacy", annotate: () => [{ ...warn, inline: false }] });
  const view = await mount(createElement(ModelHoverDetails, { model: pickle, favorite: false }));
  try {
    const block = view.container.querySelector(".model-hover-annotations");
    assert.ok(block !== null, view.container.innerHTML.slice(0, 200));
    assert.match(block?.textContent ?? "", /May be used to improve the model/);
    assert.match(block?.textContent ?? "", /Checked 2026-11-27/);
    assert.equal(block?.querySelector("a")?.getAttribute("href"), warn.href);
    assert.equal(block?.querySelector("a")?.getAttribute("rel"), "noopener noreferrer");
  } finally {
    await view.unmount();
    resetModelAnnotationSources();
  }
});

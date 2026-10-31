// Models hidden in Settings → Harnesses → harness → Models stay out of the
// picker's list and search, except a model that is selected right now.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ModelDescriptor } from "@polyth/contracts";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const models: ModelDescriptor[] = [
  { harnessId: "pi", providerID: "opencode", modelID: "fable", name: "Claude Fable" },
  { harnessId: "pi", providerID: "opencode", modelID: "sonnet", name: "Claude Sonnet" },
  { harnessId: "pi", providerID: "openrouter", modelID: "pareto", name: "Pareto" },
  { harnessId: "pi", providerID: "openrouter", modelID: "qwen", name: "Qwen Coder" },
];

async function open(props: Record<string, unknown>) {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: ModelPicker } = await import("../../../packages/models/widgets/ModelPicker.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(ModelPicker, { models, harnessId: "pi", onPick: () => {}, ...props })); });
  await act(async () => { container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click(); });
  const names = () => [...document.body.querySelectorAll(".model-picker-row strong")].map((element) => element.firstChild?.textContent ?? "");
  const search = async (query: string) => {
    const input = document.body.querySelector<HTMLInputElement>(".model-pop-search input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, query);
      input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
  };
  return {
    names,
    search,
    empty: () => document.body.querySelector(".palette-empty")?.textContent ?? "",
    close: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

const setPrefs = async (hiddenProviders: string[], hiddenModels: string[], shownModels: string[] = []) => {
  const { replaceModelPrefs } = await import("../../../packages/models/widgets/modelPrefs.ts");
  const { defaultModelPrefs } = await import("@polyth/models");
  replaceModelPrefs({ ...defaultModelPrefs(), expandedProviders: ["pi::opencode", "pi::openrouter"], hiddenProviders, hiddenModels, shownModels });
};

test("a hidden provider and a hidden model leave the list, but the selected model stays", async () => {
  await setPrefs(["pi::openrouter"], ["pi::opencode/sonnet"]);
  const picker = await open({ value: { harnessId: "pi", providerID: "opencode", modelID: "sonnet" } });
  try {
    const listed = picker.names();
    assert.ok(listed.includes("Claude Fable"));
    assert.ok(listed.includes("Claude Sonnet"), "the selected model stays visible even though it is hidden");
    assert.ok(!listed.includes("Pareto") && !listed.includes("Qwen Coder"), "a hidden provider's models are gone");
  } finally {
    await picker.close();
  }
});

test("a model turned back on inside a provider that is off stays in the list and search", async () => {
  await setPrefs(["pi::openrouter"], [], ["pi::openrouter/qwen"]);
  const picker = await open({});
  try {
    const listed = picker.names();
    assert.ok(listed.includes("Qwen Coder"), "the model turned back on is offered");
    assert.ok(!listed.includes("Pareto"), "the provider's other models stay out");
    await picker.search("qwen");
    assert.deepEqual(picker.names(), ["Qwen Coder"]);
  } finally {
    await picker.close();
    await setPrefs([], []);
  }
});

test("hiding every model says where to bring them back, and a search for a hidden one says so", async () => {
  await setPrefs(["pi::opencode", "pi::openrouter"], []);
  const picker = await open({ emptyLabel: "Default model" });
  try {
    assert.deepEqual(picker.names().filter((name) => name !== "Default model"), []);
    assert.match(picker.empty(), /hidden from your picker/i);
    await picker.search("pareto");
    assert.match(picker.empty(), /hidden models match/i);
  } finally {
    await picker.close();
    await setPrefs([], []);
  }
});

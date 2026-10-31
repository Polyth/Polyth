// Settings → Harnesses → harness → Models: a provider switch is a bulk change
// over its models, and single models stay switchable under a provider that is
// off — so a search can bring back just the few that are needed.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { HarnessSnapshot, ModelDescriptor } from "@polyth/contracts";

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
const { default: HarnessModels } = await import("../widgets/HarnessModels.tsx");
const { getModelPrefs, replaceModelPrefs } = await import("../widgets/modelPrefs.ts");
const { defaultModelPrefs, hiddenModelMatcher } = await import("@polyth/models");

const model = (providerID: string, providerName: string, modelID: string, name: string): ModelDescriptor =>
  ({ harnessId: "pi", providerID, providerName, modelID, name });
// Enough models for the search field, across two providers.
const models: ModelDescriptor[] = [
  model("openrouter", "OpenRouter", "anthropic/claude-sonnet", "Claude Sonnet"),
  model("openrouter", "OpenRouter", "anthropic/claude-haiku", "Claude Haiku"),
  model("openrouter", "OpenRouter", "openai/gpt-5", "GPT-5"),
  model("openrouter", "OpenRouter", "qwen/qwen-coder", "Qwen Coder"),
  model("openrouter", "OpenRouter", "deepseek/deepseek-v4", "DeepSeek V4"),
  model("openrouter", "OpenRouter", "x-ai/grok-4", "Grok 4"),
  model("opencode", "OpenCode Zen", "fable", "Fable"),
  model("opencode", "OpenCode Zen", "flash", "Flash"),
  model("opencode", "OpenCode Zen", "nova", "Nova"),
];
const snapshot = { catalog: { models } } as unknown as HarnessSnapshot;

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(HarnessModels, { harnessId: "pi", snapshot })); });
  const group = (name: string) => container.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;
  const providerSwitch = (name: string) => group(name).querySelector<HTMLButtonElement>(".models-visibility-provider [role=switch]")!;
  const rows = (name: string) => [...group(name).querySelectorAll<HTMLElement>(".models-visibility-model")].map((row) => ({
    name: row.querySelector(".models-visibility-model-name")!.textContent ?? "",
    toggle: row.querySelector<HTMLButtonElement>("[role=switch]")!,
  }));
  const row = (provider: string, name: string) => rows(provider).find((entry) => entry.name === name)!;
  const count = (name: string) => group(name).querySelector(".models-visibility-provider-copy > small")!.textContent ?? "";
  const click = async (button: HTMLButtonElement) => { await act(async () => { button.click(); }); };
  const search = async (query: string) => {
    const input = container.querySelector<HTMLInputElement>(".models-visibility-search input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, query);
      input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    });
  };
  return {
    group, providerSwitch, rows, row, count, click, search,
    close: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

const pickerHides = (providerID: string, modelID: string) =>
  hiddenModelMatcher(getModelPrefs())({ harnessId: "pi", providerID, modelID });

test("turning a provider off turns its models off, and a search can bring single ones back", async () => {
  replaceModelPrefs(defaultModelPrefs());
  const page = await mount();
  try {
    await page.click(page.providerSwitch("OpenRouter"));
    assert.equal(page.providerSwitch("OpenRouter").getAttribute("aria-checked"), "false");
    assert.ok(page.rows("OpenRouter").every(({ toggle }) => toggle.getAttribute("aria-checked") === "false" && !toggle.disabled),
      "every model is off, and each one can still be switched");
    assert.match(page.count("OpenRouter"), /^0\b/);

    await page.search("claude");
    assert.deepEqual(page.rows("OpenRouter").map(({ name }) => name), ["Claude Sonnet", "Claude Haiku"]);
    await page.click(page.row("OpenRouter", "Claude Sonnet").toggle);

    assert.equal(page.row("OpenRouter", "Claude Sonnet").toggle.getAttribute("aria-checked"), "true");
    assert.equal(page.providerSwitch("OpenRouter").getAttribute("aria-checked"), "false", "the provider stays off");
    assert.match(page.count("OpenRouter"), /^1\b/);
    assert.equal(pickerHides("openrouter", "anthropic/claude-sonnet"), false);
    assert.equal(pickerHides("openrouter", "anthropic/claude-haiku"), true);
    assert.equal(pickerHides("openrouter", "openrouter/added-later"), true, "a model the provider adds later stays off");
    assert.equal(pickerHides("opencode", "fable"), false, "another provider is untouched");

    await page.search("");
    await page.click(page.providerSwitch("OpenRouter"));
    assert.ok(page.rows("OpenRouter").every(({ toggle }) => toggle.getAttribute("aria-checked") === "true"), "on again turns every model on");
    assert.deepEqual([getModelPrefs().hiddenProviders, getModelPrefs().shownModels], [[], []]);
  } finally {
    await page.close();
  }
});

test("turning a provider's last model off or on flips the provider switch with it", async () => {
  replaceModelPrefs(defaultModelPrefs());
  const page = await mount();
  try {
    for (const name of ["Fable", "Flash", "Nova"]) await page.click(page.row("OpenCode Zen", name).toggle);
    assert.equal(page.providerSwitch("OpenCode Zen").getAttribute("aria-checked"), "false");
    assert.deepEqual([getModelPrefs().hiddenProviders, getModelPrefs().hiddenModels], [["pi::opencode"], []]);

    await page.click(page.row("OpenCode Zen", "Flash").toggle);
    assert.equal(page.providerSwitch("OpenCode Zen").getAttribute("aria-checked"), "false");
    assert.deepEqual(getModelPrefs().shownModels, ["pi::opencode/flash"]);
    for (const name of ["Fable", "Nova"]) await page.click(page.row("OpenCode Zen", name).toggle);
    assert.equal(page.providerSwitch("OpenCode Zen").getAttribute("aria-checked"), "true");
    assert.deepEqual([getModelPrefs().hiddenProviders, getModelPrefs().shownModels], [[], []]);
  } finally {
    await page.close();
  }
});

// Account-scoped OpenCode provider/model visibility shares the synced blob with
// harness model prefs; it must parse defensively and be a no-op when unchanged.
test("modelVisibilityPrefs parses defensively and normalizes added providers", async () => {
  const { parseModelVisibilityPrefs } = await import("../widgets/modelVisibilityPrefs.ts");
  assert.deepEqual(parseModelVisibilityPrefs(null), {
    disabledProviders: [], disabledModels: [], addedProviders: [],
  });
  assert.deepEqual(
    parseModelVisibilityPrefs({
      disabledProviders: ["b", "a", "b", 7, ""],
      disabledModels: ["p/m", "p/m"],
      addedProviders: ["groq", { id: "groq" }, { id: "cerebras" }, { id: "" }, "zz"],
    }),
    { disabledProviders: ["a", "b"], disabledModels: ["p/m"], addedProviders: ["cerebras", "groq", "zz"] },
  );
});

test("modelVisibilityPrefs applies a server snapshot and dedupes no-op writes", async () => {
  const store = await import("../widgets/modelVisibilityPrefs.ts");
  const seen: number[] = [];
  const off = store.subscribeModelVisibilityPrefs(() => seen.push(1));
  try {
    store.replaceModelVisibilityPrefs({ disabledProviders: ["ollama"], disabledModels: [], addedProviders: [] });
    assert.deepEqual(store.getModelVisibilityPrefs().disabledProviders, ["ollama"]);
    const after = seen.length;
    // Re-applying the identical snapshot (an echo) must not notify or loop.
    store.replaceModelVisibilityPrefs({ disabledProviders: ["ollama"], disabledModels: [], addedProviders: [] });
    assert.equal(seen.length, after);

    store.setLocalProviderEnabled("ollama", true);
    assert.deepEqual(store.getModelVisibilityPrefs().disabledProviders, []);
    store.setLocalModelEnabled("openai/gpt-mini", false);
    assert.deepEqual(store.getModelVisibilityPrefs().disabledModels, ["openai/gpt-mini"]);
    // A malformed model key is ignored rather than creating an unusable entry.
    store.setLocalModelEnabled("no-slash", false);
    assert.deepEqual(store.getModelVisibilityPrefs().disabledModels, ["openai/gpt-mini"]);
  } finally {
    off();
  }
});

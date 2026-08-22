import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { ProviderCatalogDto } from "../src/api.ts";

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
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const google: ProviderCatalogDto = {
  id: "google",
  name: "Google",
  connected: true,
  enabled: true,
  models: [
    {
      providerID: "google",
      modelID: "gemini-3.1-flash-image",
      key: "google/gemini-3.1-flash-image",
      name: "Nano Banana 2",
      connected: true,
      enabled: true,
    },
    {
      providerID: "google",
      modelID: "gemini-3.1-flash-image-preview",
      key: "google/gemini-3.1-flash-image-preview",
      name: "Nano Banana 2",
      connected: true,
      enabled: true,
    },
  ],
};

(globalThis as { fetch?: unknown }).fetch = async (input: string | URL | Request) => {
  const url = String(input);
  const body = url === "/api/providers" ? [google] : [];
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { getState, setModels, setOverlay } = await import("../src/store.ts");
const { installBuiltinMiniWidgets } = await import("../src/widgets/builtinMiniWidgets.tsx");
const { default: Header } = await import("../src/components/Header.tsx");
const { default: CommandPalette } = await import("../src/components/CommandPalette.tsx");
const { default: SessionSearch } = await import("../src/components/SessionSearch.tsx");
const { default: ModelsPage } = await import("../src/components/settings/ModelsPage.tsx");
installBuiltinMiniWidgets();

async function mounted(component: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(component);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("header Search and History open visibly distinct surfaces", async () => {
  const header = await mounted(createElement(Header));
  try {
    const search = [...header.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Search");
    const history = [...header.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "History");
    assert.ok(search && history);

    await act(async () => { search.click(); });
    assert.equal(getState().overlay, "palette");
    await act(async () => { history.click(); });
    assert.equal(getState().overlay, "search");
  } finally {
    setOverlay(null);
    await header.unmount();
  }

  const searchSurface = await mounted(createElement(CommandPalette));
  try {
    assert.equal(searchSurface.container.querySelector(".palette-heading-title")?.textContent, "Search workspace");
    assert.match(searchSurface.container.textContent ?? "", /Commands, projects, sessions, and files/);
  } finally {
    await searchSurface.unmount();
  }

  const historySurface = await mounted(createElement(SessionSearch));
  try {
    assert.equal(historySurface.container.querySelector(".palette-heading-title")?.textContent, "Session history");
    assert.match(historySurface.container.textContent ?? "", /Recent sessions and conversation content/);
  } finally {
    await historySurface.unmount();
  }
});

test("Providers & Models disambiguates colliding names in the expanded provider list", async () => {
  setModels(google.models.map((model) => ({
    providerID: model.providerID,
    modelID: model.modelID,
    name: model.name,
    connected: model.connected,
  })));
  const page = await mounted(createElement(ModelsPage));
  try {
    const expand = page.container.querySelector<HTMLButtonElement>(".provider-expand");
    assert.ok(expand);
    await act(async () => { expand.click(); });
    const labels = [...page.container.querySelectorAll<HTMLElement>(".set-model-name")]
      .map((element) => element.textContent);
    assert.deepEqual(labels, [
      "Nano Banana 2 · google/gemini-3.1-flash-image",
      "Nano Banana 2 · google/gemini-3.1-flash-image-preview",
    ]);
    assert.equal(new Set(labels).size, labels.length);
  } finally {
    await page.unmount();
  }
});


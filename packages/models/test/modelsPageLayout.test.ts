import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ProviderCatalogDto } from "@polyth/session/web-api";

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

let catalog: ProviderCatalogDto[] = [];
(globalThis as { fetch?: unknown }).fetch = async (input: string | URL | Request) => {
  const url = String(input);
  const body = url.startsWith("/api/opencode/providers")
    ? catalog
    : url.startsWith("/api/providers/available")
      ? [{ id: "openai", name: "OpenAI" }]
      : url.startsWith("/api/providers/auth-capabilities")
        ? {
            revision: "test",
            authorityId: "local",
            generation: 1,
            discoveredAt: 0,
            providers: {},
            discovery: { status: "loaded", provenance: [] },
          }
        : [];
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
const { default: ModelsPage } = await import("../widgets/ModelsPage.tsx");

const google: ProviderCatalogDto = {
  id: "google",
  name: "Google",
  connected: true,
  enabled: true,
  status: "ready",
  models: [
    {
      providerID: "google",
      modelID: "gemini-flash",
      key: "google/gemini-flash",
      name: "Gemini Flash",
      connected: true,
      enabled: true,
    },
  ],
};

const mounted = async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ModelsPage));
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
};

test("empty OpenCode catalog shows a compact notice under Add provider, not a backend-down card", async () => {
  catalog = [];
  const page = await mounted();
  try {
    assert.equal(page.container.querySelector(".empty-state--panel"), null);
    assert.equal(page.container.querySelector(".provider-card"), null);
    assert.match(page.container.textContent ?? "", /No providers yet/);
    assert.match(page.container.textContent ?? "", /Add provider/);
    const list = page.container.querySelector(".provider-list");
    const org = page.container.querySelector(".provider-org-login-wrap");
    assert.ok(list && org && list.compareDocumentPosition(org) & Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(page.container.querySelector(".provider-org-login-wrap[open]"), null);
  } finally {
    await page.unmount();
  }
});

test("populated catalog renders provider cards that expand to models", async () => {
  catalog = [google];
  const page = await mounted();
  try {
    const expand = page.container.querySelector<HTMLButtonElement>(".provider-expand");
    assert.ok(expand);
    assert.equal(page.container.querySelector(".provider-name")?.textContent, "Google");
    assert.equal(page.container.querySelector(".ui-notice"), null);
    await act(async () => { expand.click(); });
    assert.equal(page.container.querySelector(".set-model-name")?.textContent, "Gemini Flash");
  } finally {
    await page.unmount();
  }
});

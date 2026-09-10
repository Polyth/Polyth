import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const requests: string[] = [];
globalThis.fetch = async (input) => {
  const path = String(input);
  requests.push(path);
  const url = new URL(path, "http://127.0.0.1:4400/");
  if (url.pathname === "/api/opencode/providers") {
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`Unexpected request: ${path}`);
};

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ModelsPage } = await import("../widgets/ModelsPage.tsx");
const { useCatalogRevision } = await import("../widgets/runtimeCatalog.ts");

const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("initial provider catalog load does not invalidate its harness settings parent", async () => {
  requests.length = 0;
  let initialRevision: number | undefined;
  let currentRevision: number | undefined;

  function Harness() {
    currentRevision = useCatalogRevision();
    initialRevision ??= currentRevision;
    return createElement(ModelsPage);
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(Harness));
      await delay(20);
    });

    assert.equal(requests.filter((path) => new URL(path, "http://127.0.0.1:4400/").pathname === "/api/opencode/providers").length, 1);
    assert.equal(currentRevision, initialRevision,
      "a read-only provider response must not evict the parent harness snapshot and remount this page");
    assert.equal(container.textContent?.includes("Loading catalog"), false);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

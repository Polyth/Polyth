import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: false,
    media: "",
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/api/browse")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          path: "/Users/demo",
          parent: "/Users",
          home: "/Users/demo",
          entries: [{ name: "polyth", path: "/Users/demo/polyth", hidden: false }],
        }),
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({}),
      text: async () => "",
    };
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ProjectFolderDialog } = await import("../src/components/ProjectFolderDialog.tsx");

test("mounted Add/Open dialog has no project classification control", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ProjectFolderDialog, { onClose: () => {} }));
  });
  try {
    const text = container.textContent ?? "";
    assert.match(text, /Open a project|Open project/);
    assert.doesNotMatch(text, /Project type/);
    assert.doesNotMatch(text, /General|Write|Research|Plan & Coordinate|Design & Explore|Build & Debug/);
    assert.equal(container.querySelector("select"), null);
    assert.ok(container.querySelector(".folder-open-btn"));
    assert.equal(container.querySelector(".folder-type-row"), null);
    assert.equal(container.querySelector(".project-type-controls"), null);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

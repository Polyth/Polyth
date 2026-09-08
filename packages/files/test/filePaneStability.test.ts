import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const contents: Record<string, string> = {
  "src/app.ts": "const total = 1;\n",
};
(globalThis as { fetch?: unknown }).fetch = async (url: string) => {
  const u = new URL(String(url), "http://localhost:3000");
  const p = u.searchParams.get("path") ?? "";
  const body: unknown = u.pathname === "/api/files/read"
    ? { path: p, content: contents[p] ?? "", truncated: false, revision: "r1" }
    : u.pathname === "/api/files/stat"
      ? { path: p, kind: "file", size: 1, revision: "r1" }
      : {};
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { resetDocsForTest, sessionCount } = await import("../widgets/editor/fileDocs.ts");
const { registerEditorSurface } = await import("../../../apps/web/src/resources/views.ts");
const { registerResourceProvider } = await import("../../../apps/web/src/resources/providers.ts");
const { fileResourceProvider } = await import("../widgets/fileProvider.ts");
const { default: FilePane } = await import("../widgets/editor/FilePane.tsx");
const { getPaneProvider } = await import("../../../apps/web/src/workspace/paneProviders.ts");

registerResourceProvider(fileResourceProvider);
registerEditorSurface((props) => createElement("div", { className: "editor-code", "data-path": props.path }));

function RerenderHarness({ path }: { path: string }) {
  const [tick, setTick] = useState(0);
  return createElement("div", null,
    createElement("button", { type: "button", "data-tick": String(tick), onClick: () => setTick((n) => n + 1) }),
    createElement(FilePane, { projectId: "p1", sessionId: null, resource: path, visible: true }),
  );
}

test("FilePane rerenders do not grow document sessions; close drops the session", async () => {
  resetDocsForTest();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(RerenderHarness, { path: "src/app.ts" }));
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  assert.equal(sessionCount(), 1);
  const button = container.querySelector("button")!;
  for (let i = 0; i < 100; i++) {
    await act(async () => { button.click(); });
  }
  assert.equal(sessionCount(), 1);
  const provider = getPaneProvider("file");
  provider?.close?.({ projectId: "p1", sessionId: null }, "src/app.ts");
  assert.equal(sessionCount(), 0);
  await act(async () => { root.unmount(); });
  container.remove();
});

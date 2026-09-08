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
  MutationObserver: (dom as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver,
  ResizeObserver: (dom as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver ?? class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  getComputedStyle: (elt: Element) =>
    (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(elt),
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

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement, useRef, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorView } = await import("@codemirror/view");
const { undo } = await import("@codemirror/commands");
const {
  openDocument,
  deleteDocument,
  resetDocumentsForTest,
  documentSessionCount,
  peekDocument,
} = await import("../src/resources/documents.ts");
const { registerResourceProvider } = await import("../src/resources/providers.ts");
const { registerPaneProvider } = await import("../src/workspace/paneProviders.ts");
const { PaneVisibilityContext } = await import("../src/workspace/paneVisibility.ts");
const PaneHost = (await import("../src/components/workspace/PaneHost.tsx")).default;
const EditorRuntime = (await import("../../../packages/editor/widgets/runtime.tsx")).default;
const { resetEditorRuntimeForTest } = await import("../../../packages/editor/widgets/runtime.tsx");
const { resolveAlert } = await import("../src/alerts.ts");

const scheme = `pane-host-${process.pid}`;
const bodies = new Map<string, string>([["note.ts", "saved"]]);
const KIND = "file";

registerResourceProvider({
  scheme,
  describe: (ref) => ({ label: ref.locator, kind: "text" }),
  read: async (ref) => ({ content: bodies.get(ref.locator) ?? "", revision: "1" }),
  write: async (ref, content) => {
    bodies.set(ref.locator, content);
    return { revision: "2" };
  },
});

function docRef(path: string) {
  return { scheme, locator: path, projectId: "p1", sessionId: null };
}

registerPaneProvider({
  kind: KIND,
  dirty: (_scope, resource) => peekDocument(docRef(resource))?.getSnapshot().dirty === true,
  discard: (_scope, resource) => { peekDocument(docRef(resource))?.discard(); },
  close: (_scope, resource) => { deleteDocument(docRef(resource)); },
  component: ({ resource, visible }) => {
    useEffect(() => {
      void openDocument(docRef(resource)).load();
    }, [resource]);
    return createElement(EditorRuntime, {
      groupId: "files",
      resource: docRef(resource),
      path: resource,
      visible,
    });
  },
});

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve(); });
}

async function mountHost(): Promise<{
  hostRef: { current: import("../src/components/workspace/PaneHost.tsx").PaneHostHandle | null };
  container: HTMLElement;
  root: ReturnType<typeof createRoot>;
}> {
  const hostRef: { current: import("../src/components/workspace/PaneHost.tsx").PaneHostHandle | null } = { current: null };
  function Harness() {
    const ref = useRef<import("../src/components/workspace/PaneHost.tsx").PaneHostHandle>(null);
    useEffect(() => { hostRef.current = ref.current; });
    return createElement(PaneVisibilityContext.Provider, { value: true },
      createElement(PaneHost, { ref, projectId: "p1", sessionId: null }),
    );
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(Harness)); });
  return { hostRef, container, root };
}

async function openDirtyNote(
  hostRef: { current: import("../src/components/workspace/PaneHost.tsx").PaneHostHandle | null },
  container: HTMLElement,
): Promise<InstanceType<typeof EditorView>> {
  await act(async () => { hostRef.current?.open(KIND, "note.ts"); });
  const handle = openDocument(docRef("note.ts"));
  await handle.load();
  await flush();
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  assert.ok(view.state.doc.length > 0);
  view.dispatch({ changes: { from: view.state.doc.length, insert: "-dirty" }, userEvent: "input" });
  assert.equal(openDocument(docRef("note.ts")).getSnapshot().dirty, true);
  return view;
}

test("PaneHost close with discard confirm drops dirty buffer on reopen", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const { hostRef, container, root } = await mountHost();
  try {
    await openDirtyNote(hostRef, container);
    await act(async () => { hostRef.current?.close(KIND, "note.ts"); });
    await act(async () => { resolveAlert(true); });
    await flush();
    assert.equal(documentSessionCount(), 0);
    await act(async () => { hostRef.current?.open(KIND, "note.ts"); });
    await flush(8);
    const reopened = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    assert.equal(reopened.state.doc.toString(), "saved");
    undo(reopened);
    assert.equal(reopened.state.doc.toString(), "saved");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("PaneHost close cancel leaves dirty buffer and tab in place", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const { hostRef, container, root } = await mountHost();
  try {
    const view = await openDirtyNote(hostRef, container);
    await act(async () => { hostRef.current?.close(KIND, "note.ts"); });
    await act(async () => { resolveAlert(false); });
    await flush(4);
    assert.equal(openDocument(docRef("note.ts")).getSnapshot().dirty, true);
    assert.equal(view.state.doc.toString(), "saved-dirty");
    assert.equal(documentSessionCount(), 1);
    assert.ok(container.querySelector(".cm-editor"));
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

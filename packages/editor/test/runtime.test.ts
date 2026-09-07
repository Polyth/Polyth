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
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { undo } = await import("@codemirror/commands");
const { resourceKey } = await import("@polyth/web-sdk");
const { openDocument, resetDocumentsForTest } = await import("../../../apps/web/src/resources/documents.ts");
const { registerResourceProvider } = await import("../../../apps/web/src/resources/providers.ts");
const {
  default: EditorRuntime,
  editorViewCount,
  resetEditorRuntimeForTest,
  retainedStateCount,
} = await import("../widgets/runtime.tsx");

const scheme = `editor-rt-${process.pid}`;
const bodies = new Map<string, string>([
  ["a.ts", "aaa"],
  ["b.ts", "bbb"],
]);

registerResourceProvider({
  scheme,
  describe: (ref) => ({ label: ref.locator, kind: "text" }),
  read: async (ref) => ({ content: bodies.get(ref.locator) ?? "", revision: "1" }),
});

function docRef(path: string) {
  return { scheme, locator: path, projectId: "p", sessionId: null };
}

async function mount(path: string) {
  const handle = openDocument(docRef(path));
  await handle.load();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(EditorRuntime, {
      docKey: resourceKey(docRef(path)),
      path,
      visible: true,
    }));
  });
  return {
    handle,
    container,
    async setPath(next: string) {
      const nextHandle = openDocument(docRef(next));
      await nextHandle.load();
      await act(async () => {
        root.render(createElement(EditorRuntime, {
          docKey: resourceKey(docRef(next)),
          path: next,
          visible: true,
        }));
      });
      return nextHandle;
    },
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("one EditorView per group; tab A→B→A restores state; discard undo is a fresh history", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const first = await mount("a.ts");
  try {
    assert.equal(editorViewCount(), 1);
    const host = first.container.querySelector(".cm-editor") ?? first.container.querySelector(".editor-code");
    assert.ok(host, "codemirror host mounted");
    const view = first.container.querySelector(".cm-content") as HTMLElement | null;
    assert.ok(view);

    // User edit on A.
    const cm = (first.container.querySelector(".cm-editor") as unknown as { cmView?: { view: import("@codemirror/view").EditorView } })
      ?? null;
    void cm;
    const { EditorView } = await import("@codemirror/view");
    const found = EditorView.findFromDOM(first.container.querySelector(".cm-editor") as HTMLElement);
    assert.ok(found, "EditorView.findFromDOM");
    found!.dispatch({ changes: { from: found!.state.doc.length, insert: "-edit" } });
    assert.equal(first.handle.getBuffer(), "aaa-edit");
    assert.equal(first.handle.getSnapshot().dirty, true);
    assert.equal(first.handle.getSnapshot().saved, "aaa");

    const b = await first.setPath("b.ts");
    assert.equal(editorViewCount(), 1);
    assert.equal(retainedStateCount() >= 1, true);
    const foundB = EditorView.findFromDOM(first.container.querySelector(".cm-editor") as HTMLElement);
    assert.equal(foundB!.state.doc.toString(), "bbb");

    await first.setPath("a.ts");
    const foundA = EditorView.findFromDOM(first.container.querySelector(".cm-editor") as HTMLElement);
    assert.equal(foundA!.state.doc.toString(), "aaa-edit");
    assert.equal(editorViewCount(), 1);

    first.handle.discard();
    const afterDiscard = EditorView.findFromDOM(first.container.querySelector(".cm-editor") as HTMLElement);
    assert.equal(afterDiscard!.state.doc.toString(), "aaa");
    undo(afterDiscard!);
    assert.equal(afterDiscard!.state.doc.toString(), "aaa", "authoritative reset is a fresh EditorState");
    void b;
  } finally {
    await first.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

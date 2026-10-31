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
const { EditorView } = await import("@codemirror/view");
const { openDocument, resetDocumentsForTest } = await import("../../../apps/web/src/resources/documents.ts");
const { registerResourceProvider } = await import("../../../apps/web/src/resources/providers.ts");
const {
  default: EditorRuntime,
  releaseEditorState,
  resetEditorRuntimeForTest,
} = await import("../widgets/runtime.tsx");

const scheme = `editor-bootstrap-${process.pid}`;
const sourceText = "# AGENTS.md\n\nProject instructions stay visible.\n";

registerResourceProvider({
  scheme,
  describe: (ref) => ({ label: ref.locator, kind: "text" }),
  read: async () => ({ content: sourceText, revision: "1" }),
});

function ref(path: string) {
  return { scheme, locator: path, projectId: "p", sessionId: null };
}

test("editor bootstraps loaded text when retained state was not seeded by the lazy runtime", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();

  const resource = ref("AGENTS.md");
  const handle = openDocument(resource);
  await handle.load();

  // Simulates the document finishing its read before the lazy editor runtime
  // registered its document bridge.
  releaseEditorState(resource);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(createElement(EditorRuntime, {
        groupId: "files",
        resource,
        path: "AGENTS.md",
        visible: true,
        authoritativeGeneration: handle.getSnapshot().authoritativeGeneration,
      }));
    });

    const editor = container.querySelector(".cm-editor") as HTMLElement | null;
    assert.ok(editor, "CodeMirror mounted");
    const view = EditorView.findFromDOM(editor);
    assert.ok(view, "EditorView found");
    assert.equal(view!.state.doc.toString(), sourceText);
    assert.equal(handle.getBuffer(), sourceText);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

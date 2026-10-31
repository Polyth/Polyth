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
const { EditorView, keymap } = await import("@codemirror/view");
const { completionStatus, startCompletion } = await import("@codemirror/autocomplete");
const { openDocument, resetDocumentsForTest } = await import("../../../apps/web/src/resources/documents.ts");
const { registerResourceProvider } = await import("../../../apps/web/src/resources/providers.ts");
const {
  default: EditorRuntime,
  resetEditorRuntimeForTest,
} = await import("../widgets/runtime.tsx");

const scheme = `editor-niceties-${process.pid}`;
const docText = "const alphabet = 1;\nalphabet\n";
const bodies = new Map<string, string>([
  ["words.ts", docText],
  ["readonly.ts", "const beta = 2;\n"],
]);

registerResourceProvider({
  scheme,
  describe: (ref) => ({ label: ref.locator, kind: "text" }),
  read: async (ref) => ({ content: bodies.get(ref.locator) ?? "", revision: "1" }),
});

function docRef(path: string) {
  return { scheme, locator: path, projectId: "p", sessionId: null };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(path: string, readOnly = false) {
  const handle = openDocument(docRef(path));
  await handle.load();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(EditorRuntime, {
      groupId: "files",
      resource: docRef(path),
      path,
      visible: true,
      readOnly,
    }));
  });
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
  assert.ok(view, "EditorView mounted");
  return {
    handle,
    container,
    view: view!,
    /** Drive text insertion through the same input-handler facet path a real
     *  DOM input event uses, so bracket-closing handlers see the insert. */
    async insert(text: string) {
      await act(async () => {
        const handlers = view!.state.facet(EditorView.inputHandler);
        const position = view!.state.selection.main.head;
        const defaultInsert = () => view!.dispatch({ changes: { from: position, to: position, insert: text } });
        const insertDefault = (): import("@codemirror/state").Transaction =>
          view!.state.update({ changes: { from: position, to: position, insert: text } });
        if (!handlers.some((handler) => handler(view!, position, position, text, insertDefault))) view!.dispatch(insertDefault());
      });
    },
    async openCompletions(expectOpen = true) {
      // startCompletion schedules a 50ms debounce and resolves the source
      // asynchronously; wait on real timers outside act so the popup builds.
      // Poll instead of one fixed sleep: a loaded host can take longer.
      startCompletion(view!);
      const deadline = Date.now() + (expectOpen ? 3000 : 200);
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await act(async () => { await flush(); });
        if (expectOpen && completionStatus(view!.state) === "active"
          && container.querySelector(".cm-completionLabel") !== null) return;
      }
    },
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("typing an opening bracket closes it and keeps the caret inside the pair", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const editor = await mount("words.ts");
  try {
    editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
    await editor.insert("(");
    assert.equal(editor.view.state.doc.toString().endsWith("()"), true);
    assert.equal(
      editor.view.state.selection.main.head,
      editor.view.state.doc.length - 1,
      "caret sits between the brackets",
    );
  } finally {
    await editor.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("completions offer an existing document word from a typed prefix", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const editor = await mount("words.ts");
  try {
    const start = editor.view.state.doc.line(2).from;
    editor.view.dispatch({ selection: { anchor: start } });
    await editor.insert("alph");
    assert.equal(editor.view.state.doc.sliceString(start, start + 4), "alph");
    await editor.openCompletions();
    assert.equal(completionStatus(editor.view.state), "active");
    const labels = [...editor.container.querySelectorAll(".cm-completionLabel")]
      .map((node) => node.textContent ?? "");
    assert.equal(labels.includes("alphabet"), true, `expected alphabet in ${JSON.stringify(labels)}`);
  } finally {
    await editor.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("a read-only editor never opens completions", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const editor = await mount("readonly.ts", true);
  try {
    assert.equal(editor.view.state.readOnly, true);
    await editor.openCompletions(false);
    assert.equal(completionStatus(editor.view.state), null);
    assert.equal(editor.container.querySelector(".cm-tooltip-autocomplete") === null, true);
  } finally {
    await editor.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("switching an editor to read-only removes completion support", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const resource = docRef("words.ts");
  const handle = openDocument(resource);
  await handle.load();
  try {
    const render = (readOnly: boolean) => createElement(EditorRuntime, {
      groupId: "files",
      resource,
      path: "words.ts",
      visible: true,
      readOnly,
    });
    await act(async () => { root.render(render(false)); });
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    startCompletion(view);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await act(async () => { await flush(); });
    assert.equal(completionStatus(view.state), "active");

    await act(async () => { root.render(render(true)); });
    const after = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    assert.equal(after.state.readOnly, true);
    assert.equal(completionStatus(after.state), null, "read-only reconfigure drops completion support");
    startCompletion(after);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await act(async () => { await flush(); });
    assert.equal(completionStatus(after.state), null, "explicit start is a no-op once read-only");
    assert.equal(container.querySelector(".cm-tooltip-autocomplete") === null, true);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("Mod-i stays free for the shell and completion keeps its own bindings", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const editor = await mount("words.ts");
  try {
    const bindings = editor.view.state.facet(keymap);
    const flat = bindings.flatMap((entry) => Array.isArray(entry) ? entry : [entry]);
    const plainModI = flat.filter((binding) => binding.key === "Mod-i" || binding.mac === "Mod-i");
    assert.equal(plainModI.length, 0, "Mod-i is not bound in the editor keymap");
    const modS = flat.filter((binding) => binding.key === "Mod-s");
    assert.equal(modS.length >= 1, true, "Mod-s stays reserved by the editor");
    const completionStart = flat.filter((binding) => binding.key === "Ctrl-Space" || binding.mac === "Alt-i");
    assert.equal(completionStart.length >= 1, true, "completion exposes its own explicit start binding");
  } finally {
    await editor.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

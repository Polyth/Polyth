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
const { EditorView } = await import("@codemirror/view");
const { openDocument, resetDocumentsForTest } = await import("../../../apps/web/src/resources/documents.ts");
const { registerResourceProvider } = await import("../../../apps/web/src/resources/providers.ts");
const {
  default: EditorRuntime,
  editorViewCount,
  editorGroupCount,
  resetEditorRuntimeForTest,
  retainedStateCount,
  holdLanguageLoadsForTest,
  releaseLanguageLoadsForTest,
  setSearchImportForTest,
  openSearchForTest,
  editorGroupSearchConfigured,
  peekRetainedState,
  editorLanguageStatus,
} = await import("../widgets/runtime.tsx");

const scheme = `editor-topo-${process.pid}`;
const GROUP = "files";
const bodies = new Map<string, string>([
  ["a.ts", "aaa"],
  ["b.ts", "bbb"],
]);

function resetBodies(): void {
  bodies.clear();
  bodies.set("a.ts", "aaa");
  bodies.set("b.ts", "bbb");
}

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
  return { scheme, locator: path, projectId: "p", sessionId: null };
}

function runtimeProps(path: string, visible: boolean, onSave?: () => void) {
  return {
    groupId: GROUP,
    resource: docRef(path),
    path,
    visible,
    onSave,
  };
}

async function mountPair() {
  const hostA = document.createElement("div");
  const hostB = document.createElement("div");
  document.body.append(hostA, hostB);
  const rootA = createRoot(hostA);
  const rootB = createRoot(hostB);
  const saves: string[] = [];
  const handleA = openDocument(docRef("a.ts"));
  const handleB = openDocument(docRef("b.ts"));
  await handleA.load();
  await handleB.load();
  await act(async () => {
    rootA.render(createElement(EditorRuntime, runtimeProps("a.ts", true, () => saves.push("a"))));
    rootB.render(createElement(EditorRuntime, runtimeProps("b.ts", false)));
  });
  return {
    hostA,
    hostB,
    rootA,
    rootB,
    handleA,
    handleB,
    saves,
    viewA: () => EditorView.findFromDOM(hostA.querySelector(".cm-editor") as HTMLElement)!,
    viewB: () => EditorView.findFromDOM(hostB.querySelector(".cm-editor") as HTMLElement)!,
    async showB() {
      await act(async () => {
        rootA.render(createElement(EditorRuntime, runtimeProps("a.ts", false)));
        rootB.render(createElement(EditorRuntime, runtimeProps("b.ts", true, () => saves.push("b"))));
      });
    },
    async showA() {
      await act(async () => {
        rootA.render(createElement(EditorRuntime, runtimeProps("a.ts", true, () => saves.push("a"))));
        rootB.render(createElement(EditorRuntime, runtimeProps("b.ts", false)));
      });
    },
    async cleanup() {
      await act(async () => { rootA.unmount(); rootB.unmount(); });
      hostA.remove();
      hostB.remove();
    },
  };
}

test("multi-instance: hidden B cannot mutate A; Mod-S saves visible doc only", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const pair = await mountPair();
  try {
    assert.equal(editorViewCount(), 1);
    pair.viewA().dispatch({ changes: { from: 3, insert: "-edit" } });
    assert.equal(pair.handleA.getBuffer(), "aaa-edit");
    assert.equal(pair.handleA.getSnapshot().dirty, true);
    assert.equal(pair.handleB.getBuffer(), "bbb");

    await pair.showB();
    assert.equal(editorViewCount(), 1);
    pair.viewB().dispatch({ changes: { from: 3, insert: "-other" } });
    assert.equal(pair.handleA.getBuffer(), "aaa-edit");
    assert.equal(pair.handleA.getSnapshot().dirty, true);
    assert.equal(pair.handleB.getBuffer(), "bbb-other");
    assert.equal(pair.handleB.getSnapshot().dirty, true);

    pair.saves.length = 0;
    const KeyEvt = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    pair.viewB().dom.dispatchEvent(new KeyEvt("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    assert.deepEqual(pair.saves, ["b"]);
  } finally {
    await pair.cleanup();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("two groupIds share two EditorViews", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const handleA = openDocument(docRef("a.ts"));
  const handleB = openDocument(docRef("b.ts"));
  await handleA.load();
  await handleB.load();
  const host1 = document.createElement("div");
  const host2 = document.createElement("div");
  document.body.append(host1, host2);
  const root1 = createRoot(host1);
  const root2 = createRoot(host2);
  try {
    await act(async () => {
      root1.render(createElement(EditorRuntime, { ...runtimeProps("a.ts", true), groupId: "g1" }));
      root2.render(createElement(EditorRuntime, { ...runtimeProps("b.ts", true), groupId: "g2" }));
    });
    assert.equal(editorGroupCount(), 2);
    assert.equal(editorViewCount(), 2);
    const v1 = EditorView.findFromDOM(host1.querySelector(".cm-editor") as HTMLElement)!;
    const v2 = EditorView.findFromDOM(host2.querySelector(".cm-editor") as HTMLElement)!;
    v1.dispatch({ changes: { from: 3, insert: "-1" } });
    assert.equal(v2.state.doc.toString(), "bbb");
    assert.equal(v1.state.doc.toString(), "aaa-1");
  } finally {
    await act(async () => { root1.unmount(); root2.unmount(); });
    host1.remove();
    host2.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("inactive discard: saved content returns without undo history", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const pair = await mountPair();
  try {
    pair.viewA().dispatch({ changes: { from: 3, insert: "-edit" } });
    await pair.showB();
    pair.handleA.discard();
    await pair.showA();
    const view = pair.viewA();
    assert.equal(view.state.doc.toString(), "aaa");
    undo(view);
    assert.equal(view.state.doc.toString(), "aaa");
  } finally {
    await pair.cleanup();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("dirty undo-to-baseline clears dirty without save", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const handle = openDocument(docRef("a.ts"));
  await handle.load();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(EditorRuntime, runtimeProps("a.ts", true)));
    });
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ changes: { from: 3, insert: "b" } });
    assert.equal(handle.getSnapshot().dirty, true);
    undo(view);
    assert.equal(handle.getSnapshot().dirty, false);
    assert.equal(handle.getBuffer(), "aaa");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("open and close clean files bounds retained state", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  for (let i = 0; i < 5; i++) {
    const path = `f${i}.ts`;
    bodies.set(path, `body-${i}`);
    const handle = openDocument(docRef(path));
    await handle.load();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(EditorRuntime, runtimeProps(path, true)));
    });
    await act(async () => { root.unmount(); });
    host.remove();
    const { deleteDocument } = await import("../../../apps/web/src/resources/documents.ts");
    deleteDocument(docRef(path));
  }
  assert.equal(retainedStateCount(), 0);
  resetEditorRuntimeForTest();
  resetDocumentsForTest();
});

test("IME ownership: composition events affect only the visible editor", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const pair = await mountPair();
  try {
    await pair.showB();
    const CompEvt = (dom as unknown as { CompositionEvent: typeof CompositionEvent }).CompositionEvent;
    pair.viewB().dom.dispatchEvent(new CompEvt("compositionstart", { bubbles: true }));
    assert.equal(pair.handleB.getSnapshot().composing, true);
    assert.equal(pair.handleA.getSnapshot().composing, false);
    pair.viewB().dom.dispatchEvent(new CompEvt("compositionend", { bubbles: true }));
    assert.equal(pair.handleB.getSnapshot().composing, false);
    assert.equal(pair.handleA.getSnapshot().composing, false);
  } finally {
    await pair.cleanup();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("inactive reload: provider revision swap replaces buffer without undo history", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const pair = await mountPair();
  try {
    pair.viewA().dispatch({ changes: { from: 3, insert: "-edit" } });
    await pair.showB();
    bodies.set("a.ts", "replaced");
    await pair.handleA.reload();
    await pair.showA();
    const view = pair.viewA();
    assert.equal(view.state.doc.toString(), "replaced");
    undo(view);
    assert.equal(view.state.doc.toString(), "replaced");
  } finally {
    await pair.cleanup();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("undo matrix: dirty survives first undo, baseline clears dirty", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const handle = openDocument(docRef("a.ts"));
  await handle.load();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(EditorRuntime, runtimeProps("a.ts", true)));
    });
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ changes: { from: 3, insert: "b" }, userEvent: "input.1" });
    assert.equal(handle.getSnapshot().dirty, true);
    assert.equal(handle.getBuffer(), "aaab");
    view.dispatch({ changes: { from: 4, insert: "c" }, userEvent: "input.2" });
    assert.equal(handle.getBuffer(), "aaabc");
    undo(view);
    assert.equal(view.state.doc.toString(), "aaab");
    assert.equal(handle.getSnapshot().dirty, true);
    undo(view);
    assert.equal(handle.getSnapshot().dirty, false);
    assert.equal(handle.getBuffer(), "aaa");
    view.dispatch({ changes: { from: 3, insert: "d" } });
    assert.equal(handle.getSnapshot().dirty, true);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("rename/move: retained state follows the new resource key", async () => {
  resetBodies();
  bodies.set("a.txt", "aaa");
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const refA = docRef("a.txt");
  const refApp = docRef("app.ts");
  const handle = openDocument(refA);
  await handle.load();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(EditorRuntime, { ...runtimeProps("a.txt", true), path: "a.txt" }));
    });
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ changes: { from: 3, insert: "-edit" } });
    assert.equal(handle.getBuffer(), "aaa-edit");
    handle.moveTo(refApp);
    assert.equal(peekRetainedState(refA), null);
    assert.ok(peekRetainedState(refApp));
    assert.equal(peekRetainedState(refApp)!.state.doc.toString(), "aaa-edit");
    await act(async () => {
      root.render(createElement(EditorRuntime, { ...runtimeProps("app.ts", true), path: "app.ts", resource: refApp }));
    });
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
    const shell = host.querySelector(".editor-code") as HTMLElement;
    assert.equal(shell.getAttribute("data-language"), "TypeScript");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("language stale apply: delayed TypeScript load does not reconfigure YAML tab", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  bodies.set("a.ts", "const x = 1;");
  bodies.set("b.yaml", "key: value\n");
  const handleA = openDocument(docRef("a.ts"));
  const handleB = openDocument(docRef("b.yaml"));
  await handleA.load();
  await handleB.load();
  holdLanguageLoadsForTest();
  const hostA = document.createElement("div");
  const hostB = document.createElement("div");
  document.body.append(hostA, hostB);
  const rootA = createRoot(hostA);
  const rootB = createRoot(hostB);
  try {
    await act(async () => {
      rootA.render(createElement(EditorRuntime, { ...runtimeProps("a.ts", true), path: "a.ts" }));
      rootB.render(createElement(EditorRuntime, { ...runtimeProps("b.yaml", false), path: "b.yaml" }));
    });
    await act(async () => {
      rootA.render(createElement(EditorRuntime, { ...runtimeProps("a.ts", false), path: "a.ts" }));
      rootB.render(createElement(EditorRuntime, { ...runtimeProps("b.yaml", true), path: "b.yaml" }));
    });
    releaseLanguageLoadsForTest();
    for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
    const bKey = `${scheme}:p::b.yaml`;
    assert.notEqual(editorLanguageStatus(bKey).label, "TypeScript");
    const shellB = hostB.querySelector(".editor-code") as HTMLElement;
    assert.notEqual(shellB.getAttribute("data-language"), "TypeScript");
  } finally {
    await act(async () => { rootA.unmount(); rootB.unmount(); });
    hostA.remove();
    hostB.remove();
    releaseLanguageLoadsForTest();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("search load failure: editor stays editable and retry works", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  setSearchImportForTest(null, true);
  const handle = openDocument(docRef("a.ts"));
  await handle.load();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(EditorRuntime, runtimeProps("a.ts", true)));
    });
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    const KeyEvt = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    await act(async () => {
      view.dom.dispatchEvent(new KeyEvt("keydown", { key: "f", ctrlKey: true, bubbles: true }));
      await Promise.resolve();
    });
    view.dispatch({ changes: { from: 3, insert: "!" }, userEvent: "input.type" });
    assert.equal(handle.getBuffer(), "aaa!");
    setSearchImportForTest(null, false);
    await act(async () => { await openSearchForTest(GROUP); });
    assert.equal(editorGroupSearchConfigured(GROUP), true);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    setSearchImportForTest(null, false);
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("close discard reopen: saved content returns without undo history", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const ref = docRef("a.ts");
  const handle = openDocument(ref);
  await handle.load();
  const host = document.createElement("div");
  document.body.appendChild(host);
  let root = createRoot(host);
  const mount = async () => {
    await act(async () => {
      root.render(createElement(EditorRuntime, runtimeProps("a.ts", true)));
    });
  };
  try {
    await mount();
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ changes: { from: 3, insert: "-edit" } });
    assert.equal(handle.getSnapshot().dirty, true);
    handle.discard();
    const { deleteDocument } = await import("../../../apps/web/src/resources/documents.ts");
    deleteDocument(ref);
    await act(async () => { root.unmount(); });
    root = createRoot(host);
    const reopenedHandle = openDocument(ref);
    await reopenedHandle.load();
    await mount();
    const reopened = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    assert.equal(reopened.state.doc.toString(), "aaa");
    undo(reopened);
    assert.equal(reopened.state.doc.toString(), "aaa");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

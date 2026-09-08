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
  localStorage: dom.localStorage,
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
const { resourceKey } = await import("@polyth/web-sdk");
const { undo, redo } = await import("@codemirror/commands");
const { EditorView } = await import("@codemirror/view");
const { openDocument, renameDocument, resetDocumentsForTest } = await import("../../../apps/web/src/resources/documents.ts");
const { setLocale } = await import("../../../apps/web/src/i18n/index.ts");
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

let writeImpl: (ref: { locator: string }, content: string) => Promise<{ revision: string }> = async (ref, content) => {
  bodies.set(ref.locator, content);
  return { revision: "2" };
};

let readImpl: (ref: { locator: string }) => Promise<{ content: string; revision: string }> = async (ref) => ({
  content: bodies.get(ref.locator) ?? "",
  revision: "1",
});

function restoreWriteImpl(): void {
  writeImpl = async (ref, content) => {
    bodies.set(ref.locator, content);
    return { revision: "2" };
  };
}

function restoreReadImpl(): void {
  readImpl = async (ref) => ({ content: bodies.get(ref.locator) ?? "", revision: "1" });
}

registerResourceProvider({
  scheme,
  describe: (ref) => ({ label: ref.locator, kind: "text" }),
  read: async (ref) => readImpl(ref),
  write: async (ref, content) => writeImpl(ref, content),
  rename: async (ref, to) => {
    const content = bodies.get(ref.locator);
    if (content === undefined) throw new Error("missing");
    bodies.delete(ref.locator);
    bodies.set(to, content);
    return { ...ref, locator: to };
  },
  remove: async (ref) => {
    bodies.delete(ref.locator);
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

test("unmounting hidden A while B is visible does not copy B into A", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const pair = await mountPair();
  try {
    pair.viewA().dispatch({ changes: { from: 3, insert: "-edit" } });
    await pair.showB();
    pair.viewB().dispatch({ changes: { from: 3, insert: "-other" } });
    await act(async () => { pair.rootA.unmount(); });
    const retainedA = peekRetainedState(docRef("a.ts"));
    assert.equal(retainedA?.state.doc.toString(), "aaa-edit");
    assert.equal(pair.handleB.getBuffer(), "bbb-other");
    const hostA = document.createElement("div");
    document.body.appendChild(hostA);
    const rootA = createRoot(hostA);
    await act(async () => {
      rootA.render(createElement(EditorRuntime, runtimeProps("a.ts", true, () => pair.saves.push("a"))));
      pair.rootB.render(createElement(EditorRuntime, runtimeProps("b.ts", false)));
    });
    const restored = EditorView.findFromDOM(hostA.querySelector(".cm-editor") as HTMLElement)!;
    assert.equal(restored.state.doc.toString(), "aaa-edit");
    undo(restored);
    assert.equal(restored.state.doc.toString(), "aaa");
    await act(async () => { rootA.unmount(); });
    hostA.remove();
  } finally {
    await pair.cleanup();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("delete then unmount hidden A while B is visible cannot resurrect A as B", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const pair = await mountPair();
  try {
    pair.viewA().dispatch({ changes: { from: 3, insert: "-edit" } });
    await pair.showB();
    pair.viewB().dispatch({ changes: { from: 3, insert: "-other" } });
    pair.handleA.discard();
    const { deleteDocument } = await import("../../../apps/web/src/resources/documents.ts");
    deleteDocument(docRef("a.ts"));
    await act(async () => { pair.rootA.unmount(); });
    assert.equal(peekRetainedState(docRef("a.ts")), null);
    const reopened = openDocument(docRef("a.ts"));
    await reopened.load();
    const hostA = document.createElement("div");
    document.body.appendChild(hostA);
    const rootA = createRoot(hostA);
    await act(async () => {
      rootA.render(createElement(EditorRuntime, runtimeProps("a.ts", true)));
      pair.rootB.render(createElement(EditorRuntime, runtimeProps("b.ts", false)));
    });
    const view = EditorView.findFromDOM(hostA.querySelector(".cm-editor") as HTMLElement)!;
    assert.equal(view.state.doc.toString(), "aaa");
    undo(view);
    assert.equal(view.state.doc.toString(), "aaa");
    await act(async () => { rootA.unmount(); });
    hostA.remove();
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
    const { deleteDocument } = await import("../../../apps/web/src/resources/documents.ts");
    deleteDocument(docRef(path));
    await act(async () => { root.unmount(); });
    host.remove();
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
    redo(view);
    assert.equal(handle.getSnapshot().dirty, true);
    assert.equal(handle.getBuffer(), "aaab");
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
    const shell = host.querySelector(".editor-code") as HTMLElement;
    for (let i = 0; i < 200 && shell.getAttribute("data-language") !== "TypeScript"; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    assert.equal(shell.getAttribute("data-language"), "TypeScript");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("rename during held save migrates retained editor state after the write settles", async () => {
  resetBodies();
  bodies.set("old.ts", "O");
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const payloads: string[] = [];
  let releaseFirst!: () => void;
  writeImpl = async (r, content) => {
    payloads.push(content);
    if (payloads.length === 1) {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    }
    bodies.set(r.locator, content);
    return { revision: `r${payloads.length + 1}` };
  };
  const from = docRef("old.ts");
  const to = docRef("new.ts");
  const handle = openDocument(from);
  await handle.load();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(EditorRuntime, { ...runtimeProps("old.ts", true), path: "old.ts" }));
    });
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "A" }, userEvent: "input" });
    const saving = handle.save();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "B" }, userEvent: "input" });
    let renamed = false;
    const renaming = renameDocument(from, "new.ts").then(() => { renamed = true; });
    await act(async () => { await Promise.resolve(); });
    assert.equal(renamed, false);
    assert.ok(peekRetainedState(from));
    assert.equal(peekRetainedState(to), null);
    assert.equal(bodies.has("old.ts"), true);
    assert.equal(bodies.has("new.ts"), false);
    releaseFirst();
    await saving;
    await renaming;
    assert.equal(peekRetainedState(from), null);
    assert.ok(peekRetainedState(to));
    assert.equal(peekRetainedState(to)!.state.doc.toString(), "B");
    assert.equal(bodies.get("new.ts"), "A");
    assert.equal(bodies.has("old.ts"), false);
    assert.equal(handle.getSnapshot().dirty, true);
    await handle.save();
    assert.equal(bodies.get("new.ts"), "B");
    assert.equal(bodies.has("old.ts"), false);
  } finally {
    restoreWriteImpl();
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
    assert.notEqual(editorLanguageStatus(resourceKey(docRef("b.yaml"))).label, "TypeScript");
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

test("locale change while the editor is alive reconfigures search phrases", async () => {
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
    assert.equal(view.state.phrase("Find"), "Find");
    await act(async () => { await setLocale("uk"); });
    assert.equal(view.state.phrase("Find"), "Знайти");
    await act(async () => { await setLocale("en"); });
    assert.equal(view.state.phrase("Find"), "Find");
  } finally {
    await setLocale("en");
    await act(async () => { root.unmount(); });
    host.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("save baseline advances independently: in-flight save A, live B, undo to A clears dirty", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  let releaseWrite!: () => void;
  const { registerResourceProvider: reg } = await import("../../../apps/web/src/resources/providers.ts");
  reg({
    scheme,
    describe: (ref) => ({ label: ref.locator, kind: "text" }),
    read: async (ref) => ({ content: bodies.get(ref.locator) ?? "", revision: "1" }),
    write: async (ref, content) => {
      await new Promise<void>((resolve) => { releaseWrite = resolve; });
      bodies.set(ref.locator, content);
      return { revision: "2" };
    },
  });

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
    assert.equal(handle.getSnapshot().saved, "aaa");
    view.dispatch({ changes: { from: 3, insert: "A" }, userEvent: "input.saveA" });
    assert.equal(handle.getBuffer(), "aaaA");
    const saving = handle.save();
    view.dispatch({ changes: { from: 4, insert: "B" }, userEvent: "input.saveB" });
    assert.equal(handle.getBuffer(), "aaaAB");
    releaseWrite();
    await saving;
    assert.equal(handle.getSnapshot().saved, "aaaA");
    assert.equal(handle.getBuffer(), "aaaAB");
    assert.equal(handle.getSnapshot().dirty, true);
    assert.notEqual(handle.autosaveDelay(true, 1500), null);
    undo(view);
    assert.equal(view.state.doc.toString(), "aaaA");
    assert.equal(handle.getSnapshot().dirty, false);
    redo(view);
    assert.equal(handle.getSnapshot().dirty, true);
    assert.equal(handle.getBuffer(), "aaaAB");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
    reg({
      scheme,
      describe: (ref) => ({ label: ref.locator, kind: "text" }),
      read: async (ref) => ({ content: bodies.get(ref.locator) ?? "", revision: "1" }),
      write: async (ref, content) => {
        bodies.set(ref.locator, content);
        return { revision: "2" };
      },
    });
  }
});

function viewWrapEnabled(view: { dom: HTMLElement }): boolean {
  return view.dom.classList.contains("cm-lineWrapping");
}

async function waitForLanguage(path: string, label: string): Promise<void> {
  const key = resourceKey(docRef(path));
  for (let i = 0; i < 400 && editorLanguageStatus(key).label !== label; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
  assert.equal(editorLanguageStatus(key).label, label);
}

async function mountWithConfig(
  path: string,
  opts: { wrap?: boolean; ariaLabel?: string; groupId?: string; visible?: boolean } = {},
) {
  const handle = openDocument(docRef(path));
  await handle.load();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const groupId = opts.groupId ?? GROUP;
  const render = () => createElement(EditorRuntime, {
    ...runtimeProps(path, opts.visible ?? true),
    groupId,
    wrap: opts.wrap,
    ariaLabel: opts.ariaLabel,
    authoritativeGeneration: handle.getSnapshot().authoritativeGeneration,
  });
  await act(async () => { root.render(render()); });
  const view = () => EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
  return {
    handle,
    host,
    root,
    view,
    async rerender() { await act(async () => { root.render(render()); }); },
  };
}

test("active discard preserves TypeScript, wrap=false, and aria-label", async () => {
  resetBodies();
  bodies.set("app.ts", "const x = 1;");
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const mounted = await mountWithConfig("app.ts", { wrap: false, ariaLabel: "test editor" });
  try {
    await waitForLanguage("app.ts", "TypeScript");
    assert.equal(viewWrapEnabled(mounted.view()), false);
    assert.equal(mounted.view().contentDOM.getAttribute("aria-label"), "test editor");
    mounted.view().dispatch({ changes: { from: mounted.view().state.doc.length, insert: "\n// edit" } });
    mounted.handle.discard();
    await mounted.rerender();
    await waitForLanguage("app.ts", "TypeScript");
    assert.equal(mounted.view().state.doc.toString(), "const x = 1;");
    undo(mounted.view());
    assert.equal(mounted.view().state.doc.toString(), "const x = 1;");
    assert.equal(editorLanguageStatus(resourceKey(docRef("app.ts"))).label, "TypeScript");
    assert.equal(viewWrapEnabled(mounted.view()), false);
    assert.equal(mounted.view().contentDOM.getAttribute("aria-label"), "test editor");
    assert.equal(peekRetainedState(docRef("app.ts"))?.searchConfigured, false);
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.host.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("active reload preserves TypeScript, wrap=false, and aria-label", async () => {
  resetBodies();
  bodies.set("app.ts", "const x = 1;");
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const mounted = await mountWithConfig("app.ts", { wrap: false, ariaLabel: "reload editor" });
  try {
    await waitForLanguage("app.ts", "TypeScript");
    mounted.view().dispatch({ changes: { from: mounted.view().state.doc.length, insert: "\n// edit" } });
    bodies.set("app.ts", "const x = 2;");
    await mounted.handle.reload();
    await mounted.rerender();
    await waitForLanguage("app.ts", "TypeScript");
    assert.equal(mounted.view().state.doc.toString(), "const x = 2;");
    undo(mounted.view());
    assert.equal(mounted.view().state.doc.toString(), "const x = 2;");
    assert.equal(editorLanguageStatus(resourceKey(docRef("app.ts"))).label, "TypeScript");
    assert.equal(viewWrapEnabled(mounted.view()), false);
    assert.equal(mounted.view().contentDOM.getAttribute("aria-label"), "reload editor");
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.host.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("inactive reload preserves binding config", async () => {
  resetBodies();
  bodies.set("app.ts", "const x = 1;");
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const handle = openDocument(docRef("app.ts"));
  await handle.load();
  const hostB = document.createElement("div");
  document.body.appendChild(hostB);
  const rootB = createRoot(hostB);
  try {
    await act(async () => {
      rootB.render(createElement(EditorRuntime, {
        ...runtimeProps("app.ts", true),
        groupId: "g2",
        wrap: false,
        ariaLabel: "reload test",
        authoritativeGeneration: handle.getSnapshot().authoritativeGeneration,
      }));
    });
    const view = EditorView.findFromDOM(hostB.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ changes: { from: view.state.doc.length, insert: "\n// edit" } });
    bodies.set("app.ts", "const x = 2;");
    await handle.reload();
    await act(async () => {
      rootB.render(createElement(EditorRuntime, {
        ...runtimeProps("app.ts", true),
        groupId: "g2",
        wrap: false,
        ariaLabel: "reload test",
        authoritativeGeneration: handle.getSnapshot().authoritativeGeneration,
      }));
    });
    const after = EditorView.findFromDOM(hostB.querySelector(".cm-editor") as HTMLElement)!;
    assert.equal(after.state.doc.toString(), "const x = 2;");
    undo(after);
    assert.equal(after.state.doc.toString(), "const x = 2;");
    assert.equal(viewWrapEnabled(after), false);
    assert.equal(after.contentDOM.getAttribute("aria-label"), "reload test");
  } finally {
    await act(async () => { rootB.unmount(); });
    hostB.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("authoritative reset during delayed language load does not misconfigure editor", async () => {
  resetBodies();
  bodies.set("app.ts", "const x = 1;");
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  holdLanguageLoadsForTest();
  const mounted = await mountWithConfig("app.ts", { wrap: false, ariaLabel: "race test" });
  try {
    mounted.view().dispatch({ changes: { from: mounted.view().state.doc.length, insert: "\n// edit" } });
    mounted.handle.discard();
    await mounted.rerender();
    releaseLanguageLoadsForTest();
    await waitForLanguage("app.ts", "TypeScript");
    assert.equal(mounted.view().state.doc.toString(), "const x = 1;");
    assert.equal(viewWrapEnabled(mounted.view()), false);
    assert.equal(mounted.view().contentDOM.getAttribute("aria-label"), "race test");
  } finally {
    releaseLanguageLoadsForTest();
    await act(async () => { mounted.root.unmount(); });
    mounted.host.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("same resource in two groups: one writable owner; g2 read-only; unmount g2 keeps source", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const resource = docRef("a.ts");
  const handle = openDocument(resource);
  await handle.load();
  const host1 = document.createElement("div");
  const host2 = document.createElement("div");
  document.body.append(host1, host2);
  const root1 = createRoot(host1);
  const root2 = createRoot(host2);
  try {
    await act(async () => {
      root1.render(createElement(EditorRuntime, { ...runtimeProps("a.ts", true), groupId: "g1" }));
      root2.render(createElement(EditorRuntime, { ...runtimeProps("a.ts", true), groupId: "g2" }));
    });
    const v1 = EditorView.findFromDOM(host1.querySelector(".cm-editor") as HTMLElement)!;
    const v2 = EditorView.findFromDOM(host2.querySelector(".cm-editor") as HTMLElement)!;
    assert.equal(v2.state.readOnly, true);
    v1.dispatch({ changes: { from: 3, insert: "X" } });
    assert.equal(handle.getBuffer(), "aaaX");
    v2.dispatch({ changes: { from: 3, insert: "Y" } });
    assert.equal(handle.getBuffer(), "aaaX");
    await act(async () => { root2.unmount(); });
    assert.equal(handle.getBuffer(), "aaaX");
    v1.dispatch({ changes: { from: 4, insert: "!" } });
    assert.equal(handle.getBuffer(), "aaaX!");
    await handle.save();
    assert.equal(bodies.get("a.ts"), "aaaX!");
    await act(async () => { root1.unmount(); });
  } finally {
    host1.remove();
    host2.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("non-owner group cannot save or toggle composing", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const resource = docRef("a.ts");
  const handle = openDocument(resource);
  await handle.load();
  const host1 = document.createElement("div");
  const host2 = document.createElement("div");
  document.body.append(host1, host2);
  const root1 = createRoot(host1);
  const root2 = createRoot(host2);
  const g1Saves: string[] = [];
  const g2Saves: string[] = [];
  const KeyEvt = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  const CompEvt = (dom as unknown as { CompositionEvent: typeof CompositionEvent }).CompositionEvent;
  try {
    await act(async () => {
      root1.render(createElement(EditorRuntime, {
        ...runtimeProps("a.ts", true, () => g1Saves.push("g1")),
        groupId: "g1",
      }));
      root2.render(createElement(EditorRuntime, {
        ...runtimeProps("a.ts", true, () => g2Saves.push("g2")),
        groupId: "g2",
      }));
    });
    const v1 = EditorView.findFromDOM(host1.querySelector(".cm-editor") as HTMLElement)!;
    const v2 = EditorView.findFromDOM(host2.querySelector(".cm-editor") as HTMLElement)!;
    assert.equal(v2.state.readOnly, true);
    v2.dom.dispatchEvent(new KeyEvt("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    assert.deepEqual(g2Saves, []);
    assert.deepEqual(g1Saves, []);
    assert.equal(handle.getSnapshot().composing, false);
    v2.dom.dispatchEvent(new CompEvt("compositionstart", { bubbles: true }));
    assert.equal(handle.getSnapshot().composing, false);
    v2.dom.dispatchEvent(new CompEvt("compositionend", { bubbles: true }));
    assert.equal(handle.getSnapshot().composing, false);
    v1.dom.dispatchEvent(new KeyEvt("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    assert.deepEqual(g1Saves, ["g1"]);
    assert.deepEqual(g2Saves, []);
    await act(async () => { root2.unmount(); });
    v1.dispatch({ changes: { from: 3, insert: "Z" } });
    assert.equal(handle.getBuffer(), "aaaZ");
    await act(async () => { root1.unmount(); });
    const lease = handle.attachSource({ getText: () => "leased" });
    assert.ok(lease, "unmounting the owner releases the source lease");
    lease?.();
  } finally {
    host1.remove();
    host2.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("Mod-S during an in-flight write does not start a second provider.write", async () => {
  resetBodies();
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const payloads: string[] = [];
  let releaseWrite!: () => void;
  const { registerResourceProvider: reg } = await import("../../../apps/web/src/resources/providers.ts");
  reg({
    scheme,
    describe: (ref) => ({ label: ref.locator, kind: "text" }),
    read: async (ref) => ({ content: bodies.get(ref.locator) ?? "", revision: "1" }),
    write: async (ref, content) => {
      payloads.push(content);
      if (payloads.length === 1) {
        await new Promise<void>((resolve) => { releaseWrite = resolve; });
      }
      bodies.set(ref.locator, content);
      return { revision: String(payloads.length + 1) };
    },
  });
  const handle = openDocument(docRef("a.ts"));
  await handle.load();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const KeyEvt = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
  try {
    await act(async () => {
      root.render(createElement(EditorRuntime, runtimeProps("a.ts", true, () => { void handle.save(); })));
    });
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ changes: { from: 3, insert: "A" } });
    const saving = handle.save();
    view.dispatch({ changes: { from: 4, insert: "C" } });
    view.dom.dispatchEvent(new KeyEvt("keydown", { key: "s", ctrlKey: true, bubbles: true }));
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0], "aaaA");
    releaseWrite();
    await saving;
    assert.equal(handle.getSnapshot().saved, "aaaA");
    assert.equal(handle.getBuffer(), "aaaAC");
    assert.equal(handle.getSnapshot().dirty, true);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
    reg({
      scheme,
      describe: (ref) => ({ label: ref.locator, kind: "text" }),
      read: async (ref) => ({ content: bodies.get(ref.locator) ?? "", revision: "1" }),
      write: async (ref, content) => {
        bodies.set(ref.locator, content);
        return { revision: "2" };
      },
    });
  }
});

test("rename README.md to README.txt drops markdown capability", async () => {
  resetBodies();
  bodies.set("README.md", "# Title\n");
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const refMd = docRef("README.md");
  const refTxt = docRef("README.txt");
  const handle = openDocument(refMd);
  await handle.load();
  const mounted = await mountWithConfig("README.md");
  try {
    for (let i = 0; i < 400 && editorLanguageStatus(resourceKey(refMd)).label !== "Markdown"; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    assert.equal(editorLanguageStatus(resourceKey(refMd)).label, "Markdown");
    handle.moveTo(refTxt);
    await act(async () => {
      mounted.root.render(createElement(EditorRuntime, {
        ...runtimeProps("README.txt", true),
        resource: refTxt,
        path: "README.txt",
        authoritativeGeneration: handle.getSnapshot().authoritativeGeneration,
      }));
    });
    for (let i = 0; i < 200 && editorLanguageStatus(resourceKey(refTxt)).label === "Markdown"; i++) {
      await act(async () => { await Promise.resolve(); });
    }
    assert.notEqual(editorLanguageStatus(resourceKey(refTxt)).label, "Markdown");
    assert.equal(peekRetainedState(refMd), null);
  } finally {
    await act(async () => { mounted.root.unmount(); });
    mounted.host.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("stale load after close/reopen does not reset the live EditorState", async () => {
  resetBodies();
  bodies.set("race.ts", "OLD");
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  let first = true;
  let releaseRead!: (result: { content: string; revision: string }) => void;
  let startedRead!: () => void;
  const started = new Promise<void>((resolve) => { startedRead = resolve; });
  readImpl = async (ref) => {
    if (first) {
      first = false;
      startedRead();
      return await new Promise<{ content: string; revision: string }>((resolve) => { releaseRead = resolve; });
    }
    return { content: bodies.get(ref.locator) ?? "", revision: "2" };
  };
  const { registerResourceProvider: reg } = await import("../../../apps/web/src/resources/providers.ts");
  const { deleteDocument } = await import("../../../apps/web/src/resources/documents.ts");
  reg({
    scheme,
    describe: (ref) => ({ label: ref.locator, kind: "text" }),
    read: async (ref) => readImpl(ref),
    write: async (ref, content) => writeImpl(ref, content),
    rename: async (ref, to) => {
      const content = bodies.get(ref.locator);
      if (content === undefined) throw new Error("missing");
      bodies.delete(ref.locator);
      bodies.set(to, content);
      return { ...ref, locator: to };
    },
    remove: async (ref) => { bodies.delete(ref.locator); },
  });
  const raceRef = docRef("race.ts");
  const s1 = openDocument(raceRef);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await started;
    deleteDocument(raceRef);
    bodies.set("race.ts", "NEW");
    const s2 = openDocument(raceRef);
    await s2.load();
    await act(async () => {
      root.render(createElement(EditorRuntime, runtimeProps("race.ts", true)));
    });
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
    assert.equal(view.state.doc.toString(), "NEW");
    view.dispatch({ changes: { from: 3, insert: "+edit" } });
    assert.equal(s2.getBuffer(), "NEW+edit");
    const gen = s2.getSnapshot().authoritativeGeneration;
    const retainedGen = peekRetainedState(raceRef)?.generation;
    releaseRead({ content: "OLD", revision: "1" });
    await s1.load();
    await act(async () => { await Promise.resolve(); });
    assert.equal(s2.getSnapshot().saved, "NEW");
    assert.equal(s2.getSnapshot().authoritativeGeneration, gen);
    assert.equal(peekRetainedState(raceRef)?.generation, retainedGen);
    assert.equal(view.state.doc.toString(), "NEW+edit");
    undo(view);
    assert.equal(view.state.doc.toString(), "NEW");
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    restoreReadImpl();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

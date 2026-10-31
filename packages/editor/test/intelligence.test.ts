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
const { EditorView, activateHover, closeHoverTooltips } = await import("@codemirror/view");
const { acceptCompletion, closeCompletion, completionStatus, currentCompletions, selectedCompletionIndex, setSelectedCompletion, startCompletion } = await import("@codemirror/autocomplete");
const { forceLinting } = await import("@codemirror/lint");
const { openDocument, resetDocumentsForTest } = await import("../../../apps/web/src/resources/documents.ts");
const { registerResourceProvider } = await import("../../../apps/web/src/resources/providers.ts");
const { listSlots, registerSlot, subscribeSlots } = await import("../../../apps/web/src/slots.ts");
const {
  bindEditorIntelligenceSlots,
  editorIntelligenceProvidersFor,
  notifyEditorIntelligenceChanged,
  validateEditorIntelligenceProvider,
} = await import("../widgets/intelligence.ts");
const {
  default: EditorRuntime,
  resetEditorRuntimeForTest,
} = await import("../widgets/runtime.tsx");

const scheme = `editor-intelligence-${process.pid}`;
const bodies = new Map<string, string>([
  ["app.ts", "const alphabet = 1;\nalphabet\n"],
  ["plain.txt", "hello world\n"],
]);
registerResourceProvider({
  scheme,
  describe: (ref) => ({ label: ref.locator, kind: "text" }),
  read: async (ref) => ({ content: bodies.get(ref.locator) ?? "", revision: "3" }),
});

function docRef(path: string) {
  return { scheme, locator: path, projectId: "p", sessionId: null };
}

/** The real slot registry is the source of truth; the editor reacts to its
 *  subscription exactly as it would to a host that exposes one. */
const unbind = bindEditorIntelligenceSlots({
  list: (slot) => listSlots(slot),
  subscribe: subscribeSlots,
});

/** Poll a DOM/state predicate instead of sleeping a fixed time. */
async function until(predicate: () => boolean, label: string, timeout = 4000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  assert.ok(predicate(), `timed out waiting for ${label}`);
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
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

const providerFor = (language: string, overrides: Record<string, unknown> = {}) => ({
  id: `fake.${language}`,
  languages: [language],
  ...overrides,
});

test("a provider's completions appear and apply their insertText", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  let calls = 0;
  const off = registerSlot("editor.intelligence", "fake", () => null, 0, {
    provider: providerFor("TypeScript", {
      completions: async () => {
        calls++;
        return {
        from: { line: 1, character: 0 },
        items: [
          { label: "alphabetSymbol", kind: "variable", detail: "const" },
          { label: "alphabetValue", kind: "function", detail: "() => string", insertText: "alphabetValue()" },
        ],
        };
      },
    }),
  });
  const editor = await mount("app.ts");
  try {
    const line = editor.view.state.doc.line(2);
    editor.view.dispatch({ selection: { anchor: line.to } });
    startCompletion(editor.view);
    await until(
      () => completionStatus(editor.view.state) === "active"
        && editor.container.querySelector(".cm-completionLabel") !== null,
      "the provider completion popup",
    );
    assert.equal(completionStatus(editor.view.state), "active");
    await until(
      () => [...editor.container.querySelectorAll(".cm-completionLabel")]
        .some((node) => node.textContent === "alphabetValue"),
      "the provider completion item",
    );
    assert.equal(calls > 0, true, "the provider answered");
    const labels = [...editor.container.querySelectorAll(".cm-completionLabel")].map((node) => node.textContent);
    assert.ok(labels.includes("alphabetSymbol"), JSON.stringify(labels));
    assert.ok(labels.includes("alphabetValue"), JSON.stringify(labels));

    const details = [...editor.container.querySelectorAll(".cm-completionDetail")].map((node) => node.textContent);
    assert.ok(details.includes("const"), JSON.stringify(details));

    // The provider items keep their order (no explicit sortText, so the
    // label orders them: alphabetSymbol before alphabetValue).
    const ordered = currentCompletions(editor.view.state)
      .map((option, index) => ({ label: option.label, index }))
      .filter((option) => option.label.startsWith("alphabetS") || option.label.startsWith("alphabetV"));
    assert.deepEqual(ordered.map((option) => option.label), ["alphabetSymbol", "alphabetValue"]);

    // The provider item with an explicit insertText replaces the typed word.
    // The completion popup refuses acceptance during its 75ms interaction
    // delay, so wait it out instead of racing it.
    editor.view.dispatch({ effects: setSelectedCompletion(ordered[1]!.index) });
    await until(() => selectedCompletionIndex(editor.view.state) === ordered[1]!.index, "the selected provider item");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 90)); });
    assert.equal(
      acceptCompletion(editor.view),
      true,
      "the completion was accepted",
    );
    await until(
      () => editor.view.state.doc.line(2).text === "alphabetValue()",
      "the applied insertText",
    );
    assert.equal(editor.view.state.doc.line(2).text, "alphabetValue()");
  } finally {
    off();
    await editor.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("hover renders the signature in the mono voice and documentation as plain text", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const documentation = 'See <img src=x onerror="window.__pwned = true"> for details';
  const off = registerSlot("editor.intelligence", "fake", () => null, 0, {
    provider: providerFor("TypeScript", {
      hover: async () => ({
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
        display: "const alphabet: number",
        documentation,
      }),
    }),
  });
  const editor = await mount("app.ts");
  try {
    const position = editor.view.state.doc.line(2).from;
    activateHover(editor.view, position, 1);
    await until(
      () => editor.container.querySelector(".cm-tooltip-hover") !== null,
      "the hover tooltip",
    );
    const tooltip = editor.container.querySelector(".cm-tooltip-hover");
    assert.ok(tooltip);
    assert.equal(tooltip!.querySelector(".editor-intelligence-hover-display")?.textContent, "const alphabet: number");
    const docs = tooltip!.querySelector(".editor-intelligence-hover-documentation");
    assert.equal(docs?.textContent, documentation, "documentation is plain text, not markup");
    assert.equal(tooltip!.querySelector("img"), null, "docs must not be parsed as HTML");
    assert.ok(docs?.className.includes("editor-intelligence-hover-documentation"));
    assert.equal((globalThis as { __pwned?: boolean }).__pwned, undefined);
  } finally {
    editor.view.dispatch({ effects: closeHoverTooltips });
    off();
    await editor.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("diagnostics paint lint ranges and a gutter marker", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const off = registerSlot("editor.intelligence", "fake", () => null, 0, {
    provider: providerFor("TypeScript", {
      diagnostics: async () => [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: "error", message: "bad const", code: 1234 },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } }, severity: "warning", message: "unused variable" },
      ],
    }),
  });
  const editor = await mount("app.ts");
  try {
    forceLinting(editor.view);
    await until(
      () => editor.container.querySelector(".cm-lintRange-error") !== null,
      "the error lint range",
    );
    assert.ok(Boolean(editor.container.querySelector(".cm-lintRange-error")), "error range decoration");
    assert.ok(Boolean(editor.container.querySelector(".cm-lintRange-warning")), "warning range decoration");
    assert.ok(Boolean(editor.container.querySelector(".cm-lint-marker-error")), "lint gutter marker");
    assert.ok(Boolean(editor.container.querySelector(".cm-gutter-lint")), "lint gutter");
    assert.ok(Boolean(editor.container.querySelector(".cm-lint-marker-warning")), "warning gutter marker");
  } finally {
    off();
    await editor.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("a read-only buffer gets hover and problems but never completions", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  let completionCalls = 0;
  const off = registerSlot("editor.intelligence", "fake", () => null, 0, {
    provider: providerFor("TypeScript", {
      completions: async () => {
        completionCalls++;
        return {
          from: { line: 1, character: 0 },
          items: [{ label: "alphabet", kind: "variable" }],
        };
      },
      hover: async () => ({
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
        display: "const alphabet: number",
      }),
      diagnostics: async () => [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: "error", message: "readonly problem" },
      ],
    }),
  });
  const editor = await mount("app.ts", true);
  try {
    assert.equal(editor.view.state.readOnly, true);
    startCompletion(editor.view);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    assert.equal(completionStatus(editor.view.state), null);
    assert.equal(editor.container.querySelector(".cm-tooltip-autocomplete") === null, true);
    assert.equal(completionCalls, 0, "a read-only buffer never asks the provider");

    const position = editor.view.state.doc.line(2).from;
    activateHover(editor.view, position, 1);
    await until(() => editor.container.querySelector(".cm-tooltip-hover") !== null, "the read-only hover tooltip");
    assert.equal(
      editor.container.querySelector(".editor-intelligence-hover-display")?.textContent,
      "const alphabet: number",
    );

    forceLinting(editor.view);
    await until(() => editor.container.querySelector(".cm-lintRange-error") !== null, "the read-only problem");
    assert.ok(Boolean(editor.container.querySelector(".cm-lint-marker-error")), "read-only lint gutter marker");
  } finally {
    editor.view.dispatch({ effects: closeHoverTooltips });
    off();
    await editor.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("a provider for another language is ignored", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  let asked = 0;
  const off = registerSlot("editor.intelligence", "fake", () => null, 0, {
    provider: providerFor("Python", {
      completions: async () => {
        asked++;
        return { from: { line: 1, character: 0 }, items: [{ label: "pythonOnly", kind: "function" }] };
      },
      hover: async () => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, display: "python" }),
      diagnostics: async () => {
        asked++;
        return [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: "error", message: "python" }];
      },
    }),
  });
  const editor = await mount("app.ts");
  try {
    const line = editor.view.state.doc.line(2);
    editor.view.dispatch({ selection: { anchor: line.to } });
    startCompletion(editor.view);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    const labels = [...editor.container.querySelectorAll(".cm-completionLabel")].map((node) => node.textContent);
    assert.equal(labels.includes("pythonOnly"), false, JSON.stringify(labels));
    assert.equal(asked, 0, "an unrelated language never reaches the provider");

    forceLinting(editor.view);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    assert.equal(editor.container.querySelector(".cm-lintRange-error") === null, true);
    assert.equal(editor.container.querySelector(".cm-gutter-lint") === null, true);

    activateHover(editor.view, line.from, 1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    assert.equal(editor.container.querySelector(".cm-tooltip-hover") === null, true);
    assert.equal(asked, 0, "an unrelated language never reaches the provider");
  } finally {
    off();
    await editor.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("removing a registration removes the completions, hover and problems", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  let completionCalls = 0;
  let hoverCalls = 0;
  let lintCalls = 0;
  const off = registerSlot("editor.intelligence", "fake", () => null, 0, {
    provider: providerFor("TypeScript", {
      // An empty prefix at the cursor: provider completions replace every other
      // source, so the popup must open on the provider's own result.
      completions: async (request) => {
        completionCalls++;
        return { from: request.position, items: [{ label: "alpha", kind: "variable" }] };
      },
      hover: async () => {
        hoverCalls++;
        return { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, display: "alpha" };
      },
      diagnostics: async () => {
        lintCalls++;
        return [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: "error", message: "gone soon" }];
      },
    }),
  });
  const editor = await mount("app.ts");
  try {
    forceLinting(editor.view);
    await until(() => editor.container.querySelector(".cm-lintRange-error") !== null, "the initial problem");
    assert.equal(lintCalls > 0, true);

    const line = editor.view.state.doc.line(2);
    editor.view.dispatch({ selection: { anchor: line.to } });
    startCompletion(editor.view);
    await until(() => completionStatus(editor.view.state) === "active", "the initial completion popup");
    assert.equal(completionCalls > 0, true);
    closeCompletion(editor.view);

    activateHover(editor.view, line.from, 1);
    await until(() => editor.container.querySelector(".cm-tooltip-hover") !== null, "the initial hover");
    assert.equal(hoverCalls > 0, true);
    editor.view.dispatch({ effects: closeHoverTooltips });

    const completionsBefore = completionCalls;
    const hoversBefore = hoverCalls;
    const lintsBefore = lintCalls;
    off();
    await until(() => editor.container.querySelector(".cm-lintRange-error") === null, "the problem to clear");
    await until(
      () => editor.container.querySelectorAll(".cm-lint-marker").length === 0,
      "the lint gutter markers to clear",
    );
    assert.equal(editor.container.querySelectorAll(".cm-lint-marker").length, 0, "no lint gutter markers remain");

    forceLinting(editor.view);
    startCompletion(editor.view);
    activateHover(editor.view, line.from, 1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    assert.equal(completionCalls, completionsBefore, "no completions after removal");
    assert.equal(hoverCalls, hoversBefore, "no hover after removal");
    assert.equal(lintCalls, lintsBefore, "no diagnostics after removal");
    assert.equal(editor.container.querySelector(".cm-tooltip-hover") === null, true, "hover is removed with the provider");
    const labels = [...editor.container.querySelectorAll(".cm-completionLabel")].map((node) => node.textContent);
    assert.equal(labels.includes("alpha"), false, "the provider completion is gone");
  } finally {
    closeCompletion(editor.view);
    editor.view.dispatch({ effects: closeHoverTooltips });
    await editor.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("a host without a slot subscription is told to re-read through the change event", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  // Rebind to a source with no `subscribe` (the current host shape): the editor
  // can only learn about a registration change from the window event a provider
  // package dispatches.
  const unbindSubscribe = bindEditorIntelligenceSlots({ list: (slot) => listSlots(slot) });
  const editor = await mount("app.ts");
  let hoverCalls = 0;
  const off = registerSlot("editor.intelligence", "fake", () => null, 0, {
    provider: providerFor("TypeScript", {
      hover: async () => {
        hoverCalls++;
        return {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
          display: "const alphabet: number",
        };
      },
    }),
  });
  try {
    // Registered after the buffer mounted and nothing announced it: the editor
    // is still running the provider-less configuration.
    activateHover(editor.view, editor.view.state.doc.line(2).from, 1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    assert.equal(hoverCalls, 0, "no re-read without an announcement");
    assert.equal(editor.container.querySelector(".cm-tooltip-hover") === null, true);

    notifyEditorIntelligenceChanged();
    activateHover(editor.view, editor.view.state.doc.line(2).from, 1);
    await until(
      () => editor.container.querySelector(".cm-tooltip-hover") !== null,
      "the hover after the change announcement",
    );
    assert.equal(hoverCalls > 0, true);
    assert.equal(
      editor.container.querySelector(".editor-intelligence-hover-display")?.textContent,
      "const alphabet: number",
    );
  } finally {
    editor.view.dispatch({ effects: closeHoverTooltips });
    off();
    unbindSubscribe();
    await editor.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("a provider that throws or returns the wrong shape never breaks the editor", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const off = registerSlot("editor.intelligence", "throwing", () => null, 0, {
    provider: providerFor("TypeScript", {
      completions: () => { throw new Error("sync boom"); },
      hover: () => { throw new Error("sync boom"); },
      diagnostics: () => { throw new Error("sync boom"); },
    }),
  });
  const editor = await mount("app.ts");
  try {
    const line = editor.view.state.doc.line(2);
    editor.view.dispatch({ selection: { anchor: line.to } });
    startCompletion(editor.view);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    forceLinting(editor.view);
    activateHover(editor.view, line.from, 1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    // The built-in completion word source still works; the provider's failure
    // simply contributes nothing and the editor stays alive.
    assert.equal(editor.container.querySelector(".cm-tooltip-hover") === null, true);
    assert.equal(editor.container.querySelector(".cm-lintRange-error") === null, true);
    assert.equal(editor.view.state.doc.toString(), "const alphabet = 1;\nalphabet\n");
  } finally {
    closeCompletion(editor.view);
    off();
    await editor.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test("an invalid contribution is ignored instead of breaking the editor", async () => {
  assert.equal(validateEditorIntelligenceProvider(null), null);
  assert.equal(validateEditorIntelligenceProvider({ id: "x" }), null);
  assert.equal(validateEditorIntelligenceProvider({ id: "x", languages: [] }), null);
  assert.equal(validateEditorIntelligenceProvider({ id: "x", languages: ["TypeScript"] }), null);
  assert.equal(validateEditorIntelligenceProvider({ id: "x", languages: ["TypeScript"], hover: 3 }), null);
  const valid = validateEditorIntelligenceProvider({ id: "x", languages: ["TypeScript"], hover: async () => null });
  assert.ok(valid);
  assert.equal(valid!.id, "x");

  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const off = registerSlot("editor.intelligence", "broken", () => null, 0, { provider: { id: "broken" } });
  assert.deepEqual(editorIntelligenceProvidersFor("TypeScript"), [], "an invalid payload registers nothing");
  const editor = await mount("app.ts");
  try {
    assert.equal(editor.container.querySelector(".cm-gutter-lint") === null, true, "no lint gutter from a broken provider");
    forceLinting(editor.view);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
    assert.equal(editor.container.querySelector(".cm-lintRange-error") === null, true);
  } finally {
    off();
    await editor.unmount();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

test.after(() => {
  unbind();
});

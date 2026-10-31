import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
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
const { EditorState, Text } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { openDocument, resetDocumentsForTest } = await import("../../../apps/web/src/resources/documents.ts");
const { registerResourceProvider } = await import("../../../apps/web/src/resources/providers.ts");
const { default: EditorRuntime, resetEditorRuntimeForTest } = await import("../widgets/runtime.tsx");
const { buildChangeMarks, changeMarksExtension, changeMarksField, setChangeMarks } = await import("../widgets/changeMarks.ts");
type ChangeSet = import("../../../apps/web/src/resources/views.ts").EditorChangeSet;

const scheme = `editor-changes-${process.pid}`;
const bodies = new Map<string, string>([["a.ts", "a\nB\nc\n"]]);
registerResourceProvider({
  scheme,
  describe: (ref) => ({ label: ref.locator, kind: "text" }),
  read: async (ref) => ({ content: bodies.get(ref.locator) ?? "", revision: "1" }),
});
const ref = (path: string) => ({ scheme, locator: path, projectId: "p", sessionId: null });

function changeSet(baseText: string, actions: Array<[string, string]> = []): ChangeSet {
  return {
    key: `k:${baseText.length}`,
    baseText,
    tones: [
      { color: "var(--session-tone-0)", label: "Changed by This chat", attributed: true },
      { color: "var(--session-tone-none)", label: "Not from a chat", attributed: false },
    ],
    hunks: [{
      id: "0:abcd1234",
      lines: [{ line: 2, tone: 0 }],
      removed: [{ line: 2, text: ["b"], tone: 0 }],
      anchorLine: 2,
      label: "Changed by This chat",
    }],
    actions: { undo: "Undo", keep: "Keep", inspect: "Show change" },
    labels: { moreRemoved: "{count} more" },
    onAction: (hunkId, action) => actions.push([hunkId, action]),
  };
}

test("marks: tinted changed lines, an in-place removed block and one gutter bar per changed line", () => {
  const doc = Text.of(["a", "B", "c", ""]);
  const marks = buildChangeMarks(doc, changeSet(doc.toString()));
  const found: string[] = [];
  marks.deco.between(0, doc.length, (from, _to, value) => {
    const spec = value.spec as { class?: string; block?: boolean; widget?: unknown };
    found.push(spec.block ? `block@${from}` : spec.class ? `${spec.class}@${from}` : `widget@${from}`);
  });
  assert.deepEqual(found.sort(), ["block@2", "cm-change-line cm-change-attributed cm-change-anchor@2", "widget@3"].sort());
  let bars = 0;
  marks.bars.between(0, doc.length, () => { bars++; });
  assert.equal(bars, 1);
  // A change nobody the owner tracks made keeps only its tint and bar.
  const set = changeSet(doc.toString());
  const plain = buildChangeMarks(doc, { ...set, hunks: set.hunks.map((hunk) => ({ ...hunk, plain: true })) });
  let actionWidgets = 0;
  plain.deco.between(0, doc.length, (_from, _to, value) => {
    const spec = value.spec as { block?: boolean; widget?: unknown; class?: string };
    if (spec.widget && !spec.block) actionWidgets++;
  });
  assert.equal(actionWidgets, 0);
});

test("marks follow typing and clear on a null set", () => {
  const doc = "a\nB\nc\n";
  let state = EditorState.create({ doc, extensions: [changeMarksExtension] });
  state = state.update({ effects: setChangeMarks.of(changeSet(doc)) }).state;
  state = state.update({ changes: { from: 0, insert: "zero\n" } }).state;
  const lines: number[] = [];
  state.field(changeMarksField).deco.between(0, state.doc.length, (from, _to, value) => {
    if ((value.spec as { class?: string }).class) lines.push(state.doc.lineAt(from).number);
  });
  assert.deepEqual(lines, [3], "the changed line moved down with the insertion");
  state = state.update({ effects: setChangeMarks.of(null) }).state;
  assert.equal(state.field(changeMarksField).key, null);
});

test("the runtime draws an owner's change set over the matching text and routes inline actions", async () => {
  resetDocumentsForTest();
  resetEditorRuntimeForTest();
  const handle = openDocument(ref("a.ts"));
  await handle.load();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const actions: Array<[string, string]> = [];
  const render = async (changes: ChangeSet | null) => {
    await act(async () => {
      root.render(createElement(EditorRuntime, { groupId: "files", resource: ref("a.ts"), path: "a.ts", visible: true, changes }));
    });
  };
  try {
    await render(changeSet("something else\n", actions));
    assert.equal(container.querySelector(".cm-change-attributed"), null, "a set for other text is never drawn");

    await render(changeSet("a\nB\nc\n", actions));
    const line = container.querySelector(".cm-change-attributed") as HTMLElement | null;
    assert.ok(line);
    assert.equal(line.textContent?.startsWith("B"), true);
    assert.match(line.getAttribute("style") ?? "", /--change-tone: var\(--session-tone-0\)/);
    const removed = container.querySelector(".cm-change-removed");
    assert.equal(removed?.querySelector(".cm-change-removed-line")?.textContent, "b");
    assert.ok(container.querySelector(".cm-change-gutter .cm-change-bar"));
    const keep = container.querySelector(".cm-change-action[data-action='keep']") as HTMLButtonElement | null;
    assert.equal(keep?.textContent, "Keep");
    keep!.click();
    assert.deepEqual(actions, [["0:abcd1234", "keep"]]);

    await render(null);
    assert.equal(container.querySelector(".cm-change-attributed"), null);
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement);
    assert.equal(view?.state.field(changeMarksField).key, null);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    resetEditorRuntimeForTest();
    resetDocumentsForTest();
  }
});

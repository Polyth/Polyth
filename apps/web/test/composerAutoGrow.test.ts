// Composer auto-grow measures on an inert twin and writes the editor's height
// only when it changes. The transcript observes the composer dock's style
// mutations and refreshes its follow geometry synchronously for each one, so
// a keystroke that leaves the height alone must leave the DOM alone too.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, { window: dom, document: dom.document, Element: dom.Element, Node: dom.Node });

// Layout stub: one 20px line per text line plus 8px padding.
Object.defineProperty(dom.HTMLTextAreaElement.prototype, "scrollHeight", {
  configurable: true,
  get(this: HTMLTextAreaElement) { return 8 + 20 * Math.max(1, this.value.split("\n").length); },
});

const { applyComposerEditorHeight, measureComposerEditor } = await import("../src/composerAutoGrow.ts");

function editorIn() {
  const dock = document.createElement("div");
  dock.className = "composer-input";
  const editor = document.createElement("textarea");
  editor.className = "composer-editor";
  editor.setAttribute("rows", "3");
  editor.setAttribute("placeholder", "Message");
  dock.append(editor);
  document.body.append(dock);
  return { dock, editor };
}

async function recordsDuring(target: Node, action: () => void): Promise<MutationRecord[]> {
  const records: MutationRecord[] = [];
  const observer = new dom.MutationObserver((batch) => { records.push(...(batch as unknown as MutationRecord[])); });
  observer.observe(target as never, { subtree: true, childList: true, attributes: true, characterData: true });
  action();
  await new Promise((resolve) => setTimeout(resolve, 0));
  records.push(...(observer.takeRecords() as unknown as MutationRecord[]));
  observer.disconnect();
  return records;
}

test("the editor is measured on an inert twin beside it, never resized to measure", async () => {
  const { dock, editor } = editorIn();
  editor.value = "one\ntwo";
  editor.style.height = "50px";
  assert.equal(measureComposerEditor(editor, false), 48);
  assert.equal(editor.style.height, "50px", "the live editor keeps its height while measuring");
  const twin = editor.nextElementSibling as HTMLTextAreaElement;
  assert.ok(twin?.hasAttribute("data-composer-measure"));
  assert.equal(twin.getAttribute("aria-hidden"), "true");
  assert.ok(twin.hasAttribute("inert"));
  assert.equal(twin.getAttribute("class"), "composer-editor", "same classes, same cascade");
  assert.equal(twin.getAttribute("rows"), "3");
  assert.equal(twin.style.position, "absolute");
  assert.equal(twin.style.visibility, "hidden");
  assert.equal(dock.querySelectorAll("textarea").length, 2);
  dock.remove();
});

test("a keystroke that keeps the height mutates nothing", async () => {
  const { dock, editor } = editorIn();
  editor.value = "hello";
  applyComposerEditorHeight(editor, measureComposerEditor(editor, false) + 2);
  const records = await recordsDuring(dock, () => {
    editor.value = "hello there";
    applyComposerEditorHeight(editor, measureComposerEditor(editor, false) + 2);
  });
  assert.deepEqual(records.map((record) => `${record.type}:${record.attributeName ?? ""}`), []);
  const grown = await recordsDuring(dock, () => {
    editor.value = "hello\nthere";
    applyComposerEditorHeight(editor, measureComposerEditor(editor, false) + 2);
  });
  assert.deepEqual(grown.map((record) => `${record.type}:${record.attributeName ?? ""}`), ["attributes:style"],
    "a new line writes the editor's height once");
  assert.equal(editor.style.height, "50px");
  dock.remove();
});

test("a remounted editor replaces its old twin instead of leaving one behind", () => {
  const { dock, editor } = editorIn();
  measureComposerEditor(editor, false);
  editor.remove();
  const next = document.createElement("textarea");
  next.className = "composer-editor";
  dock.prepend(next);
  measureComposerEditor(next, true);
  assert.equal(dock.querySelectorAll("[data-composer-measure]").length, 1);
  assert.equal(next.nextElementSibling?.hasAttribute("data-composer-measure"), true);
  assert.equal((next.nextElementSibling as HTMLElement).style.height, "0px", "a phone measures from zero");
  dock.remove();
});

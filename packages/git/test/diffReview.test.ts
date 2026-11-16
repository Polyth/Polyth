import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
});
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  MutationObserver: dom.MutationObserver,
  KeyboardEvent: dom.KeyboardEvent,
  Event: dom.Event,
  ResizeObserver: dom.ResizeObserver,
  getComputedStyle: (element: Element) => (dom as unknown as { getComputedStyle(el: Element): CSSStyleDeclaration }).getComputedStyle(element),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id: number) => clearTimeout(id) });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement, useRef, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { parseDiffLines } = await import("../widgets/diffLines.ts");
const { lineCommentMarkdown, commentTarget } = await import("../widgets/diffComment.ts");
const { ChangesetSearch, stepMatch } = await import("../widgets/diffFind.ts");
const { DiffContent } = await import("../widgets/DiffViewer.tsx");
const { DiffCommentsProvider } = await import("../widgets/DiffComments.tsx");
const { useChangesFind } = await import("../widgets/ChangesFind.tsx");
const { tr } = await import("../../../apps/web/src/i18n/index.ts");

const delay = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,5 @@",
  " const one = 1;",
  "-const two = 2;",
  "+const two = 22;",
  "+const Three = 3;",
  " const four = 4;",
].join("\n");

// ── Pure decisions ───────────────────────────────────────────────────

test("a single-line comment is path:line, the diff line, then the text", () => {
  const lines = parseDiffLines(DIFF);
  const added = lines.filter((line) => line.kind === "add");
  const markdown = lineCommentMarkdown({ path: "src/a.ts", lines: [added[0]!], text: " rename this " });
  assert.equal(markdown, "src/a.ts:2\n\n```diff\n+const two = 22;\n```\n\nrename this");
});

test("a range names start-end and keeps at most five diff lines", () => {
  const body = Array.from({ length: 8 }, (_, i) => ({ kind: "add" as const, text: `line ${i}`, newLine: 10 + i }));
  assert.equal(commentTarget("x.ts", body), "x.ts:10-17");
  const markdown = lineCommentMarkdown({ path: "x.ts", lines: body, text: "why?" });
  assert.equal(markdown.split("\n").filter((row) => row.startsWith("+")).length, 5);
  assert.ok(markdown.startsWith("x.ts:10-17\n"));
  const fenced = lineCommentMarkdown({ path: "x.ts", lines: [{ kind: "ctx", text: "``` tick", oldLine: 1, newLine: 1 }], text: "t" });
  assert.ok(fenced.includes("````diff"), "a longer fence protects backticks in the code");
});

test("find counts add/del/context text only, case-insensitively by default", () => {
  const search = new ChangesetSearch("three", false, ["a"]);
  search.add("a", DIFF);
  assert.equal(search.step(1000), true);
  assert.equal(search.total, 1);
  const sensitive = new ChangesetSearch("three", true, ["a"]);
  sensitive.add("a", DIFF);
  sensitive.step(1000);
  assert.equal(sensitive.total, 0, "match case is a toggle");
  const headers = new ChangesetSearch("diff --git", false, ["a"]);
  headers.add("a", DIFF);
  headers.step(1000);
  assert.equal(headers.total, 0, "file headers and hunk headers are not diff text");
  const many = new ChangesetSearch("const", false, ["b", "a"]);
  many.add("a", DIFF);
  many.add("b", DIFF);
  many.step(1000);
  assert.equal(many.total, 10);
  assert.deepEqual([...new Set(many.matches().map((match) => match.file))], ["b", "a"], "files keep the caller's order");
});

test("next/previous wrap around", () => {
  assert.equal(stepMatch(-1, 3, 1), 0);
  assert.equal(stepMatch(-1, 3, -1), 2);
  assert.equal(stepMatch(2, 3, 1), 0);
  assert.equal(stepMatch(0, 3, -1), 2);
  assert.equal(stepMatch(0, 0, 1), -1);
});

test("a 5k-line changeset is searched in slices that never hold the thread for 50 ms", () => {
  const files = Array.from({ length: 10 }, (_, f) => {
    const rows = Array.from({ length: 500 }, (_, i) => `${i % 3 === 0 ? "+" : i % 3 === 1 ? "-" : " "}const value${f}_${i} = compute(${i}); // needle ${i % 7 === 0 ? "NEEDLE" : "hay"}`);
    return { key: `f${f}`, diff: [`diff --git a/f${f}.ts b/f${f}.ts`, `--- a/f${f}.ts`, `+++ b/f${f}.ts`, "@@ -1,500 +1,500 @@", ...rows].join("\n") };
  });
  const search = new ChangesetSearch("needle", false, files.map((file) => file.key));
  for (const file of files) search.add(file.key, file.diff);
  let slices = 0;
  let worst = 0;
  const started = performance.now();
  for (;;) {
    const before = performance.now();
    const done = search.step(8);
    worst = Math.max(worst, performance.now() - before);
    slices += 1;
    if (done) break;
  }
  const total = performance.now() - started;
  assert.equal(search.total, files.length * (500 + Math.ceil(500 / 7)));
  assert.ok(worst < 50, `worst slice ${worst.toFixed(1)} ms`);
  console.log(`find: 5000 lines, ${slices} slices, worst ${worst.toFixed(1)} ms, total ${total.toFixed(1)} ms`);
});

test("a tiny budget yields between slices and still finds everything", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => `+needle ${i}`);
  const diff = ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -0,0 +1,1000 @@", ...rows].join("\n");
  const search = new ChangesetSearch("needle", false, ["x", "y"]);
  search.add("x", diff);
  search.add("y", diff);
  let slices = 0;
  while (!search.step(0)) slices += 1;
  assert.ok(slices > 3, `${slices} slices`);
  assert.equal(search.total, 2000);
});

// ── Components ───────────────────────────────────────────────────────

const passthrough = (tag: string, drop: string[] = []) => (props: Record<string, unknown>) => {
  const rest = { ...props };
  for (const key of ["size", "variant", "uiSize", "icon", "label", ...drop]) delete rest[key];
  return createElement(tag, props.label ? { ...rest, "aria-label": props.label } : rest);
};
const inserted: string[] = [];
const host = {
  conversation: { insert: (text: string) => { inserted.push(text); } },
  ui: {
    components: { Button: passthrough("button"), IconButton: passthrough("button"), TextInput: passthrough("input"), Textarea: passthrough("textarea") },
    iconSet: { ChevronUpIcon: () => null, ChevronDownIcon: () => null, CloseIcon: () => null },
    locale: { get: () => "en", translate: (key: string, values?: Record<string, string | number>) => tr(key as never, values as never) },
  },
} as never;

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); await delay(40); });
  return { container, async close() { await act(async () => { root.unmount(); }); container.remove(); } };
}
const type = async (field: Element, value: string) => {
  const proto = field.tagName === "TEXTAREA" ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
    await delay(5);
  });
};
const key = async (target: Element, init: { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) => {
  const event = new dom.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => { target.dispatchEvent(event as unknown as Event); await delay(5); });
  return event;
};
const click = async (target: Element | null, init: { shiftKey?: boolean } = {}) => {
  assert.ok(target !== null, "target must exist");
  await act(async () => { target.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true, ...init }) as unknown as Event); await delay(5); });
};

test("each diff line has a keyboard-reachable Comment button named with path and line", async () => {
  const view = await mount(createElement(DiffCommentsProvider, { value: host }, createElement(DiffContent, { diff: DIFF, path: "src/a.ts", split: false, wrap: false })));
  const buttons = [...view.container.querySelectorAll<HTMLButtonElement>(".git-diff-comment-btn")];
  assert.equal(buttons.length, 5, "two context rows, a delete and two adds");
  assert.equal(buttons[2]!.getAttribute("aria-label"), "Comment on src/a.ts line 2");
  assert.equal(buttons[0]!.tagName, "BUTTON");
  assert.ok(buttons.every((button) => button.type === "button"), "real buttons");
  // One tab stop for the whole diff (a long diff would otherwise be hundreds
  // of Tab presses); arrows move between rows and the stop follows focus.
  assert.deepEqual(buttons.map((button) => button.tabIndex), [0, -1, -1, -1, -1]);
  await act(async () => { buttons[0]!.focus(); await delay(5); });
  await key(buttons[0]!, { key: "ArrowDown" });
  assert.equal(document.activeElement === buttons[1], true, "ArrowDown focuses the next row's button");
  await key(buttons[1]!, { key: "End" });
  assert.equal(document.activeElement === buttons[4], true, "End focuses the last row's button");
  const after = [...view.container.querySelectorAll<HTMLButtonElement>(".git-diff-comment-btn")];
  assert.deepEqual(after.map((button) => button.tabIndex), [-1, -1, -1, -1, 0], "the tab stop follows focus");
  await view.close();
});

test("no host or session means no comment buttons", async () => {
  const view = await mount(createElement(DiffCommentsProvider, { value: null }, createElement(DiffContent, { diff: DIFF, path: "src/a.ts", split: false, wrap: false })));
  assert.equal(view.container.querySelectorAll(".git-diff-comment-btn").length, 0);
  await view.close();
});

test("a comment is inserted as the block, empty is disabled, several append, Esc cancels", async () => {
  inserted.length = 0;
  const view = await mount(createElement(DiffCommentsProvider, { value: host }, createElement(DiffContent, { diff: DIFF, path: "src/a.ts", split: false, wrap: false })));
  const buttons = () => [...view.container.querySelectorAll<HTMLButtonElement>(".git-diff-comment-btn")];
  await click(buttons()[2]!);
  const editor = () => view.container.querySelector(".git-diff-comment-editor");
  assert.equal(editor() !== null, true);
  const add = () => [...view.container.querySelectorAll<HTMLButtonElement>(".git-diff-comment-editor button")].find((button) => button.textContent === "Add to message")!;
  assert.equal(add().disabled, true, "empty comment is disabled");
  await type(view.container.querySelector(".git-diff-comment-editor textarea")!, "   ");
  assert.equal(add().disabled, true, "whitespace is empty too");
  await type(view.container.querySelector(".git-diff-comment-editor textarea")!, "use a const name");
  await click(add());
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0], "src/a.ts:2\n\n```diff\n+const two = 22;\n```\n\nuse a const name\n\n");
  assert.equal(editor() === null, true, "the editor closes after adding");

  // Range: open on the first add, shift+click the second add.
  await click(buttons()[2]!);
  await click(buttons()[3]!, { shiftKey: true });
  await type(view.container.querySelector(".git-diff-comment-editor textarea")!, "combine these");
  await click(add());
  assert.equal(inserted.length, 2, "each insert appends another block");
  assert.equal(inserted[1], "src/a.ts:2-3\n\n```diff\n+const two = 22;\n+const Three = 3;\n```\n\ncombine these\n\n");

  // Esc cancels without inserting and puts focus back on the line's button.
  await click(buttons()[0]!);
  await type(view.container.querySelector(".git-diff-comment-editor textarea")!, "never sent");
  await key(view.container.querySelector(".git-diff-comment-editor textarea")!, { key: "Escape" });
  assert.equal(editor() === null, true);
  assert.equal(inserted.length, 2);
  await delay(10);
  assert.equal(document.activeElement === buttons()[0], true, "focus returns to the line's button");
  await view.close();
});

const FILES = [
  { key: "a", path: "src/a.ts", diff: DIFF },
  { key: "b", path: "src/b.ts", diff: DIFF.replaceAll("a.ts", "b.ts") },
];

function Harness() {
  const root = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const find = useChangesFind({
    host,
    files: FILES.map(({ key: id, path }) => ({ key: id, path })),
    signature: "1",
    root,
    loadDiff: async (file) => FILES.find((item) => item.key === file.key)!.diff,
    reveal: (file) => setShown(file.key),
  });
  const file = FILES.find((item) => item.key === shown);
  return createElement("div", null,
    createElement("div", { ref: root, id: "inside", tabIndex: -1, onKeyDown: find.onKeyDown },
      createElement("input", { id: "inner-field" }),
      find.bar,
      file && createElement("section", { "data-testid": "expanded", "data-diff-path": file.path }, createElement(DiffContent, { diff: file.diff, path: file.path, split: false, wrap: false }))),
    createElement("input", { id: "outside-field" }));
}

test("Cmd/Ctrl+F opens the find bar only from inside the view; counts, next/prev wrap, Enter and Esc work", async () => {
  const view = await mount(createElement(Harness));
  const outside = view.container.querySelector("#outside-field")!;
  const stray = await key(outside, { key: "f", ctrlKey: true });
  assert.equal(stray.defaultPrevented, false, "outside the view Ctrl+F stays the browser's");
  assert.equal(view.container.querySelector(".git-find-bar") === null, true);

  const inner = view.container.querySelector<HTMLElement>("#inner-field")!;
  inner.focus();
  const opened = await key(inner, { key: "f", metaKey: true });
  assert.equal(opened.defaultPrevented, true);
  const bar = view.container.querySelector(".git-find-bar")!;
  assert.equal(bar !== null, true);
  const field = bar.querySelector("input")!;
  assert.equal(bar.getAttribute("role"), "search");
  await type(field, "const");
  await act(async () => { await delay(80); });
  const count = () => bar.querySelector(".git-find-count")!.textContent;
  assert.equal(count(), "1 of 10", "both files, 5 matching lines each");
  assert.equal(view.container.querySelector("[data-testid=expanded]")?.getAttribute("data-diff-path"), "src/a.ts", "the first match's file is shown");

  await key(field, { key: "Enter" });
  assert.equal(count(), "2 of 10");
  await key(field, { key: "Enter", shiftKey: true });
  await key(field, { key: "Enter", shiftKey: true });
  assert.equal(count(), "10 of 10", "previous from the first wraps to the last");
  assert.equal(view.container.querySelector("[data-testid=expanded]")?.getAttribute("data-diff-path"), "src/b.ts", "a collapsed file opens at its match");
  await key(field, { key: "Enter" });
  assert.equal(count(), "1 of 10", "next from the last wraps to the first");

  await type(field, "three");
  await act(async () => { await delay(80); });
  assert.equal(count(), "1 of 2", "case-insensitive by default");
  const toggle = [...bar.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-pressed") !== null)!;
  assert.equal(toggle.getAttribute("aria-label"), "Match case", "the Aa toggle is named for what it does");
  const onToggle = await key(toggle, { key: "Enter" });
  assert.equal(onToggle.defaultPrevented, false, "Enter on a button presses that button, not Next match");
  assert.equal(count(), "1 of 2");
  await click(toggle);
  await act(async () => { await delay(80); });
  assert.equal(count(), "No matches", "match case finds only the exact casing");

  await key(field, { key: "Escape" });
  assert.equal(view.container.querySelector(".git-find-bar") === null, true);
  await act(async () => { await delay(20); });
  assert.equal(document.activeElement === inner, true, "Esc restores focus to where Find was opened");
  await view.close();
});

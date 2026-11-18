// A streaming answer re-parses on every flush, but only its last block grows:
// the blocks above keep their React elements, and the DOM at every step equals
// a fresh render of the same text.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  getComputedStyle: (elt: Element) =>
    (dom as unknown as { getComputedStyle(element: Element): CSSStyleDeclaration })
      .getComputedStyle(elt),
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MarkdownDoc, renderBlocks, renderBlocksReusing } = await import("../src/markdown/render.tsx");
const { parseMarkdown, holdBackStreamingTail } = await import("../src/markdown/parse.ts");

const ANSWER = [
  "# Plan",
  "",
  "First paragraph with **bold**, `code` and a [link](https://example.com/a).",
  "",
  "- one",
  "- [x] done task",
  "  - nested item",
  "- three",
  "",
  "> a quote",
  "> on two lines",
  "",
  "| Name | Value |",
  "|:-----|------:|",
  "| a    | 1     |",
  "| b    | 2     |",
  "",
  "1. first",
  "2. second",
  "",
  "---",
  "",
  "Closing paragraph that keeps growing word by word until the end.",
].join("\n");

test("unchanged blocks keep their elements; a changed or new block gets a new one", () => {
  const before = parseMarkdown("# Title\n\nfirst para\n\nsecond");
  const after = parseMarkdown("# Title\n\nfirst para\n\nsecond grows\n\nthird");
  const first = renderBlocksReusing(null, before, "m1");
  const second = renderBlocksReusing(first, after, "m1");
  assert.equal(second.nodes.length, 4);
  assert.equal(second.nodes[0], first.nodes[0], "the heading is the same element");
  assert.equal(second.nodes[1], first.nodes[1], "the finished paragraph is the same element");
  assert.notEqual(second.nodes[2], first.nodes[2], "the growing paragraph is rendered again");
  // Another document never borrows elements: its keys differ.
  const other = renderBlocksReusing(first, before, "m2");
  assert.notEqual(other.nodes[0], first.nodes[0]);
  // A block that moves to another position is rendered for that position.
  const shifted = renderBlocksReusing(first, parseMarkdown("intro\n\n# Title\n\nfirst para"), "m1");
  assert.notEqual(shifted.nodes[1], first.nodes[0]);
  assert.equal(JSON.stringify(shifted.nodes), JSON.stringify(renderBlocks(parseMarkdown("intro\n\n# Title\n\nfirst para"), "m1")));
});

test("every streamed prefix renders the same DOM as a fresh render of that text", async () => {
  const live = document.createElement("div");
  const liveRoot = createRoot(live);
  const fresh = async (text: string, streaming: boolean): Promise<string> => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(createElement(MarkdownDoc, { text, keyBase: "msg", streaming })));
    const html = container.innerHTML;
    await act(async () => root.unmount());
    return html;
  };
  try {
    for (let end = 1; end <= ANSWER.length; end += 7) {
      const text = ANSWER.slice(0, end);
      await act(async () => liveRoot.render(createElement(MarkdownDoc, { text, keyBase: "msg", streaming: true })));
      assert.equal(live.innerHTML, await fresh(text, true), `prefix of ${end} characters`);
    }
    await act(async () => liveRoot.render(createElement(MarkdownDoc, { text: ANSWER, keyBase: "msg", streaming: false })));
    assert.equal(live.innerHTML, await fresh(ANSWER, false), "the finished answer");
  } finally {
    await act(async () => liveRoot.unmount());
  }
});

test("a streamed flush renders only the blocks that changed", () => {
  let held = renderBlocksReusing(null, parseMarkdown(holdBackStreamingTail(ANSWER.slice(0, 40))), "msg");
  let reused = 0;
  let rendered = 0;
  for (let end = 47; end <= ANSWER.length; end += 7) {
    const next = renderBlocksReusing(held, parseMarkdown(holdBackStreamingTail(ANSWER.slice(0, end))), "msg");
    next.nodes.forEach((node, i) => { if (node === held.nodes[i]) reused += 1; else rendered += 1; });
    held = next;
  }
  // Before the change every flush rendered every block.
  assert.ok(reused > rendered * 2, `reused ${reused}, rendered ${rendered}`);
});

// A growing code fence in a live message is not re-tokenized per delta:
// escaped plain text first (same box), colour at most every 300 ms, and the
// finished DOM equals the non-streaming render.
import test, { mock } from "node:test";
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
const { MarkdownDoc } = await import("../src/markdown/render.tsx");

// highlight() builds exactly one RegExp holding the "(?!)" no-flag arm per
// call; counting those counts tokenizer runs without touching its module.
const NativeRegExp = RegExp;
let highlightCalls = 0;
function CountingRegExp(this: unknown, source: string | RegExp, flags?: string) {
  if (typeof source === "string" && source.includes("(?!)")) highlightCalls += 1;
  return new NativeRegExp(source, flags);
}
CountingRegExp.prototype = NativeRegExp.prototype;
(globalThis as { RegExp: unknown }).RegExp = CountingRegExp;

const LINES = Array.from({ length: 200 }, (_, i) => `const v${i} = ${i}; // line "${i}" <b>`);
const FULL = "```ts\n" + LINES.join("\n");
const CLOSED = FULL + "\n```";

test("a 200-delta stream tokenizes a handful of times and ends equal to the finished render", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    highlightCalls = 0;
    for (let i = 1; i <= LINES.length; i++) {
      const text = "```ts\n" + LINES.slice(0, i).join("\n");
      await act(async () => {
        root.render(createElement(MarkdownDoc, { text, keyBase: "m", streaming: true }));
      });
      if (i % 40 === 0) await act(async () => { mock.timers.tick(300); });
    }
    const duringStream = highlightCalls;
    assert.ok(duringStream >= 1, "the call counter is live");
    if (process.env.HL_DEBUG) console.log("HLCALLS", duringStream);
    assert.ok(duringStream <= 8, `streaming tokenized ${duringStream} times`);
    const code = container.querySelector("pre code")!;
    assert.equal(code.textContent, LINES.join("\n"), "text is complete while streaming");

    highlightCalls = 0;
    await act(async () => {
      root.render(createElement(MarkdownDoc, { text: CLOSED, keyBase: "m" }));
    });
    assert.ok(highlightCalls <= 2, "stream end highlights once");
    const finalHtml = container.querySelector("pre code")!.innerHTML;

    const ref = document.createElement("div");
    document.body.appendChild(ref);
    const refRoot = createRoot(ref);
    await act(async () => {
      refRoot.render(createElement(MarkdownDoc, { text: CLOSED, keyBase: "m" }));
    });
    assert.equal(finalHtml, ref.querySelector("pre code")!.innerHTML);
    assert.ok(finalHtml.includes("tok-kw"));
    await act(async () => { refRoot.unmount(); });
  } finally {
    await act(async () => { root.unmount(); });
    mock.timers.reset();
  }
});

test("while streaming the block shows escaped plain text, then colour keeps the same text", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(MarkdownDoc, { text: "```ts\nconst a = 1; <i>", keyBase: "p", streaming: true }));
    });
    const code = container.querySelector("pre code")!;
    assert.equal(code.querySelector(".tok-kw"), null, "no colour before the first tick");
    assert.equal(code.textContent, "const a = 1; <i>");
    assert.equal(code.querySelector("i"), null, "markup stays escaped");
    await act(async () => { mock.timers.tick(300); });
    const after = container.querySelector("pre code")!;
    assert.ok(after.querySelector(".tok-kw"), "colour arrives on the trailing tick");
    assert.equal(after.textContent, "const a = 1; <i>", "same text, no layout change");
    assert.equal(container.querySelectorAll(".md-code-block").length, 1);
  } finally {
    await act(async () => { root.unmount(); });
    mock.timers.reset();
  }
});

test("a closed fence inside a streaming message highlights immediately", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(MarkdownDoc, { text: "```ts\nconst a = 1;\n```\nmore", keyBase: "c", streaming: true }));
    });
    assert.ok(container.querySelector("pre code .tok-kw"));
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("deltas every 50 ms keep advancing the snapshot (real trailing throttle)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    const lines = Array.from({ length: 60 }, (_, i) => `const w${i} = ${i};`);
    const final = lines.join("\n");
    const snapshots: string[] = [];
    let last = "";
    highlightCalls = 0;
    for (let i = 1; i <= 60; i++) {
      const text = "```ts\n" + lines.slice(0, i).join("\n");
      await act(async () => {
        root.render(createElement(MarkdownDoc, { text, keyBase: "t", streaming: true }));
      });
      await act(async () => { mock.timers.tick(50); });
      // Each snapshot colours more tokens, so the span count tracks it.
      const code = container.querySelector("pre code")!;
      const spans = [...code.querySelectorAll("[class^='tok-']")];
      const coloured = spans.length;
      if (coloured !== 0 && String(coloured) !== last) { snapshots.push(String(coloured)); last = String(coloured); }
      assert.ok(final.startsWith(code.textContent ?? ""), "shown text is a prefix of the final text");
    }
    const elapsed = 60 * 50;
    assert.ok(snapshots.length >= 8, `snapshot advanced ${snapshots.length} times`);
    assert.ok(highlightCalls <= elapsed / 300 + 2, `highlight calls ${highlightCalls}`);
    const finalText = "```ts\n" + final + "\n```";
    await act(async () => { root.render(createElement(MarkdownDoc, { text: finalText, keyBase: "t" })); });
    const html = container.querySelector("pre code")!.innerHTML;
    const ref = document.createElement("div");
    document.body.appendChild(ref);
    const refRoot = createRoot(ref);
    await act(async () => { refRoot.render(createElement(MarkdownDoc, { text: finalText, keyBase: "t" })); });
    assert.equal(html, ref.querySelector("pre code")!.innerHTML);
    await act(async () => { refRoot.unmount(); });
  } finally {
    await act(async () => { root.unmount(); });
    mock.timers.reset();
  }
});

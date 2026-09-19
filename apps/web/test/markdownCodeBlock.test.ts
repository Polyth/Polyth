// Markdown fenced code frames: tokenizer classes, copy inside the block,
// and scoped CSS. Mounts MarkdownDoc; overflow math is in markdown.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

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
  // happy-dom's Element is structurally distinct from lib.dom's and its
  // getComputedStyle resolves no pseudo-elements.
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

async function mount(text: string, props: { showGalleryShortcut?: boolean } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(MarkdownDoc, { text, keyBase: "md-test", ...props }));
  });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("fenced ts/js emits tokenizer classes and keeps copy inside the frame", async () => {
  const ts = await mount("```ts\nconst x = 1;\n```");
  try {
    const block = ts.container.querySelector(".md-code-block");
    assert.ok(block, "fenced code uses .md-code-block");
    const pre = block!.querySelector("pre");
    assert.ok(pre, "code lives in a pre");
    assert.ok(pre!.querySelector(".tok-kw"), "ts keywords are highlighted");
    assert.ok(pre!.querySelector(".tok-num"), "ts numbers are highlighted");
    const copy = block!.querySelector(".copy-btn");
    assert.ok(copy, "copy control exists");
    assert.equal(copy!.closest(".md-code-block"), block, "copy is a descendant of the frame");
    assert.equal(block!.querySelector(":scope > .copy-btn"), copy, "copy is a direct child of the frame");
    assert.equal(block!.querySelector(".md-code-block-toggle"), null, "short blocks do not show an expand control");
    assert.equal(block!.classList.contains("is-collapsed"), false);
  } finally {
    await ts.unmount();
  }

  const js = await mount("```js\nconst n = 42;\n```");
  try {
    const block = js.container.querySelector(".md-code-block")!;
    assert.ok(block.querySelector(".tok-kw"));
    assert.ok(block.querySelector(".tok-num"));
    assert.ok(block.querySelector(".copy-btn")?.closest(".md-code-block"));
  } finally {
    await js.unmount();
  }
});

test("json raw uses the json tokenizer and the same inside-frame copy", async () => {
  const view = await mount("```json\n{\"ok\": true, \"n\": 2}\n```");
  try {
    const block = view.container.querySelector(".md-code-block.json-block");
    assert.ok(block, "parsed json stays in the markdown code frame");
    const raw = [...block!.querySelectorAll("button")].find((button) => button.textContent === "Raw");
    assert.ok(raw, "tree/raw toggle is present");
    await act(async () => { raw!.click(); });
    const pre = block!.querySelector("pre");
    assert.ok(pre, "raw json renders a pre");
    assert.ok(pre!.querySelector(".tok-str") || pre!.querySelector(".tok-kw") || pre!.querySelector(".tok-num"));
    const copy = block!.querySelector(".copy-btn");
    assert.ok(copy);
    assert.equal(copy!.closest(".md-code-block"), block);
  } finally {
    await view.unmount();
  }
});

test("blocks taller than the viewport collapse to a third and expand from the in-frame control", async () => {
  document.documentElement.style.setProperty("--visual-vh", "900px");
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if ((this as HTMLElement).classList?.contains("md-code-block-body")) return 2000;
      return originalScroll?.get?.call(this) ?? 0;
    },
  });
  try {
    const view = await mount("```ts\nconst x = 1;\n```");
    try {
      const block = view.container.querySelector(".md-code-block");
      assert.ok(block, "fenced code uses .md-code-block");
      assert.equal(block!.classList.contains("is-collapsible"), true);
      assert.equal(block!.classList.contains("is-collapsed"), true);
      assert.equal(block!.querySelector(".md-code-block-shade"), null, "fade is a mask on the body, not a painted overlay");
      const toggle = block!.querySelector(".md-code-block-toggle") as HTMLButtonElement | null;
      assert.ok(toggle, "expand control is present");
      assert.equal(toggle!.getAttribute("aria-expanded"), "false");
      await act(async () => { toggle!.click(); });
      assert.equal(block!.classList.contains("is-collapsed"), false);
      assert.equal(block!.classList.contains("is-expanded"), true);
      assert.equal(toggle!.getAttribute("aria-expanded"), "true");
      assert.ok(block!.querySelector(".copy-btn")?.closest(".md-code-block"), "copy stays inside the frame");
    } finally {
      await view.unmount();
    }
  } finally {
    document.documentElement.style.removeProperty("--visual-vh");
    if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScroll);
    else delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
  }
});

test("blocked image source renders as readable text, not a dead line-through button", async () => {
  const view = await mount("![shot](/tmp/opencode/selection-menu-light.png)");
  try {
    assert.equal(view.container.querySelector(".md-img-btn"), null, "blocked source must not render an image button");
    const blocked = view.container.querySelector(".md-blocked");
    assert.ok(blocked, "blocked source is announced inline");
    assert.equal(view.container.querySelector("del"), null, "blocked source is not struck through");
    assert.equal(view.container.textContent?.includes("blocked image source"), true);
  } finally {
    await view.unmount();
  }
});

test("gallery shortcut renders only when sanitized images exist and opens the lightbox", async () => {
  const without = await mount("plain text answer", { showGalleryShortcut: true });
  try {
    assert.equal(without.container.querySelector(".gallery-shortcut"), null, "no images → no shortcut");
  } finally {
    await without.unmount();
  }
  const withImage = await mount("![pic](https://x.dev/i.png)", { showGalleryShortcut: true });
  try {
    const shortcut = withImage.container.querySelector(".gallery-shortcut") as HTMLButtonElement | null;
    assert.ok(shortcut, "sanitized image present → shortcut renders");
    await act(async () => { shortcut!.click(); });
    // The a11y Dialog portals its surface to document.body, not the mount root.
    assert.ok(document.body.querySelector(".gallery-dialog"), "shortcut opens the gallery");
  } finally {
    await withImage.unmount();
  }
});

test("markdown code-block CSS is scoped and uses visual viewport plus editor font", async () => {
  const css = await read("../src/styles.css");
  const copyRule = css.match(/\.md-code-block > \.copy-btn\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(copyRule, /position:\s*absolute/);
  assert.match(copyRule, /inset-inline-end:\s*var\(--space-2\)/);
  assert.match(copyRule, /inset-block-end:\s*var\(--space-2\)/);
  assert.match(copyRule, /background:\s*transparent/);
  assert.match(copyRule, /box-shadow:\s*none/);
  assert.match(css, /\.md-code-block\s*\{[^}]*border-radius:\s*var\(--radius-control\)/s);
  assert.doesNotMatch(css, /\.md-code-block\s*\{[^}]*isolation:\s*isolate/s);
  assert.match(
    css,
    /body:not\(\[data-glass="off"\]\):not\(\[data-desktop-low-resource="true"\]\) :is\([\s\S]*?\.msg \.bubble \.md-code-block\s*\)[\s\S]*?backdrop-filter:\s*blur\(var\(--material-glass-blur\)\)/s,
  );
  assert.match(
    css,
    /body\[data-glass="off"\] :is\(\.msg \.bubble pre, \.msg \.bubble \.md-code-block\)\s*\{[^}]*backdrop-filter:\s*none !important/s,
  );
  assert.match(css, /\.md-code-block\.is-collapsed\s*\{[^}]*max-height:\s*calc\(var\(--visual-vh, 100dvh\) \/ 3\)/s);
  assert.match(css, /\.md-code-block\.is-collapsed \.md-code-block-body\s*\{[^}]*mask-image:\s*linear-gradient\(to bottom, #000 58%, transparent 100%\)/s);
  assert.doesNotMatch(css, /\.md-code-block-shade/);
  assert.match(css, /\.md-code-block pre,\s*\.md-code-block pre code\s*\{[^}]*font-size:\s*var\(--font-code\)/s);
  assert.match(css, /\.msg \.bubble pre,\s*\.msg \.bubble pre code\s*\{[^}]*font-size:\s*var\(--font-code\)/s);
  assert.doesNotMatch(css, /\.copy-wrap\s*>\s*\.copy-btn\s*\{[^}]*position:\s*absolute/s);
});

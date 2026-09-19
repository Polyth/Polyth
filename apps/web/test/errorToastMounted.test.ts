// Mounted contract for the transient error-toast layout. The rest of the
// errorToast test file asserts the CSS/wiring; this mounts the shared Notice
// primitive so the DOM order — close control, copy, trailing category glyph —
// is proven rather than inferred from source text.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: Notice } = await import("../src/components/ui/Notice.tsx");

async function mount(node: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(node); });
  return {
    container,
    async unmount() {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("the toast lays out close control, copy, then the trailing glyph", async () => {
  const view = await mount(createElement(
    Notice,
    {
      tone: "error",
      className: "error-banner",
      role: "alert",
      leading: createElement("button", { className: "error-banner-close" }, "x"),
      icon: createElement("span", { className: "error-banner-glyph" }, "!"),
      iconPosition: "trailing",
      heading: "Connection lost",
    },
    createElement("div", { className: "error-banner-detail" }, "Check your network and retry."),
  ));
  try {
    const banner = view.container.querySelector(".error-banner");
    assert.ok(banner, "the toast root renders");
    const order = Array.from(banner.children).map((child) => child.className);
    assert.deepEqual(order, ["error-banner-close", "ui-notice-copy", "error-banner-glyph"]);
    assert.equal(banner.querySelector(".ui-notice-heading")?.textContent, "Connection lost");
    assert.equal(banner.querySelector(".error-banner-detail")?.textContent, "Check your network and retry.");
  } finally {
    await view.unmount();
  }
});

test("Notice keeps its default leading tone glyph for existing consumers", async () => {
  const view = await mount(createElement(Notice, { tone: "info" }, "Saved."));
  try {
    const notice = view.container.querySelector(".ui-notice");
    assert.ok(notice, "the notice renders");
    const order = Array.from(notice.children).map((child) =>
      child.classList.contains("ui-notice-icon") ? "glyph" : child.className,
    );
    assert.deepEqual(order, ["glyph", "ui-notice-copy"]);
    assert.equal(notice.textContent, "Saved.");
    assert.equal(view.container.querySelector(".error-banner-glyph"), null);
  } finally {
    await view.unmount();
  }
});

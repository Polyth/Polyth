// Mounted contract for the shared Notice primitive's optional slots: a leading
// control and a trailing glyph, without moving the default tone glyph of
// every other consumer. (Transient notifications are notify/, not Notice.)
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

test("Notice lays out a leading control, the copy, then a trailing glyph", async () => {
  const view = await mount(createElement(
    Notice,
    {
      tone: "warning",
      className: "probe-notice",
      role: "status",
      children: createElement("div", { className: "probe-detail" }, "Replay paused."),
      leading: createElement("button", { className: "probe-close" }, "x"),
      icon: createElement("span", { className: "probe-glyph" }, "!"),
      iconPosition: "trailing",
      heading: "Paused",
    },
  ));
  try {
    const notice = view.container.querySelector(".probe-notice");
    assert.ok(notice, "the notice renders");
    const order = Array.from(notice.children).map((child) => child.className);
    assert.deepEqual(order, ["probe-close", "ui-notice-copy", "probe-glyph"]);
    assert.equal(notice.querySelector(".ui-notice-heading")?.textContent, "Paused");
    assert.equal(notice.querySelector(".probe-detail")?.textContent, "Replay paused.");
  } finally {
    await view.unmount();
  }
});

test("Notice keeps its default leading tone glyph for existing consumers", async () => {
  const view = await mount(createElement(Notice, { tone: "info", children: "Saved." }));
  try {
    const notice = view.container.querySelector(".ui-notice");
    assert.ok(notice, "the notice renders");
    const order = Array.from(notice.children).map((child) =>
      child.classList.contains("ui-notice-icon") ? "glyph" : child.className,
    );
    assert.deepEqual(order, ["glyph", "ui-notice-copy"]);
    assert.equal(notice.textContent, "Saved.");
  } finally {
    await view.unmount();
  }
});

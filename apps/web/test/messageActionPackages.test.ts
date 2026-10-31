// Package buttons under a message follow the same quick-action layout as the
// built-in ones: the user orders them and places each on the bar, in the More
// menu, or off. A contribution that cannot live in a menu stays on the bar.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

register("./tsxHooks.mjs", import.meta.url);

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.assign(globalThis, {
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerSlot } = await import("../src/slots.ts");
const { default: MessageActionBar } = await import("../src/components/MessageActionBar.tsx");
const { CopyIcon, PluginIcon } = await import("../src/components/ui/index.ts");
type Placement = "bar" | "menu" | "off";

interface Seen { placement: unknown; request: unknown; anchor: unknown }

function contribution(id: string, seen: Seen[], meta?: Record<string, unknown>) {
  return registerSlot("session.message.actions", id, (context) => {
    seen.push({
      placement: context.messageActionPlacement,
      request: context.messageActionRequest,
      anchor: typeof context.messageActionAnchor === "function" ? (context.messageActionAnchor as () => unknown)() : null,
    });
    return context.messageActionPlacement === "menu"
      ? null
      : createElement("button", { type: "button", "data-test-action": id }, id);
  }, 10, meta);
}

async function mount(items: Array<{ id: string; placement: Placement }>, reveal: "always" | "menu" = "always") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(MessageActionBar<"copy">, {
      role: "user",
      layout: { items: items as never, reveal, touch: reveal },
      actions: [{ id: "copy", icon: CopyIcon, label: "Copy", run: () => {} }],
      label: "Actions",
      moreLabel: "More actions",
      context: { messageRole: "user", eventSeq: 7 },
    }));
  });
  return {
    container,
    order: () => [...container.querySelectorAll(".chat-action-bar > *")]
      .map((node) => node.querySelector("[data-action-id]")?.getAttribute("data-action-id")
        ?? node.getAttribute("data-test-action")
        ?? (node.querySelector(".chat-action-more") ? "more" : node.className)),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a package button sits on the bar where the layout puts it", async () => {
  const seen: Seen[] = [];
  const off = contribution("test.quote", seen, { messageAction: { label: "Quote", icon: PluginIcon, menu: true } });
  const view = await mount([{ id: "pkg:test.quote", placement: "bar" }, { id: "copy", placement: "bar" }]);
  try {
    assert.deepEqual(view.order(), ["test.quote", "copy"]);
    assert.equal(seen.at(-1)?.placement, "bar");
  } finally {
    await view.unmount();
    off();
  }
});

test("a menu-capable package button moves into More and acts on each selection", async () => {
  const seen: Seen[] = [];
  const off = contribution("test.quote", seen, { messageAction: { label: "Quote", icon: PluginIcon, menu: true } });
  const view = await mount([{ id: "copy", placement: "bar" }, { id: "pkg:test.quote", placement: "menu" }]);
  try {
    assert.equal(view.container.querySelector("[data-test-action]"), null, "no visible trigger in the menu placement");
    assert.equal(seen.at(-1)?.placement, "menu");
    assert.equal(seen.at(-1)?.request, 0);
    const more = view.container.querySelector<HTMLButtonElement>(".chat-action-more")!;
    await act(async () => { more.click(); });
    const entry = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")]
      .find((item) => item.textContent?.includes("Quote"));
    assert.ok(entry, "the More menu lists the package action by its label");
    await act(async () => { entry.click(); });
    assert.equal(seen.at(-1)?.placement, "menu");
    assert.equal(seen.at(-1)?.request, 1);
    assert.ok(seen.at(-1)?.anchor instanceof dom.HTMLElement, "the bar is offered as the popover anchor");
  } finally {
    await view.unmount();
    off();
  }
});

test("menu-only reveal folds menu-capable package buttons and keeps bar-only ones", async () => {
  const quote: Seen[] = [];
  const chip: Seen[] = [];
  const offQuote = contribution("test.quote", quote, { messageAction: { label: "Quote", menu: true } });
  const offChip = contribution("test.chip", chip);
  const view = await mount([
    { id: "copy", placement: "bar" },
    { id: "pkg:test.quote", placement: "bar" },
    { id: "pkg:test.chip", placement: "menu" },
  ], "menu");
  try {
    assert.deepEqual(view.order().filter((id) => id !== "chat-action-headless"), ["test.chip", "more"]);
    assert.equal(quote.at(-1)?.placement, "menu");
    assert.equal(chip.at(-1)?.placement, "bar");
  } finally {
    await view.unmount();
    offQuote();
    offChip();
  }
});

test("an off package button is not mounted; a new one joins on the bar; foreign roles are skipped", async () => {
  const hidden: Seen[] = [];
  const fresh: Seen[] = [];
  const assistantOnly: Seen[] = [];
  const offs = [
    contribution("test.hidden", hidden, { messageAction: { label: "Hidden" } }),
    contribution("test.fresh", fresh, { messageAction: { label: "Fresh" } }),
    contribution("test.reply", assistantOnly, { messageAction: { label: "Reply", roles: ["assistant"] } }),
  ];
  const view = await mount([
    { id: "pkg:test.hidden", placement: "off" },
    { id: "copy", placement: "bar" },
    { id: "pkg:test.gone", placement: "bar" },
  ]);
  try {
    assert.equal(hidden.length, 0);
    assert.equal(assistantOnly.length, 0);
    assert.deepEqual(view.order(), ["copy", "test.fresh"]);
  } finally {
    await view.unmount();
    offs.forEach((off) => off());
  }
});

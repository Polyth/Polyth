// P1-W2: design tokens + core UI primitives (components/ui/).
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
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: (callback: FrameRequestCallback) => { callback(0); return 1; },
});
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Deterministic shell mode: responsiveShell caches these MediaQueryLists on
// first use, so the mutable `matches` flags steer wide vs phone per test.
const media = { compact: false, phone: false };
const mediaQueryList = (key: "compact" | "phone") => ({
  get matches() { return media[key]; },
  media: key,
  addEventListener: () => {},
  removeEventListener: () => {},
});
Object.defineProperty(dom, "matchMedia", {
  configurable: true,
  value: (query: string) =>
    mediaQueryList(query.includes("960") ? "compact" : "phone"),
});

register("./tsxHooks.mjs", import.meta.url);

const { act, createElement, createRef, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const ui = await import("../src/components/ui/index.ts");
const { useEscape } = await import("../src/useEscape.ts");

const KeyboardEventCtor = (dom as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;

async function mount(element: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

test("Escape closes only the top-most transient overlay layer", async () => {
  function Layers() {
    const [outer, setOuter] = useState(true);
    const [inner, setInner] = useState(true);
    useEscape(outer, () => setOuter(false));
    useEscape(inner, () => setInner(false));
    return createElement("div", {
      "data-outer": String(outer),
      "data-inner": String(inner),
    });
  }

  const view = await mount(createElement(Layers));
  try {
    const state = () => view.container.querySelector("div")!;
    await act(async () => {
      document.dispatchEvent(new KeyboardEventCtor("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(state().dataset.inner, "false");
    assert.equal(state().dataset.outer, "true");

    await act(async () => {
      document.dispatchEvent(new KeyboardEventCtor("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(state().dataset.outer, "false");
  } finally {
    await view.unmount();
  }
});

test("token contract: calm radius scale, overlay/icon/z/density tokens exist once", async () => {
  const [tokens, styles] = await Promise.all([read("../src/tokens.css"), read("../src/styles.css")]);

  assert.match(tokens, /--radius-control:\s*calc\(8px \* var\(--corner-radius-scale\)\)/);
  assert.match(tokens, /--radius-card:\s*calc\(10px \* var\(--corner-radius-scale\)\)/);
  assert.match(tokens, /--radius-surface:\s*calc\(12px \* var\(--corner-radius-scale\)\)/);
  assert.match(tokens, /--radius-sheet:\s*calc\(16px \* var\(--corner-radius-scale\)\)/);
  // Conversation chrome adds rounder roles on top of the base scale: compact
  // activity rows, floating glass islands/docks, and the composer pill.
  assert.match(tokens, /--radius-activity:\s*calc\(15px \* var\(--corner-radius-scale\)\)/);
  assert.match(tokens, /--radius-island:\s*calc\(23px \* var\(--corner-radius-scale\)\)/);
  assert.match(tokens, /--radius-dock:\s*calc\(23px \* var\(--corner-radius-scale\)\)/);
  assert.match(tokens, /--radius-composer:\s*calc\(28px \* var\(--corner-radius-scale\)\)/);

  for (const token of [
    "--overlay-bg", "--overlay-border", "--overlay-shadow",
    "--icon-sm: 16px", "--icon-md: 18px", "--icon-lg: 20px", "--icon-xl: 24px",
    "--control-pad-x-sm", "--control-pad-x", "--control-gap",
    "--hit-min: 0px", "--font-code",
    "--z-shell", "--z-overlay", "--z-toast", "--z-popover", "--z-tooltip",
  ]) {
    assert.ok(tokens.includes(token), `${token} is declared in tokens.css`);
  }

  // The density seam raises the hit floor only under coarse pointers.
  assert.match(styles, /@media \(pointer: coarse\)\s*\{\s*html:root \{ --hit-min: var\(--tap\); \}\s*\}/);
  // Primitives are defined once — no wave-layered duplicates.
  for (const selector of [".ui-btn {", ".ui-icon-btn {", ".ui-popover {", ".ui-menu-item {", ".ui-tabs {"]) {
    const exactSelector = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gm");
    assert.equal([...styles.matchAll(exactSelector)].length, 1, `${selector} has a single definition`);
  }
  // IconButton extends its hit area without growing the visual box.
  assert.match(styles, /\.ui-icon-btn::after\s*\{[^}]*width:\s*max\(100%, var\(--hit-min\)\)/s);
});

test("Button: variants, sizes, busy state", async () => {
  let clicks = 0;
  const view = await mount(createElement(ui.Button, {
    variant: "primary",
    size: "sm",
    onClick: () => { clicks += 1; },
  }, "Save"));
  try {
    const button = view.container.querySelector("button")!;
    assert.equal(button.getAttribute("type"), "button");
    assert.ok(button.className.includes("ui-btn--primary"));
    assert.ok(button.className.includes("ui-btn--sm"));
    await act(async () => { button.click(); });
    assert.equal(clicks, 1);
  } finally { await view.unmount(); }

  const busy = await mount(createElement(ui.Button, { busy: true }, "Working"));
  try {
    const button = busy.container.querySelector("button")!;
    assert.equal(button.getAttribute("aria-busy"), "true");
    assert.ok(button.hasAttribute("disabled"));
    assert.ok(busy.container.querySelector(".ui-spinner"), "busy buttons show a spinner");
  } finally { await busy.unmount(); }
});

test("IconButton: mandatory accessible name, pressed state, token-sized glyph", async () => {
  const view = await mount(createElement(ui.IconButton, {
    icon: ui.CloseIcon,
    label: "Close panel",
    pressed: true,
  }));
  try {
    const button = view.container.querySelector("button")!;
    assert.equal(button.getAttribute("aria-label"), "Close panel");
    assert.equal(button.getAttribute("title"), "Close panel");
    assert.equal(button.getAttribute("aria-pressed"), "true");
    const icon = view.container.querySelector("svg.ui-icon")!;
    assert.ok(icon.getAttribute("class")!.includes("ui-icon--md"));
    assert.equal(icon.getAttribute("aria-hidden"), "true");
  } finally { await view.unmount(); }
});

test("Switch and Checkbox toggle through accessible semantics", async () => {
  function Harness() {
    const [on, setOn] = useState(false);
    const [checked, setChecked] = useState(false);
    return createElement("div", null,
      createElement(ui.Switch, { checked: on, onChange: setOn, label: "Notifications" }),
      createElement(ui.Checkbox, { checked, onChange: setChecked, label: "Include archived" }),
    );
  }
  const view = await mount(createElement(Harness));
  try {
    const switchButton = view.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    assert.equal(switchButton.getAttribute("aria-checked"), "false");
    assert.ok(switchButton.className.includes("switch"), "Switch reuses the canonical .switch visual");
    await act(async () => { switchButton.click(); });
    assert.equal(switchButton.getAttribute("aria-checked"), "true");

    const checkbox = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assert.equal(checkbox.checked, false);
    await act(async () => { checkbox.click(); });
    assert.equal(checkbox.checked, true);
  } finally { await view.unmount(); }
});

test("Tabs: roving tabindex and arrow-key activation", async () => {
  function Harness() {
    const [value, setValue] = useState("one");
    return createElement(ui.Tabs, {
      tabs: [{ id: "one", label: "One" }, { id: "two", label: "Two" }, { id: "three", label: "Three" }],
      value,
      onChange: setValue,
      label: "Views",
      idBase: "t",
    });
  }
  const view = await mount(createElement(Harness));
  try {
    const tablist = view.container.querySelector<HTMLElement>('[role="tablist"]')!;
    assert.equal(tablist.getAttribute("aria-label"), "Views");
    const selected = () => view.container.querySelector<HTMLElement>('[aria-selected="true"]')!;
    assert.equal(selected().textContent, "One");
    assert.equal(selected().tabIndex, 0);
    await act(async () => {
      selected().dispatchEvent(new KeyboardEventCtor("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    });
    assert.equal(selected().textContent, "Two");
    assert.equal(selected().getAttribute("aria-controls"), "t-panel-two");
    await act(async () => {
      selected().dispatchEvent(new KeyboardEventCtor("keydown", { key: "End", bubbles: true, cancelable: true }));
    });
    assert.equal(selected().textContent, "Three");
  } finally { await view.unmount(); }
});

test("Menu (desktop): opens a role=menu popover, selects, and dismisses on Escape", async () => {
  media.compact = false;
  media.phone = false;
  let picked = "";
  const view = await mount(createElement(ui.Menu, {
    label: "Session actions",
    entries: [
      { id: "rename", label: "Rename", onSelect: () => { picked = "rename"; } },
      "separator",
      { id: "delete", label: "Delete", danger: true, onSelect: () => { picked = "delete"; } },
    ],
    children: (trigger: object) =>
      createElement("button", { ...trigger, className: "menu-trigger" }, "Actions"),
  }));
  try {
    const trigger = view.container.querySelector<HTMLButtonElement>(".menu-trigger")!;
    assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
    await act(async () => { trigger.click(); });
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]')!;
    assert.equal(menu.getAttribute("aria-label"), "Session actions");
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    assert.deepEqual(items.map((item) => item.textContent), ["Rename", "Delete"]);
    assert.ok(items[1]!.className.includes("ui-menu-item--danger"));

    await act(async () => { items[0]!.click(); });
    assert.equal(picked, "rename");
    assert.equal(document.body.querySelector('[role="menu"]'), null, "selection closes the menu");

    await act(async () => { trigger.click(); });
    await act(async () => {
      document.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(document.body.querySelector('[role="menu"]'), null, "Escape closes the menu");
  } finally { await view.unmount(); }
});

test("Menu selection semantics: radio/checkbox roles, headings, swatches, stay-open checkboxes", async () => {
  media.compact = false;
  media.phone = false;
  let sort = "recent";
  let filtered = false;
  function Host() {
    const [, rerender] = useState(0);
    return createElement(ui.Menu, {
      label: "List options",
      entries: [
        { heading: "Sort" },
        { id: "recent", label: "Recent", kind: "radio", checked: sort === "recent", onSelect: () => { sort = "recent"; rerender((n: number) => n + 1); } },
        { id: "name", label: "Name", kind: "radio", checked: sort === "name", onSelect: () => { sort = "name"; rerender((n: number) => n + 1); } },
        "separator",
        { id: "attention", label: "Needs attention", kind: "checkbox", checked: filtered, swatch: "#e4bb62", onSelect: () => { filtered = !filtered; rerender((n: number) => n + 1); } },
      ],
      footer: createElement("div", { className: "menu-extra" }, "extras"),
      children: (trigger: object) =>
        createElement("button", { ...trigger, className: "menu-trigger" }, "Options"),
    });
  }
  const view = await mount(createElement(Host));
  try {
    const trigger = view.container.querySelector<HTMLButtonElement>(".menu-trigger")!;
    await act(async () => { trigger.click(); });
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]')!;

    // Headings are non-interactive; radios and checkboxes carry aria-checked.
    assert.equal(menu.querySelector(".ui-menu-heading")?.textContent, "Sort");
    const radios = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    assert.deepEqual(radios.map((r) => r.getAttribute("aria-checked")), ["true", "false"]);
    assert.ok(radios[0]!.querySelector(".ui-menu-item-check svg"), "checked radio renders the leading check");
    const checkbox = menu.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!;
    assert.equal(checkbox.getAttribute("aria-checked"), "false");
    assert.ok(checkbox.querySelector(".ui-menu-item-swatch"), "label-style entries render their swatch");
    assert.ok(menu.querySelector(".menu-extra"), "footer content renders after the entries");

    // Checkbox selection toggles without closing; radio selection closes.
    await act(async () => { checkbox.click(); });
    assert.ok(document.body.querySelector('[role="menu"]'), "checkbox toggles keep the menu open");
    assert.equal(filtered, true);
    assert.equal(
      document.body.querySelector<HTMLElement>('[role="menuitemcheckbox"]')!.getAttribute("aria-checked"),
      "true",
    );
    await act(async () => {
      document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[1]!.click();
    });
    assert.equal(sort, "name");
    assert.equal(document.body.querySelector('[role="menu"]'), null, "radio selection closes the menu");
  } finally { await view.unmount(); }
});

test("Menu controlled open: external state opens it and focus returns to returnFocusRef", async () => {
  media.compact = false;
  media.phone = false;
  const returnRef = createRef<HTMLButtonElement>();
  function Host() {
    const [open, setOpen] = useState(false);
    return createElement("div", null,
      createElement("button", {
        ref: returnRef,
        className: "row-btn",
        onContextMenu: (event: MouseEvent) => { event.preventDefault(); setOpen(true); },
      }, "Row"),
      createElement(ui.Menu, {
        label: "Row actions",
        open,
        onOpenChange: setOpen,
        returnFocusRef: returnRef,
        entries: [{ id: "one", label: "One", onSelect: () => {} }],
        children: (trigger: object) =>
          createElement("button", { ...trigger, className: "menu-trigger" }, "More"),
      }),
    );
  }
  const view = await mount(createElement(Host));
  try {
    const row = view.container.querySelector<HTMLButtonElement>(".row-btn")!;
    await act(async () => {
      row.dispatchEvent(new (dom as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    assert.ok(document.body.querySelector('[role="menu"]'), "controlled open renders the menu");
    await act(async () => {
      document.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(document.body.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, row, "dismissal focuses the provided return target");
  } finally { await view.unmount(); }
});

test("ResponsiveOverlay: desktop dialog vs anchored popover vs phone sheet", async () => {
  media.compact = false;
  media.phone = false;

  // Desktop without an anchor → modal dialog on the a11y engine.
  const dialog = await mount(createElement(ui.ResponsiveOverlay, {
    open: true,
    onClose: () => {},
    title: "Configure",
    children: createElement("p", null, "content"),
  }));
  try {
    const surface = document.body.querySelector('[role="dialog"]')!;
    assert.equal(surface.getAttribute("aria-label"), "Configure");
    assert.ok(document.body.querySelector(".ui-dialog-head h2")?.textContent?.includes("Configure"));
  } finally { await dialog.unmount(); }

  // Desktop with an anchor → popover.
  const anchorRef = createRef<HTMLElement>();
  const anchorHost = await mount(createElement("button", { ref: anchorRef }, "anchor"));
  const popover = await mount(createElement(ui.ResponsiveOverlay, {
    open: true,
    onClose: () => {},
    title: "Filter",
    anchorRef,
    children: createElement("p", null, "popover content"),
  }));
  try {
    const surface = document.body.querySelector<HTMLElement>(".ui-popover")!;
    assert.equal(surface.getAttribute("aria-label"), "Filter");
    assert.equal(surface.getAttribute("role"), "dialog");
  } finally {
    await popover.unmount();
    await anchorHost.unmount();
  }

  // Phone → the canonical bottom sheet.
  media.phone = true;
  const sheet = await mount(createElement(ui.ResponsiveOverlay, {
    open: true,
    onClose: () => {},
    title: "Filter",
    children: createElement("p", null, "sheet content"),
  }));
  try {
    const backdrop = document.body.querySelector(".sheet-backdrop");
    assert.ok(backdrop, "phone mode renders the shared Sheet");
    assert.equal(backdrop!.querySelector(".sheet-title")?.textContent, "Filter");
  } finally {
    await sheet.unmount();
    media.phone = false;
  }
});

test("Badge, Separator, Spinner, Progress, Skeleton, VisuallyHidden semantics", async () => {
  const view = await mount(createElement("div", null,
    createElement(ui.Badge, { tone: "success", dot: true, children: "Healthy" }),
    createElement(ui.Separator, {}),
    createElement(ui.Spinner, { label: "Loading sessions" }),
    createElement(ui.Progress, { value: 0.4, label: "Import progress" }),
    createElement(ui.Skeleton, { shape: "block", height: 60 }),
    createElement(ui.VisuallyHidden, null, "hidden context"),
  ));
  try {
    assert.ok(view.container.querySelector(".ui-badge--success .ui-badge-dot"));
    assert.equal(view.container.querySelector(".ui-separator")!.getAttribute("role"), "separator");
    const spinner = view.container.querySelector('[role="status"]')!;
    assert.equal(spinner.getAttribute("aria-label"), "Loading sessions");
    const progress = view.container.querySelector('[role="progressbar"]')!;
    assert.equal(progress.getAttribute("aria-valuenow"), "40");
    assert.equal(view.container.querySelector(".ui-skeleton")!.getAttribute("aria-hidden"), "true");
    assert.equal(view.container.querySelector(".sr-only")!.textContent, "hidden context");
  } finally { await view.unmount(); }
});

// New chat → Customize: mount the real trigger and panel and drive it the way
// a person does — open, switch pieces off, fold out Recent options, clear the
// screen, reset — asserting the synced preferences and the composer layout.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/", width: 1280, height: 900 });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.PointerEvent,
  HTMLElement: dom.HTMLElement,
  requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { fetch?: unknown }).fetch = async () => ({
  ok: false, status: 404, statusText: "", headers: { get: () => null }, json: async () => ({}), text: async () => "",
});

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { HeroCustomizeButton } = await import("../src/components/mobile/HeroCustomize.tsx");
const prefsModule = await import("../src/heroWidgetPrefs.ts");
const { registerWidget } = await import("../src/widgets/catalog.ts");
const { ensureWidgets, getWidgetLayout, updateWidgetLayout, applyWidgetLayoutMutations } = await import("../src/widgets/widgetLayout.ts");
const { registerCapability } = await import("../src/capabilities.ts");
const { registerSurface } = await import("../src/surfaces.ts");
const { nearestSortIndex, sortKeyTarget } = await import("../src/components/mobile/useSortable.ts");
const { getHeroWidgetPrefs, isDefaultHeroWidgetPrefs, setHeroWidgetPrefs, defaultHeroWidgetPrefs } = prefsModule;
const { getHeroBoard, setHeroBoard } = await import("../src/heroBoard.ts");

const settle = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const composerWidget = {
  id: "sample.plan-switch",
  pluginId: "sample",
  title: "Plan mode",
  description: "Plan before acting",
  kind: "mini-widget" as const,
  defaultSlot: "composer.trailing" as const,
  supportedSlots: ["composer.leading" as const, "composer.trailing" as const],
  defaultVisible: true,
  render: () => null,
};
registerWidget(composerWidget);
ensureWidgets([{ id: composerWidget.id, defaultVisible: true }]);
updateWidgetLayout((current) => applyWidgetLayoutMutations(current, [
  { type: "visibility", id: composerWidget.id, visible: true },
  { type: "place", id: composerWidget.id, slot: "composer.trailing" },
], [composerWidget]));

async function mount() {
  const container = document.createElement("div");
  container.className = "hero-body";
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(createElement(HeroCustomizeButton)); });
  await settle();
  return { container, root };
}

const trigger = () => document.querySelector(".hero-customize-trigger") as HTMLButtonElement;
const row = (title: string) => [...document.querySelectorAll(".hero-customize-item")]
  .find((item) => item.querySelector(".hero-customize-title")?.textContent === title) as HTMLElement | undefined;
const rowSwitch = (title: string) => row(title)?.querySelector("[role=switch]") as HTMLButtonElement;
const click = async (element: Element | null | undefined) => {
  assert.ok(element, "element to click exists");
  await act(async () => { (element as HTMLElement).click(); });
  await settle();
};

test("the pencil opens one panel that lists every piece of the new chat", async () => {
  setHeroWidgetPrefs(defaultHeroWidgetPrefs());
  const { root } = await mount();
  assert.equal(trigger().textContent, "", "the trigger is glyph-only, not a labelled pill");
  assert.equal(trigger().getAttribute("aria-label"), "Customize new chat");
  assert.ok(trigger().querySelector("svg"), "the pencil carries its glyph");
  assert.equal(document.querySelectorAll(".hero-customize-trigger").length, 1, "one trigger, not a pill plus a pencil");
  assert.ok(trigger().classList.contains("zone-customize-trigger"), "Shift or Edit mode reveals it, like every zone's pencil");
  assert.equal(trigger().getAttribute("data-customized"), null);
  assert.equal(trigger().getAttribute("aria-expanded"), "false");

  await click(trigger());
  assert.equal(trigger().getAttribute("aria-expanded"), "true");
  assert.match(document.body.textContent ?? "", /Customize new chat/);
  const titles = [...document.querySelectorAll(".hero-customize-title")].map((node) => node.textContent);
  assert.deepEqual(titles, ["Greeting", "Shortcuts", "Recent sessions", "Apps", "Add widget", "Project and branch", "Isolate switch", "Plan mode"]);
  assert.ok([...document.querySelectorAll(".hero-customize-row [role=switch]")]
    .every((node) => node.getAttribute("aria-checked") === "true"), "everything starts on");
  assert.match(document.body.textContent ?? "", /shared with open chats in this project/);
  await act(async () => { root.unmount(); });
  document.body.innerHTML = "";
});

test("the pencil is the screen's only trigger and opens the same Customize panel", async () => {
  setHeroWidgetPrefs(defaultHeroWidgetPrefs());
  const { root } = await mount();
  const pencil = trigger();
  assert.ok(pencil, "the hero carries its customize pencil");
  assert.equal(pencil.getAttribute("aria-label"), "Customize new chat");
  assert.equal(document.querySelector(".hero-zone-edit-button"), null, "the old edit-mode duplicate is gone");
  await click(pencil);
  assert.equal(pencil.getAttribute("aria-expanded"), "true");
  assert.equal(document.querySelectorAll(".hero-customize-panel").length, 1);
  await act(async () => { root.unmount(); });
  document.body.innerHTML = "";
});

test("Shortcuts are managed from Customize: its button closes the panel and opens the picker", async () => {
  setHeroWidgetPrefs(defaultHeroWidgetPrefs());
  const { getState, setOverlay } = await import("../src/store.ts");
  const { root } = await mount();
  await click(trigger());
  await click(row("Shortcuts")?.querySelector('[aria-label="Choose shortcuts"]'));
  assert.equal(getState().overlay, "starter-picker");
  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  setOverlay(null);
  await act(async () => { root.unmount(); });
  document.body.innerHTML = "";
});

test("switches hide screen pieces, the location row gates its Isolate switch, and the trigger shows a change", async () => {
  setHeroWidgetPrefs(defaultHeroWidgetPrefs());
  const { root } = await mount();
  await click(trigger());

  await click(rowSwitch("Greeting"));
  assert.equal(getHeroWidgetPrefs().chrome.greeting, false);
  assert.equal(row("Greeting")?.getAttribute("data-off"), "true");
  assert.equal(trigger().getAttribute("data-customized"), "true");

  await click(row("Shortcuts")?.querySelector(".hero-customize-text"));
  assert.deepEqual(getHeroWidgetPrefs().hidden, ["starters"], "the row text is a toggle target too");

  await click(rowSwitch("Project and branch"));
  assert.equal(getHeroWidgetPrefs().chrome.location, false);
  assert.equal(rowSwitch("Isolate switch").disabled, true);
  assert.equal(rowSwitch("Isolate switch").getAttribute("aria-checked"), "false");
  assert.equal(getHeroWidgetPrefs().chrome.isolation, true, "hiding the row never rewrites the switch choice");

  await click(rowSwitch("Plan mode"));
  assert.equal(getWidgetLayout().widgets[composerWidget.id]?.visible, false);
  await click(rowSwitch("Plan mode"));
  assert.equal(getWidgetLayout().widgets[composerWidget.id]?.visible, true);
  await act(async () => { root.unmount(); });
  document.body.innerHTML = "";
});

test("Add widget puts a catalog widget on the board; its options size, configure, duplicate and remove it", async () => {
  setHeroWidgetPrefs(defaultHeroWidgetPrefs());
  setHeroBoard({ items: [], order: [] });
  registerWidget({
    id: "sample.clock",
    pluginId: "sample",
    pluginName: "Sample",
    title: "Clock",
    description: "The time",
    kind: "widget",
    supportedSlots: ["session.empty.widgets"],
    duplicatable: true,
    panelSizes: ["compact", "standard"],
    settingsSchema: { properties: { seconds: { type: "boolean", title: "Seconds" } } },
    render: () => null,
  });
  const { root } = await mount();
  await click(trigger());
  await click(document.querySelector(".hero-customize-add-row"));
  const addButton = [...document.querySelectorAll(".hero-add-widget-row")]
    .find((node) => node.textContent?.includes("Clock"))?.querySelector("button");
  await click(addButton);
  assert.deepEqual(getHeroBoard().items.map(({ id, widget, size }) => ({ id, widget, size })), [{ id: "sample.clock", widget: "sample.clock", size: "compact" }]);
  assert.ok(row("Clock"), "the new item is listed with the built-ins");
  assert.equal(trigger().getAttribute("data-customized"), "true");
  assert.ok(document.querySelector(".hero-board-options"), "its options open right away");

  const standard = [...document.querySelectorAll(".hero-board-options .seg button")].find((node) => node.textContent === "Standard");
  await click(standard);
  assert.equal(getHeroBoard().items[0]!.size, "standard");
  const scope = row("Clock")?.querySelector(".hero-board-options [role=switch]") as HTMLButtonElement;
  assert.equal(scope.disabled, true, "no project in view: the item stays on every project's screen");
  await click(document.querySelector(".hero-board-options .widget-schema-settings input[type=checkbox]"));
  assert.deepEqual(getHeroBoard().items[0]!.config, { seconds: true });

  const handle = row("Clock")?.querySelector(".hero-customize-move") as HTMLButtonElement;
  await act(async () => { handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }) as unknown as Event); });
  await settle();
  assert.deepEqual(getHeroBoard().order, ["sample.clock", "starters", "recent", "apps"], "one order for built-ins and items");
  assert.deepEqual(getHeroWidgetPrefs().order, ["starters", "recent", "apps"], "built-ins keep their order for older clients");

  const duplicate = [...document.querySelectorAll(".hero-board-actions button")].find((node) => node.textContent === "Duplicate");
  await click(duplicate);
  assert.deepEqual(getHeroBoard().items.map((item) => item.id), ["sample.clock", "sample.clock#2"]);
  assert.deepEqual(getHeroBoard().items[1]!.config, { seconds: true });

  const remove = [...document.querySelectorAll(".hero-board-actions button")].find((node) => node.textContent === "Remove");
  await click(remove);
  assert.deepEqual(getHeroBoard().items.map((item) => item.id), ["sample.clock#2"]);

  const reset = [...document.querySelectorAll(".hero-customize-actions button")].find((node) => node.textContent === "Reset") as HTMLButtonElement;
  await click(reset);
  assert.equal(getHeroBoard().items[0]!.hidden, true, "Reset hides added widgets and keeps their settings");
  assert.equal(trigger().getAttribute("data-customized"), null);
  await act(async () => { root.unmount(); });
  document.body.innerHTML = "";
  setHeroBoard({ items: [], order: [] });
});

test("Recent options fold out inline, the drag handle reorders by keyboard, Clear screen and Reset round-trip", async () => {
  setHeroWidgetPrefs(defaultHeroWidgetPrefs());
  const { root } = await mount();
  await click(trigger());

  const disclose = row("Recent sessions")?.querySelector(".hero-customize-disclose") as HTMLButtonElement;
  assert.equal(disclose.getAttribute("aria-expanded"), "false");
  await click(disclose);
  assert.equal(disclose.getAttribute("aria-expanded"), "true");
  assert.ok(document.querySelector(".hero-customize-nested .hero-recent-settings-form"));
  const eight = [...document.querySelectorAll(".hero-customize-nested .seg button")].find((node) => node.textContent === "8");
  await click(eight);
  assert.equal(getHeroWidgetPrefs().recent.limit, 8);

  const handle = () => row("Recent sessions")?.querySelector(".hero-customize-move") as HTMLButtonElement;
  const key = async (target: HTMLElement, name: string) => {
    await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }) as unknown as Event); });
    await settle();
  };
  await key(handle(), "ArrowUp");
  assert.deepEqual(getHeroWidgetPrefs().order, ["recent", "starters", "apps"]);
  await key(handle(), "ArrowUp");
  assert.deepEqual(getHeroWidgetPrefs().order, ["recent", "starters", "apps"], "the first widget stays first");
  await key(handle(), "End");
  assert.deepEqual(getHeroWidgetPrefs().order, ["starters", "apps", "recent"]);
  assert.deepEqual(
    [...document.querySelectorAll("[data-sort-id]")].map((node) => node.getAttribute("data-sort-id")),
    ["starters", "apps", "recent"],
    "rows follow the stored order",
  );

  const clear = [...document.querySelectorAll(".hero-customize-actions button")].find((node) => node.textContent === "Clear screen") as HTMLButtonElement;
  await click(clear);
  assert.deepEqual([...getHeroWidgetPrefs().hidden].sort(), ["apps", "recent", "starters"]);
  assert.equal(getHeroWidgetPrefs().chrome.greeting, false);
  assert.equal(getHeroWidgetPrefs().chrome.location, true, "Clear screen leaves the composer alone");
  assert.equal(clear.disabled, true);

  const reset = [...document.querySelectorAll(".hero-customize-actions button")].find((node) => node.textContent === "Reset") as HTMLButtonElement;
  await click(reset);
  assert.equal(isDefaultHeroWidgetPrefs(getHeroWidgetPrefs()), true);
  assert.equal(reset.disabled, true);
  assert.equal(trigger().getAttribute("data-customized"), null);
  await act(async () => { root.unmount(); });
  document.body.innerHTML = "";
});

test("Apps: pick package icons for the screen, reorder them, hide names and take one off", async () => {
  setHeroWidgetPrefs(defaultHeroWidgetPrefs());
  const disposers: Array<() => void> = [];
  for (const [id, label] of [["hero-app-files", "Files"], ["hero-app-git", "Git"], ["hero-app-notes", "Notes"]] as const) {
    disposers.push(registerCapability({
      id, label, plainDescription: `${label} window`, keywords: [], standardTier: "more", standardRank: 0, open: () => {}, available: () => true,
    }));
    disposers.push(registerSurface({ id, capabilityId: id, title: label, order: 90, component: () => null }));
  }
  const { root } = await mount();
  try {
    await click(trigger());
    await click(row("Apps")?.querySelector(".hero-customize-disclose"));
    assert.match(document.querySelector(".hero-apps-editor-empty")?.textContent ?? "", /Tap an app below/);
    const add = (label: string) => document.querySelector(`.hero-app--add[aria-label="Add ${label}"]`);
    await click(add("Files"));
    await click(add("Notes"));
    await click(add("Git"));
    assert.deepEqual(getHeroWidgetPrefs().apps.ids, ["hero-app-files", "hero-app-notes", "hero-app-git"]);
    assert.equal(trigger().getAttribute("data-customized"), "true");
    assert.equal(document.querySelectorAll(".hero-app--add").length, 0, "pinned apps leave the add list");

    const tile = (id: string) => document.querySelector(`.hero-apps--edit [data-sort-handle="${id}"]`) as HTMLElement;
    await act(async () => { tile("hero-app-git").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }) as unknown as Event); });
    await settle();
    assert.deepEqual(getHeroWidgetPrefs().apps.ids, ["hero-app-git", "hero-app-files", "hero-app-notes"]);

    await act(async () => { tile("hero-app-files").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }) as unknown as Event); });
    await settle();
    assert.deepEqual(getHeroWidgetPrefs().apps.ids, ["hero-app-git", "hero-app-notes"]);
    await click(document.querySelector('.hero-app-remove[aria-label="Remove Notes"]'));
    assert.deepEqual(getHeroWidgetPrefs().apps.ids, ["hero-app-git"]);

    const labels = document.querySelector(".hero-apps-editor-labels [role=switch]");
    await click(labels);
    assert.equal(getHeroWidgetPrefs().apps.labels, false);
  } finally {
    await act(async () => { root.unmount(); });
    document.body.innerHTML = "";
    for (const dispose of disposers) dispose();
  }
});

test("Apps keep an unloaded package's place and drop junk from synced values", () => {
  setHeroWidgetPrefs({ ...defaultHeroWidgetPrefs(), apps: { ids: ["a", "a", "", 4 as unknown as string, "b"], labels: "x" as unknown as boolean } });
  assert.deepEqual(getHeroWidgetPrefs().apps, { ids: ["a", "b"], labels: true });
  prefsModule.replaceHeroWidgetPrefs({ order: ["recent", "starters"], hidden: [] });
  assert.deepEqual(getHeroWidgetPrefs().apps.ids, ["a", "b"], "a client that predates Apps keeps this device's pins");
  assert.deepEqual(prefsModule.moveListItem(["a", "b", "c"], "c", 0), ["c", "a", "b"]);
  assert.deepEqual(prefsModule.moveListItem(["a", "b", "c"], "a", 9), ["b", "c", "a"]);
  setHeroWidgetPrefs(defaultHeroWidgetPrefs());
});

test("sorting picks the nearest centre in a list or a grid, and keys clamp at the ends", () => {
  const grid = [
    { id: "a", left: 0, top: 0, width: 70, height: 70 },
    { id: "b", left: 80, top: 0, width: 70, height: 70 },
    { id: "c", left: 0, top: 80, width: 70, height: 70 },
  ];
  assert.equal(nearestSortIndex(grid, 120, 30), 1);
  assert.equal(nearestSortIndex(grid, 20, 140), 2);
  assert.equal(nearestSortIndex([], 0, 0), -1);
  assert.equal(sortKeyTarget("ArrowLeft", 0, 3), 0);
  assert.equal(sortKeyTarget("ArrowDown", 2, 3), 2);
  assert.equal(sortKeyTarget("End", 0, 3), 2);
  assert.equal(sortKeyTarget("Enter", 1, 3), null);
});

test("the Customize pencil sits in the hero's top-right corner", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = css.slice(css.indexOf(".hero-body > .hero-customize-trigger {"), css.indexOf(".hero-customize-trigger[data-customized"));
  assert.match(rule, /position: absolute/);
  assert.match(rule, /top: var\(--space-2\)/);
  assert.match(rule, /inset-inline-end: calc\(var\(--rail-strip-width-right/);
  assert.match(rule, /z-index: 1/);
  assert.doesNotMatch(rule, /margin-inline-start: max/);
  assert.doesNotMatch(rule, /align-self: flex-start/);
});

test("Apps tiles take every colour from the active theme", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const section = css.slice(css.indexOf(".hero-apps {"), css.indexOf(".hero-app-remove, .hero-app-add-badge {"));
  assert.ok(section.includes(".hero-app-tile {"), "the tile rules are in the inspected section");
  // Fixed literals and the shared purple signal ignore the chosen palette.
  assert.doesNotMatch(section, /#[0-9a-f]{3,8}\b/i, "no hard-coded colours");
  assert.doesNotMatch(section, /var\(--purple\)/, "the tint follows the theme accent, not a signal colour");
  assert.match(section, /color-mix\(in srgb, var\(--accent\) 15%, transparent\)/);
  // The glyph uses the accent's text role, which every theme lifts or deepens
  // to stay readable on its surfaces (plain --accent sinks on dark tiles).
  assert.match(section, /\.hero-app-tile \{[^}]*color: var\(--accent-text\);/);
});

test("Apps tiles hover as icons, not as button slabs, and stay squircles", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const section = css.slice(css.indexOf(".hero-apps {"), css.indexOf(".hero-app-remove, .hero-app-add-badge {"));
  // The shared `button:hover` (0-1-1) fills --elevated; the tile button must
  // out-rank it or a slab appears behind tile and name.
  assert.match(section, /\.hero-app:is\(:hover, :active\):where\(:not\(:disabled\)\) \{ background: transparent; \}/);
  const tile = section.slice(section.indexOf(".hero-app-tile {"));
  const rule = tile.slice(0, tile.indexOf("}"));
  // Edge drawn as a box-shadow, so Hide interface borders cannot erase it.
  assert.match(rule, /border: 0;/);
  assert.match(rule, /inset 0 0 0 1px/);
  // ~25% of the side at the default Rounding (scale 1.8): a squircle, not the
  // 0.3 factor that turned every tile into a circle.
  const factor = Number(/border-radius: calc\(var\(--hero-app-tile\) \* ([\d.]+) \* var\(--corner-radius-scale\)\)/.exec(rule)?.[1]);
  assert.ok(factor * 1.8 > 0.2 && factor * 1.8 < 0.3, `default radius is ${factor * 1.8} of the tile`);
});

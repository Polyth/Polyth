import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { Window } from "happy-dom";
import { getMobileRailMap, mobileRailCells, mobileRailColumns, mobileRailKey, mobileRailMapEntry, mobileRailPreference, parseMobileRail, parseMobileRailMap, readMobileRail, replaceMobileRailMap, swapMobileRailSlots, writeMobileRail } from "../src/composer/mobileRail.ts";
import { composerLayoutState } from "../src/composerLayout.ts";

register("./tsxHooks.mjs", import.meta.url);
const dom = new Window({ url: "http://127.0.0.1/" });
let width = 358;
const observers = new Set<() => void>();
Object.assign(globalThis, {
  window: dom, document: dom.document, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  Event: dom.Event, CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  ResizeObserver: class {
    constructor(callback: () => void) { this.callback = callback; }
    callback: () => void;
    observe() { observers.add(this.callback); }
    disconnect() { observers.delete(this.callback); }
  },
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(dom.HTMLElement.prototype, "clientWidth", { configurable: true, get() { return width; } });
const captures = new WeakMap<object, number>();
Object.assign(dom.HTMLElement.prototype, {
  setPointerCapture(id: number) { captures.set(this, id); },
  hasPointerCapture(id: number) { return captures.get(this) === id; },
  releasePointerCapture() { captures.delete(this); },
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.fetch = async () => new Response("{}", { status: 404 });

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: MobileComposerRail, MobileComposerEditButton } = await import("../src/components/mobile/MobileComposerRail.tsx");
const { registerWidget } = await import("../src/widgets/catalog.ts");
const { getWidgetLayout } = await import("../src/widgets/widgetLayout.ts");
const { setActiveBrowserAccount } = await import("../src/accountStorage.ts");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
after(() => dom.happyDOM.abort());

function pointer(node: Element, type: string, x = 0, y = 0) {
  node.dispatchEvent(new dom.PointerEvent(type, { bubbles: true, pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y }) as unknown as Event);
}
function host() {
  const container = document.createElement("div");
  document.body.append(container);
  return { container, root: createRoot(container) };
}

test("mobile records reject malformed data, retain unavailable launchers and distinguish an empty arrangement", () => {
  assert.equal(parseMobileRail("broken"), null);
  assert.equal(parseMobileRail('{"v":2,"slots":[]}'), null);
  assert.deepEqual(parseMobileRail('{"v":1,"slots":[]}'), []);
  assert.deepEqual(parseMobileRail(JSON.stringify({ v: 1, slots: ["widget:disabled.action", null, "host:add", "host:add", 3, "../escape"] })), ["widget:disabled.action", null, "host:add", null, null, null]);
  assert.equal(parseMobileRail(JSON.stringify({ v: 1, slots: Array(60).fill(null) }))?.length, 32);
});

test("section counts follow width and resizing retains every saved position", () => {
  assert.equal(mobileRailColumns(288), 6);
  assert.equal(mobileRailColumns(358), 7);
  assert.equal(mobileRailColumns(600), 12);
  assert.equal(mobileRailColumns(900), 12);
  assert.equal(mobileRailColumns(288, 48), 5);
  assert.equal(mobileRailColumns(272, 44, 88), 4, "a running split action must not squeeze launcher hit areas");
  assert.equal(mobileRailColumns(331), 6);
  assert.equal(mobileRailColumns(332), 7, "six launchers and Send fit with exactly six compact gaps");
  assert.equal(mobileRailColumns(332, 44, 44, 8), 6, "measurement must use the rendered gap");
  assert.equal(mobileRailColumns(352, 44, 44, 0), 8, "a zero gap is a valid measured preference");
  assert.equal(mobileRailColumns(0), 2);
  const slots = ["host:add", "widget:one", "widget:two", null, "widget:three"];
  assert.deepEqual(mobileRailCells(slots, 2, false).slice(0, 5), slots);
  assert.deepEqual(swapMobileRailSlots(slots, 0, 3), [null, "widget:one", "widget:two", "host:add", "widget:three"]);
  assert.equal(slots[0], "host:add");
  assert.equal(mobileRailCells(Array.from({ length: 32 }, (_, i) => `widget:${i}`), 5, true).length, 32);
  assert.equal(composerLayoutState({ phoneLayout: true, inputFocused: false, shellMode: false, hasDraft: false, railEditing: true }), "phone-engaged");
  assert.equal(composerLayoutState({ phoneLayout: true, inputFocused: false, shellMode: false, hasDraft: false, railEditing: false }), "phone-resting");
});

test("an idle phone composer rests as one row and keeps every launcher mounted", async () => {
  const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  assert.match(composer, /composerLayoutState\(\{[^}]*railEditing: mobileRailEditing \}\)/, "only rail editing, not the rail itself, keeps an idle composer engaged");
  // Presented resting only once the card has shrunk to the row (composerMorph.ts).
  assert.match(composer, /resting=\{!presentedExpanded\}/);
  const css = await readFile(new URL("../src/components/mobile/MobileComposerRail.css", import.meta.url), "utf8");
  assert.match(css, /\.composer-collapsed :is\(\.mobile-composer-rail, \.mobile-composer-launchers\) \{ display: contents; \}/);
  assert.match(css, /\.composer-collapsed \.mobile-composer-cell:not\(\[data-resting\]\) \{ display: none; \}/);

  localStorage.clear();
  const widget = (id: string) => ({
    id, pluginId: "test", title: id, description: id, kind: "mini-widget" as const,
    defaultSlot: "composer.leading" as const, supportedSlots: ["composer.leading" as const],
    defaultVisible: true, render: () => createElement("button", null, id),
  });
  const offOne = registerWidget(widget("rest.one"));
  const offTwo = registerWidget(widget("rest.two"));
  const { root, container } = host();
  const render = (resting: boolean) => root.render(createElement(MobileComposerRail, {
    storageKey: mobileRailKey("space-rest", "project-rest"), context: {},
    add: createElement("button", null, "Add"), primary: createElement("button", null, "Send"),
    resting, editing: false, onEditingChange() {},
  }));
  try {
    await act(async () => render(true));
    const marks = () => Array.from(container.querySelectorAll<HTMLElement>("[data-resting]"), (node) => node.dataset.resting);
    assert.ok(container.querySelector(".mobile-composer-rail[data-resting]"));
    assert.deepEqual(marks().slice(1), ["add", "quick"], "Add and one launcher share the resting row");
    const quick = () => container.querySelector<HTMLElement>('[data-resting="quick"]')!.dataset.launcherId;
    assert.equal(quick(), "widget:rest.two", "resting keeps the launcher the engaged rail shows beside Send");
    const key = mobileRailKey("space-rest", "project-rest");
    await act(async () => writeMobileRail(key, ["host:add", "widget:rest.two", null, "widget:rest.one"]));
    assert.equal(quick(), "widget:rest.one", "empty sections between a launcher and Send do not change which one rests");
    await act(async () => writeMobileRail(key, ["host:add", null, null, null, null, null, null, "widget:rest.two", "widget:rest.one"]));
    assert.equal(quick(), "widget:rest.two", "with no launcher on the first page, the first one further along rests");
    await act(async () => writeMobileRail(key, null));
    const second = container.querySelector('[data-launcher-id="widget:rest.two"] button');
    assert.ok(second, "other launchers stay mounted while resting");
    await act(async () => render(false));
    assert.equal(container.querySelector(".mobile-composer-rail[data-resting]"), null);
    assert.equal(container.querySelector('[data-launcher-id="widget:rest.two"] button'), second, "engaging never remounts a launcher");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    offOne(); offTwo();
  }
});

test("a launcher with nothing to show gives up its cell until edit mode", async () => {
  localStorage.clear();
  let available = false;
  const widget = (id: string, isAvailable?: () => boolean) => ({
    id, pluginId: "test", title: id, description: id, kind: "mini-widget" as const,
    defaultSlot: "composer.leading" as const, supportedSlots: ["composer.leading" as const],
    defaultVisible: true, isAvailable, render: () => createElement("button", null, id),
  });
  let offIdle = registerWidget(widget("avail.idle", () => available));
  const offShown = registerWidget(widget("avail.shown"));
  const { root, container } = host();
  const render = (editing: boolean) => root.render(createElement(MobileComposerRail, {
    storageKey: mobileRailKey("space-avail", "project-avail"), context: { projectId: "project-avail" },
    add: createElement("button", null, "Add"), primary: createElement("button", null, "Send"),
    editing, onEditingChange() {},
  }));
  const launchers = () => Array.from(container.querySelectorAll<HTMLElement>("[data-launcher-id]"), (node) => node.dataset.launcherId);
  try {
    await act(async () => render(false));
    assert.deepEqual(launchers(), ["host:add", "widget:avail.shown"], "no empty cell holds the unavailable launcher's place");
    await act(async () => render(true));
    assert.ok(launchers().includes("widget:avail.idle"), "edit mode keeps it movable and removable");
    await act(async () => render(false));
    available = true;
    // Packages re-register when availability changes; the catalog bump re-asks.
    await act(async () => { offIdle(); offIdle = registerWidget(widget("avail.idle", () => available)); });
    assert.ok(launchers().includes("widget:avail.idle"));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    offIdle(); offShown();
  }
});

test("mobile preferences stay within their Space and project and sync as one account preference", () => {
  localStorage.clear();
  setActiveBrowserAccount("usr_owner");
  const key = mobileRailKey("space-a", "project-a");
  writeMobileRail(key, ["host:add", null, "widget:one", null]);
  assert.deepEqual(parseMobileRail(readMobileRail(key)), ["host:add", null, "widget:one"]);
  assert.equal(readMobileRail(mobileRailKey("space-b", "project-a")), null);
  assert.equal(readMobileRail(mobileRailKey("space-a", "project-b")), null);
  // The whole arrangement set is one account-owned value the server mirrors, so
  // a second project is a second entry of the same preference.
  writeMobileRail(mobileRailKey("space-a", "project-b"), ["host:add", "widget:two"]);
  assert.deepEqual(Object.keys(getMobileRailMap()).sort(), [key, mobileRailKey("space-a", "project-b")].sort());
});

test("an arrangement written by another client is applied verbatim and unknown values are dropped", () => {
  localStorage.clear();
  const key = mobileRailKey("space-sync", "project-sync");
  const other = { [key]: JSON.stringify({ v: 1, slots: ["widget:synced", null, "host:add"] }) };
  replaceMobileRailMap(other);
  assert.deepEqual(parseMobileRail(readMobileRail(key)), ["widget:synced", null, "host:add"]);
  // A hostile/older payload cannot inject a malformed id or an unknown key.
  replaceMobileRailMap({
    [key]: JSON.stringify({ v: 1, slots: ["../escape", "widget:ok"] }),
    "widget:not-a-key": JSON.stringify({ v: 1, slots: ["host:add"] }),
    "polyth.composer.mobile-rail.v1.space-sync.other": "broken",
  });
  assert.deepEqual(parseMobileRail(readMobileRail(key)), [null, "widget:ok"]);
  assert.deepEqual(Object.keys(getMobileRailMap()), [key]);
  // A local edit is what the adapter mirrors back to the server.
  writeMobileRail(key, ["host:add", "widget:local"]);
  assert.deepEqual(parseMobileRailMap(mobileRailPreference.read()), {
    [key]: JSON.stringify({ v: 1, slots: ["host:add", "widget:local"] }),
  });
  assert.equal(mobileRailMapEntry(mobileRailPreference.read(), key), JSON.stringify({ v: 1, slots: ["host:add", "widget:local"] }));
});

test("the older per-key record migrates into the synced map once", () => {
  localStorage.clear();
  const key = mobileRailKey("space-legacy", "project-legacy");
  localStorage.setItem(key, JSON.stringify({ v: 1, slots: ["host:add", "widget:legacy"] }));
  assert.deepEqual(parseMobileRail(readMobileRail(key)), ["host:add", "widget:legacy"]);
  writeMobileRail(key, ["host:add", "widget:newer"]);
  assert.equal(readMobileRail(key), JSON.stringify({ v: 1, slots: ["host:add", "widget:newer"] }), "the map wins over the legacy record");
});

test("the older record migrates from its account-scoped key", () => {
  localStorage.clear();
  setActiveBrowserAccount("usr_second");
  const key = mobileRailKey("space-legacy", "project-scoped");
  localStorage.setItem(`${key}.account.usr_second`, JSON.stringify({ v: 1, slots: ["widget:scoped"] }));
  localStorage.setItem(`${key}.account.usr_owner`, JSON.stringify({ v: 1, slots: ["widget:owner"] }));
  assert.deepEqual(parseMobileRail(readMobileRail(key)), ["widget:scoped"], "only this account's record is a migration source");
  setActiveBrowserAccount("usr_owner");
});

test("a storage write failure keeps the edited arrangement usable in memory", () => {
  const key = mobileRailKey("space-quota", "project-quota");
  const original = localStorage.setItem;
  localStorage.setItem = () => { throw new Error("quota exceeded"); };
  try {
    // The arrangement is still readable even if the durable write is refused,
    // because the in-memory map is the synchronous working copy.
    assert.doesNotThrow(() => writeMobileRail(key, ["host:add", null, "widget:one"]));
    assert.deepEqual(parseMobileRail(readMobileRail(key)), ["host:add", null, "widget:one"]);
    assert.equal(readMobileRail(mobileRailKey("space-other", "project-quota")), null);
  } finally {
    localStorage.setItem = original;
    writeMobileRail(key, null);
  }
});

test("the pencil requires a hold, cancels on movement and supports keyboard activation", async () => {
  const { root, container } = host();
  const changes: boolean[] = [];
  await act(async () => root.render(createElement(MobileComposerEditButton, { editing: false, onChange: (value) => changes.push(value) })));
  const pencil = container.querySelector("button")!;
  await act(async () => { pointer(pencil, "pointerdown"); pointer(pencil, "pointerup"); pencil.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, detail: 1 }) as unknown as Event); await sleep(450); });
  assert.deepEqual(changes, [], "short taps never enter edit mode");
  await act(async () => { pointer(pencil, "pointerdown"); pointer(pencil, "pointermove", 20); await sleep(450); });
  assert.deepEqual(changes, [], "a pan cancels the hold");
  await act(async () => { pointer(pencil, "pointerdown"); pointer(pencil, "pointercancel"); await sleep(450); });
  assert.deepEqual(changes, []);
  await act(async () => { pointer(pencil, "pointerdown"); await sleep(450); pointer(pencil, "pointerup"); pencil.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, detail: 1 }) as unknown as Event); });
  assert.deepEqual(changes, [true], "the release click must not close editing");
  await act(async () => pencil.click());
  assert.deepEqual(changes, [true, true], "assistive and keyboard activation need no hold");
  await act(async () => root.unmount());
  container.remove();
});

test("the mounted rail swaps with touch, cancels safely, adds/removes and restores independently of desktop", async () => {
  localStorage.clear();
  const key = mobileRailKey("space-rail", "project-rail");
  let launches = 0;
  const widget = (id: string, requiredVisible = false) => ({
    id, pluginId: "test", title: id, description: id, kind: "mini-widget" as const,
    defaultSlot: "composer.leading" as const, supportedSlots: ["composer.leading" as const],
    defaultVisible: true, requiredVisible,
    render: () => createElement("button", { onClick: () => launches++ }, id),
  });
  const offOne = registerWidget(widget("test.one"));
  let offTwo = registerWidget(widget("test.two"));
  const offRequired = registerWidget(widget("test.required", true));
  const desktop = JSON.stringify(getWidgetLayout());
  const { root, container } = host();
  let editing = true;
  const render = () => root.render(createElement(MobileComposerRail, {
    storageKey: key, context: { projectId: "project-rail" },
    add: createElement("button", { onClick: () => launches++ }, "Add"),
    primary: createElement("button", { onClick: () => launches++ }, "Send"),
    editing, onEditingChange: (value) => { editing = value; render(); },
  }));
  const cell = (id: string) => container.querySelector<HTMLElement>(`[data-launcher-id="${id}"]`)!;
  const editButton = (id: string) => cell(id).querySelector<HTMLButtonElement>(".mobile-composer-cell-edit")!;
  const order = () => Array.from(container.querySelectorAll<HTMLElement>("[data-launcher-id]"), (node) => node.dataset.launcherId);
  try {
    await act(async () => render());
    assert.equal(container.querySelector<HTMLElement>(".mobile-composer-primary")!.inert, true);
    const original = order();
    const source = editButton("host:add");
    const target = cell("widget:test.one");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target });
    await act(async () => { pointer(source, "pointerdown", 10, 10); pointer(source, "pointermove", 100, 10); });
    await act(async () => { pointer(source, "pointerup", 100, 10); source.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, detail: 1 }) as unknown as Event); });
    assert.equal(order().indexOf("host:add"), original.indexOf("widget:test.one"));
    assert.equal(document.querySelector('[role="menu"]'), null, "drag release never opens a launcher menu");
    assert.equal(launches, 0, "editing never launches an underlying action");
    const saved = readMobileRail(key);
    await act(async () => { pointer(editButton("host:add"), "pointerdown"); pointer(editButton("host:add"), "pointermove", 50); pointer(editButton("host:add"), "pointercancel"); });
    assert.equal(readMobileRail(key), saved, "a canceled drag never persists");

    await act(async () => editButton("widget:test.one").click());
    const remove = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((button) => button.textContent?.includes("Remove"))!;
    await act(async () => remove.click());
    assert.equal(cell("widget:test.one"), null);
    assert.equal(JSON.stringify(getWidgetLayout()), desktop, "mobile removal must not hide a desktop widget");
    await act(async () => container.querySelector<HTMLButtonElement>('.mobile-composer-cell:not([data-launcher-id]) button')!.click());
    const addOne = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((button) => button.textContent?.includes("test.one"))!;
    await act(async () => addOne.click());
    assert.ok(cell("widget:test.one"));
    await act(async () => editButton("widget:test.required").click());
    assert.equal(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((button) => button.textContent?.includes("Remove"))!.disabled, true);
    await act(async () => document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
    await act(async () => { window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event); });
    assert.equal(editing, false);
    assert.equal(container.querySelector(".mobile-composer-cell-edit"), null);
    assert.equal(container.querySelector<HTMLElement>(".mobile-composer-primary")!.inert, false);
    await act(async () => cell("widget:test.one").querySelector<HTMLButtonElement>("button")!.click());
    assert.equal(launches, 1);

    const persisted = readMobileRail(key);
    await act(async () => offTwo());
    assert.equal(cell("widget:test.two"), null);
    assert.equal(readMobileRail(key), persisted);
    await act(async () => { offTwo = registerWidget(widget("test.two")); });
    assert.ok(cell("widget:test.two"), "re-enabled launchers return to their saved section");
    await act(async () => { editing = true; render(); });
    await act(async () => { pointer(editButton("host:add"), "pointerdown"); pointer(editButton("host:add"), "pointermove", 50); width = 288; for (const callback of observers) callback(); });
    await act(async () => pointer(editButton("host:add"), "pointerup"));
    assert.equal(readMobileRail(key), persisted, "rotation cancels an active drag without losing positions");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    offOne(); offTwo(); offRequired();
    width = 358;
  }
  const restored = host();
  await act(async () => restored.root.render(createElement(MobileComposerRail, { storageKey: key, context: {}, add: createElement("button", null, "Add"), primary: createElement("button", null, "Send"), editing: false, onEditingChange() {} })));
  assert.ok(parseMobileRail(readMobileRail(key))?.includes("host:add"));
  await act(async () => restored.root.unmount());
  restored.container.remove();
});

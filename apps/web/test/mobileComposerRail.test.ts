import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { Window } from "happy-dom";
import { getMobileRailMap, MOBILE_RAIL_GAP, mobileRailColumns, mobileRailFromSlots, mobileRailKey, mobileRailMapEntry, mobileRailPreference, moveMobileRailLauncher, parseMobileRail, parseMobileRailMap, readEffectiveMobileRail, readMobileRail, replaceMobileRailMap, writeMobileRail } from "../src/composer/mobileRail.ts";
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
// happy-dom has no layout: lay the rail out as a phone would. Cells are 44px
// wide and 48px apart; the run beside Send ends at the rail's right edge.
const runBox = (node: Element | null) => node?.closest<HTMLElement>("[data-run-box]") ?? null;
Object.defineProperties(dom.HTMLElement.prototype, {
  offsetParent: { configurable: true, get() { return null; } },
  offsetTop: { configurable: true, get() { return 0; } },
  offsetWidth: { configurable: true, get() { return 44; } },
  offsetHeight: { configurable: true, get() { return 44; } },
  offsetLeft: { configurable: true, get(this: HTMLElement) {
    if (this.dataset.runBox === "end") return width - 48 * this.children.length;
    const run = runBox(this.parentElement);
    if (!this.dataset.launcherId || !run) return 0;
    const index = Array.prototype.indexOf.call(run.children, this);
    return run.dataset.runBox === "end" ? width - 48 * run.children.length + 48 * index : 48 * index;
  } },
});
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
const { default: MobileComposerRail, MobileComposerEditEntry, MOBILE_RAIL_HOLD_MS } = await import("../src/components/mobile/MobileComposerRail.tsx");
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

const ids = (arrangement: { start: string[]; end: string[] } | null) => arrangement && [arrangement.start, arrangement.end];

test("records keep two runs, migrate positional ones and reject malformed data", () => {
  assert.equal(parseMobileRail("broken"), null);
  assert.equal(parseMobileRail('{"v":2,"slots":[]}'), null);
  assert.deepEqual(ids(parseMobileRail('{"v":1,"slots":[]}')), [[], []], "an empty arrangement is not the default");
  assert.deepEqual(ids(parseMobileRail(JSON.stringify({ v: 1, slots: ["widget:disabled.action", "host:add", "host:add", 3, "../escape"] }))), [["widget:disabled.action", "host:add"], []]);
  assert.deepEqual(ids(parseMobileRail(JSON.stringify({ v: 1, slots: ["host:add", "widget:a", MOBILE_RAIL_GAP, "widget:mic"] }))), [["host:add", "widget:a"], ["widget:mic"]]);
  assert.equal(parseMobileRail(JSON.stringify({ v: 1, slots: Array.from({ length: 60 }, (_, i) => `widget:${i}`) }))?.start.length, 32);
  // Older builds saved lanes. The empty lanes before the last launcher were
  // the space before Send: that launcher was put beside it.
  assert.deepEqual(ids(mobileRailFromSlots(["host:add", null, null, null, "widget:shield", null])), [["host:add"], ["widget:shield"]]);
  assert.deepEqual(ids(mobileRailFromSlots(["host:add", null, "widget:a", null, "widget:b", "widget:c"])), [["host:add", "widget:a"], ["widget:b", "widget:c"]]);
  assert.deepEqual(ids(mobileRailFromSlots(["host:add", "widget:a", null, null])), [["host:add", "widget:a"], []]);
  // A record written now reads the same on a client that predates the runs:
  // the gap is an ordinary unknown id there, so it is kept, never stripped.
  const key = mobileRailKey("space-format", "project-format");
  writeMobileRail(key, { start: ["host:add"], end: ["widget:mic"] });
  assert.equal(readMobileRail(key), JSON.stringify({ v: 1, slots: ["host:add", MOBILE_RAIL_GAP, "widget:mic"] }));
  assert.match(MOBILE_RAIL_GAP, /^slot:[\w.:-]+$/, "older parsers accept the gap token");
  assert.deepEqual(ids(moveMobileRailLauncher({ start: ["a", "b"], end: ["c"] }, "a", "end", 1)), [["b"], ["c", "a"]]);
  writeMobileRail(key, null);
});

test("lane counts follow width without moving any saved launcher", () => {
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
  assert.equal(composerLayoutState({ phoneLayout: true, inputFocused: false, shellMode: false, hasDraft: false, railEditing: true }), "phone-engaged");
  assert.equal(composerLayoutState({ phoneLayout: true, inputFocused: false, shellMode: false, hasDraft: false, railEditing: false }), "phone-resting");
});

test("an idle phone composer rests as one row and keeps every launcher mounted", async () => {
  const composer = await readFile(new URL("../src/components/Composer.tsx", import.meta.url), "utf8");
  assert.match(composer, /composerLayoutState\(\{[^}]*railEditing: mobileRailEditing \}\)/, "only rail editing, not the rail itself, keeps an idle composer engaged");
  // Presented resting only once the card has shrunk to the row (composerMorph.ts).
  assert.match(composer, /resting=\{!presentedExpanded\}/);
  assert.doesNotMatch(composer, /MobileComposerEditButton/, "no pencil: holding a button is the way in");
  const css = await readFile(new URL("../src/components/mobile/MobileComposerRail.css", import.meta.url), "utf8");
  assert.match(css, /\.composer-collapsed :is\(\.mobile-composer-rail, \.mobile-composer-launchers, \.mobile-composer-run\) \{ display: contents; \}/);
  assert.match(css, /\.composer-collapsed \.mobile-composer-cell:not\(\[data-resting\]\) \{ display: none; \}/);
  assert.match(css, /prefers-reduced-motion: no-preference[\s\S]*data-reduce-animations[\s\S]*mobile-composer-jiggle/, "the wiggle honours every reduce-motion source");

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
    assert.equal(quick(), "widget:rest.two", "resting keeps the launcher the engaged rail shows nearest Send");
    const key = mobileRailKey("space-rest", "project-rest");
    await act(async () => writeMobileRail(key, { start: ["host:add", "widget:rest.two"], end: ["widget:rest.one"] }));
    assert.equal(quick(), "widget:rest.one", "the launcher beside Send is the one that rests");
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

test("a launcher with nothing to show gives up its place, never the run beside Send", async () => {
  localStorage.clear();
  let available = false;
  const widget = (id: string, isAvailable?: () => boolean) => ({
    id, pluginId: "test", title: id, description: id, kind: "mini-widget" as const,
    defaultSlot: "composer.leading" as const, supportedSlots: ["composer.leading" as const],
    defaultVisible: true, isAvailable, render: () => available || !isAvailable ? createElement("button", null, id) : null,
  });
  let offIdle = registerWidget(widget("avail.idle", () => available));
  const offShown = registerWidget(widget("avail.shown"));
  const offSide = registerWidget(widget("avail.side"));
  const key = mobileRailKey("space-avail", "project-avail");
  writeMobileRail(key, { start: ["host:add", "widget:avail.idle", "widget:avail.shown"], end: ["widget:avail.side"] });
  const { root, container } = host();
  const render = (editing: boolean) => root.render(createElement(MobileComposerRail, {
    storageKey: key, context: { projectId: "project-avail" },
    add: createElement("button", null, "Add"), primary: createElement("button", null, "Send"),
    editing, onEditingChange() {},
  }));
  const run = (name: string) => Array.from(container.querySelectorAll<HTMLElement>(`[data-run="${name}"]`), (node) => node.dataset.launcherId);
  try {
    await act(async () => render(false));
    assert.deepEqual(run("start"), ["host:add", "widget:avail.shown"], "no empty cell holds the unavailable launcher's place");
    assert.deepEqual(run("end"), ["widget:avail.side"], "and the launcher put beside Send stays there");
    await act(async () => render(true));
    assert.deepEqual(run("start"), ["host:add", "widget:avail.idle", "widget:avail.shown"], "edit mode keeps it movable and removable");
    assert.ok(container.querySelector('[data-launcher-id="widget:avail.idle"] .mobile-composer-glyph'), "and shows its glyph instead of an empty box");
    await act(async () => render(false));
    available = true;
    // Packages re-register when availability changes; the catalog bump re-asks.
    await act(async () => { offIdle(); offIdle = registerWidget(widget("avail.idle", () => available)); });
    assert.deepEqual(run("start"), ["host:add", "widget:avail.idle", "widget:avail.shown"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    offIdle(); offShown(); offSide();
  }
});

test("mobile preferences stay within their Space and sync as one account preference", () => {
  localStorage.clear();
  setActiveBrowserAccount("usr_owner");
  const key = mobileRailKey("space-a", "project-a");
  writeMobileRail(key, { start: ["host:add"], end: ["widget:one"] });
  assert.deepEqual(ids(parseMobileRail(readMobileRail(key))), [["host:add"], ["widget:one"]]);
  assert.equal(readMobileRail(mobileRailKey("space-b", "project-a")), null);
  assert.equal(readMobileRail(mobileRailKey("space-a", "project-b")), null, "a project's own record is only what was saved for it");
  // The whole arrangement set is one account-owned value the server mirrors, so
  // a second project is a second entry of the same preference.
  writeMobileRail(mobileRailKey("space-a", "project-b"), { start: ["host:add", "widget:two"], end: [] });
  assert.deepEqual(Object.keys(getMobileRailMap()).sort(), [key, mobileRailKey("space-a", "project-b")].sort());
});

test("a project not arranged yet starts from the latest arrangement in its Space", () => {
  localStorage.clear();
  const first = mobileRailKey("spc_home", "project-1");
  const fresh = mobileRailKey("spc_home", "project-new");
  writeMobileRail(mobileRailKey("spc_other", "project-x"), { start: ["widget:elsewhere"], end: [] });
  assert.equal(readEffectiveMobileRail(fresh), null, "another Space never lends its arrangement");
  writeMobileRail(first, { start: ["host:add"], end: ["widget:mic"] });
  writeMobileRail(mobileRailKey("spc_other", "project-y"), { start: ["widget:later-elsewhere"], end: [] });
  assert.equal(readEffectiveMobileRail(fresh), readMobileRail(first));
  assert.equal(readMobileRail(fresh), null, "inheriting writes nothing");
  writeMobileRail(fresh, { start: ["widget:mine"], end: [] });
  assert.deepEqual(ids(parseMobileRail(readEffectiveMobileRail(fresh))), [["widget:mine"], []], "its own record wins once edited");
  assert.deepEqual(ids(parseMobileRail(readEffectiveMobileRail(first))), [["host:add"], ["widget:mic"]], "and never changes the project it came from");
});

test("an arrangement written by another client is applied verbatim and unknown values are dropped", () => {
  localStorage.clear();
  const key = mobileRailKey("space-sync", "project-sync");
  const other = { [key]: JSON.stringify({ v: 1, slots: ["widget:synced", MOBILE_RAIL_GAP, "host:add"] }) };
  replaceMobileRailMap(other);
  assert.deepEqual(ids(parseMobileRail(readMobileRail(key))), [["widget:synced"], ["host:add"]]);
  // A hostile/older payload cannot inject a malformed id or an unknown key.
  replaceMobileRailMap({
    [key]: JSON.stringify({ v: 1, slots: ["../escape", "widget:ok"] }),
    "widget:not-a-key": JSON.stringify({ v: 1, slots: ["host:add"] }),
    "polyth.composer.mobile-rail.v1.space-sync.other": "broken",
  });
  assert.deepEqual(ids(parseMobileRail(readMobileRail(key))), [["widget:ok"], []]);
  assert.deepEqual(Object.keys(getMobileRailMap()), [key]);
  // A local edit is what the adapter mirrors back to the server.
  writeMobileRail(key, { start: ["host:add", "widget:local"], end: [] });
  assert.deepEqual(parseMobileRailMap(mobileRailPreference.read()), {
    [key]: JSON.stringify({ v: 1, slots: ["host:add", "widget:local"] }),
  });
  assert.equal(mobileRailMapEntry(mobileRailPreference.read(), key), JSON.stringify({ v: 1, slots: ["host:add", "widget:local"] }));
});

test("the older per-key record migrates into the synced map once", () => {
  localStorage.clear();
  const key = mobileRailKey("space-legacy", "project-legacy");
  localStorage.setItem(key, JSON.stringify({ v: 1, slots: ["host:add", "widget:legacy"] }));
  assert.deepEqual(ids(parseMobileRail(readMobileRail(key))), [["host:add", "widget:legacy"], []]);
  writeMobileRail(key, { start: ["host:add", "widget:newer"], end: [] });
  assert.equal(readMobileRail(key), JSON.stringify({ v: 1, slots: ["host:add", "widget:newer"] }), "the map wins over the legacy record");
});

test("the older record migrates from its account-scoped key", () => {
  localStorage.clear();
  setActiveBrowserAccount("usr_second");
  const key = mobileRailKey("space-legacy", "project-scoped");
  localStorage.setItem(`${key}.account.usr_second`, JSON.stringify({ v: 1, slots: ["widget:scoped"] }));
  localStorage.setItem(`${key}.account.usr_owner`, JSON.stringify({ v: 1, slots: ["widget:owner"] }));
  assert.deepEqual(ids(parseMobileRail(readMobileRail(key))), [["widget:scoped"], []], "only this account's record is a migration source");
  setActiveBrowserAccount("usr_owner");
});

test("a storage write failure keeps the edited arrangement usable in memory", () => {
  const key = mobileRailKey("space-quota", "project-quota");
  const original = localStorage.setItem;
  localStorage.setItem = () => { throw new Error("quota exceeded"); };
  try {
    // The arrangement is still readable even if the durable write is refused,
    // because the in-memory map is the synchronous working copy.
    assert.doesNotThrow(() => writeMobileRail(key, { start: ["host:add"], end: ["widget:one"] }));
    assert.deepEqual(ids(parseMobileRail(readMobileRail(key))), [["host:add"], ["widget:one"]]);
    assert.equal(readMobileRail(mobileRailKey("space-other", "project-quota")), null);
  } finally {
    localStorage.setItem = original;
    writeMobileRail(key, null);
  }
});

test("holding a composer button starts arranging; taps, pans and the mouse do not", async () => {
  localStorage.clear();
  let launches = 0;
  const offOne = registerWidget({
    id: "hold.one", pluginId: "test", title: "hold.one", description: "hold.one", kind: "mini-widget" as const,
    defaultSlot: "composer.leading" as const, supportedSlots: ["composer.leading" as const],
    defaultVisible: true, render: () => createElement("button", { onClick: () => launches++ }, "hold.one"),
  });
  const changes: boolean[] = [];
  let editing = false;
  const { root, container } = host();
  const render = () => root.render(createElement(MobileComposerRail, {
    storageKey: mobileRailKey("space-hold", "project-hold"), context: {},
    add: createElement("button", null, "Add"), primary: createElement("button", { onClick: () => launches++ }, "Send"),
    editing, onEditingChange: (value: boolean) => { changes.push(value); editing = value; render(); },
  }));
  const launcher = () => container.querySelector<HTMLButtonElement>('[data-launcher-id="widget:hold.one"] button')!;
  const tap = (node: Element) => node.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }) as unknown as Event);
  try {
    await act(async () => render());
    assert.equal(container.querySelector(".mobile-composer-edit, .mobile-composer-cell-grab"), null, "no edit control at rest");
    await act(async () => { pointer(launcher(), "pointerdown"); pointer(launcher(), "pointerup"); tap(launcher()); await sleep(MOBILE_RAIL_HOLD_MS + 50); });
    assert.deepEqual(changes, [], "a tap only presses the button");
    assert.equal(launches, 1);
    await act(async () => { pointer(launcher(), "pointerdown"); pointer(launcher(), "pointermove", 20); await sleep(MOBILE_RAIL_HOLD_MS + 50); });
    assert.deepEqual(changes, [], "a pan cancels the hold");
    await act(async () => { pointer(container.querySelector(".mobile-composer-primary button")!, "pointerdown"); await sleep(MOBILE_RAIL_HOLD_MS + 50); pointer(container.querySelector(".mobile-composer-primary button")!, "pointerup"); });
    assert.deepEqual(changes, [], "holding Send never arranges");
    await act(async () => { launcher().dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, pointerId: 2, pointerType: "mouse", isPrimary: true, button: 0 }) as unknown as Event); await sleep(MOBILE_RAIL_HOLD_MS + 50); });
    assert.deepEqual(changes, [], "a mouse press stays push-to-talk and the like");
    await act(async () => { const button = launcher(); pointer(button, "pointerdown"); await sleep(MOBILE_RAIL_HOLD_MS + 50); pointer(button, "pointerup"); tap(button); });
    assert.deepEqual(changes, [true], "a hold arranges");
    assert.equal(launches, 1, "and its release does not also press the button");
    assert.ok(container.querySelector('[data-launcher-id="widget:hold.one"] .mobile-composer-cell-grab'));
    await act(async () => document.body.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, pointerId: 3, pointerType: "touch", isPrimary: true }) as unknown as Event));
    assert.deepEqual(changes, [true, false], "a tap elsewhere ends arranging");
    await act(async () => { container.querySelector(".mobile-composer-rail")!.dispatchEvent(new dom.MouseEvent("contextmenu", { bubbles: true, cancelable: true }) as unknown as Event); });
    assert.deepEqual(changes, [true, false, true], "a right click arranges straight away");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    offOne();
  }
  // The keyboard and assistive way in needs no hold.
  const entry = host();
  const entered: boolean[] = [];
  await act(async () => entry.root.render(createElement(MobileComposerEditEntry, { editing: false, onChange: (value: boolean) => entered.push(value) })));
  await act(async () => entry.container.querySelector("button")!.click());
  assert.deepEqual(entered, [true]);
  await act(async () => entry.root.unmount());
  entry.container.remove();
});

test("arranging drags a launcher beside Send, removes, adds and resets without touching desktop", async () => {
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
  const cell = (id: string) => container.querySelector<HTMLElement>(`[data-launcher-id="${id}"]`);
  const grab = (id: string) => cell(id)!.querySelector<HTMLButtonElement>(".mobile-composer-cell-grab")!;
  const run = (name: string) => Array.from(container.querySelectorAll<HTMLElement>(`[data-run="${name}"]`), (node) => node.dataset.launcherId);
  const saved = () => ids(parseMobileRail(readMobileRail(key)));
  try {
    await act(async () => render());
    assert.equal(container.querySelector<HTMLElement>(".mobile-composer-primary")!.inert, true);
    assert.deepEqual(run("end"), []);
    assert.equal(container.querySelectorAll(".mobile-composer-cell").length, 4, "one place per launcher: no extra rows of empty lanes");

    // Lift test.one and carry it to Send: the rail reflows live and the drop
    // keeps it beside Send.
    const source = grab("widget:test.one");
    await act(async () => { pointer(source, "pointerdown", 60, 10); pointer(source, "pointermove", 200, 10); pointer(source, "pointermove", width - 10, 10); });
    assert.deepEqual(run("end"), ["widget:test.one"], "the preview already shows it beside Send");
    assert.equal(readMobileRail(key), null, "nothing is saved before the drop");
    await act(async () => { pointer(container.querySelector(".mobile-composer-rail")!, "pointerup", width - 10, 10); });
    assert.deepEqual(saved(), [["host:add", "widget:test.required", "widget:test.two"], ["widget:test.one"]]);
    assert.equal(document.querySelector('[role="menu"]'), null, "a drag never opens a menu");
    assert.equal(launches, 0, "arranging never launches an underlying action");

    // A cancelled drag never persists.
    const before = readMobileRail(key);
    await act(async () => { pointer(grab("host:add"), "pointerdown", 0, 10); pointer(grab("host:add"), "pointermove", 120, 10); pointer(container.querySelector(".mobile-composer-rail")!, "pointercancel"); });
    assert.equal(readMobileRail(key), before);
    assert.deepEqual(run("start"), ["host:add", "widget:test.required", "widget:test.two"], "and the preview is dropped");

    // Arrow keys move along the row and across the space between the runs.
    await act(async () => { grab("widget:test.two").dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event); });
    assert.deepEqual(saved(), [["host:add", "widget:test.required"], ["widget:test.two", "widget:test.one"]]);
    await act(async () => { grab("widget:test.two").dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }) as unknown as Event); });
    assert.deepEqual(saved(), [["host:add", "widget:test.required", "widget:test.two"], ["widget:test.one"]]);

    // The minus badge removes; required launchers have none.
    assert.equal(cell("widget:test.required")!.querySelector(".mobile-composer-cell-remove"), null);
    await act(async () => cell("widget:test.two")!.querySelector<HTMLButtonElement>(".mobile-composer-cell-remove")!.click());
    assert.equal(cell("widget:test.two"), null);
    assert.equal(JSON.stringify(getWidgetLayout()), desktop, "mobile removal must not hide a desktop widget");
    // A removed launcher waits in the tray below the rail; its plus adds it back.
    const tray = () => Array.from(container.querySelectorAll<HTMLButtonElement>(".mobile-composer-tray-item"));
    assert.deepEqual(tray().map((button) => button.getAttribute("aria-label")), ["Add test.two"]);
    await act(async () => tray()[0]!.click());
    assert.deepEqual(saved(), [["host:add", "widget:test.required", "widget:test.two"], ["widget:test.one"]], "an added launcher joins the leading run");
    assert.equal(cell("widget:test.two")!.hasAttribute("data-arrived"), true, "and settles in like an arriving one");
    assert.equal(container.querySelector(".mobile-composer-tray"), null, "an empty tray is not shown");

    // Done ends arranging and the launchers work again.
    const done = Array.from(container.querySelectorAll<HTMLButtonElement>(".mobile-composer-editor-bar button")).at(-1)!;
    await act(async () => done.click());
    assert.equal(editing, false);
    assert.equal(container.querySelector(".mobile-composer-cell-grab"), null);
    assert.equal(container.querySelector<HTMLElement>(".mobile-composer-primary")!.inert, false);
    await act(async () => cell("widget:test.one")!.querySelector<HTMLButtonElement>("button")!.click());
    assert.equal(launches, 1);

    // A disabled package keeps its place for when it returns.
    const persisted = readMobileRail(key);
    await act(async () => offTwo());
    assert.equal(cell("widget:test.two"), null);
    assert.equal(readMobileRail(key), persisted);
    await act(async () => { offTwo = registerWidget(widget("test.two")); });
    assert.deepEqual(run("start"), ["host:add", "widget:test.required", "widget:test.two"], "re-enabled launchers return to their saved place");

    // Rotation mid-drag cancels the drag without losing positions.
    await act(async () => { editing = true; render(); });
    await act(async () => { pointer(grab("host:add"), "pointerdown", 0, 10); pointer(grab("host:add"), "pointermove", 120, 10); window.dispatchEvent(new dom.Event("blur") as unknown as Event); });
    assert.equal(readMobileRail(key), persisted);

    // Reset is the package defaults, saved for this project.
    const reset = Array.from(container.querySelectorAll<HTMLButtonElement>(".mobile-composer-editor-bar button")).find((button) => button.textContent === "Reset")!;
    await act(async () => reset.click());
    assert.deepEqual(saved(), [["host:add", "widget:test.one", "widget:test.required", "widget:test.two"], []]);
    await act(async () => { window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event); });
    assert.equal(editing, false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    offOne(); offTwo(); offRequired();
    width = 358;
  }
});

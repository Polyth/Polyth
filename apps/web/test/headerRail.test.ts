// The top-right header rail is a rail like the top and right ones: curated
// defaults, one home per item across the three rails, drag commits that move
// rather than copy, and a safe one-time cleanup of existing layouts.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  location: dom.location,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  MouseEvent: dom.MouseEvent,
  PointerEvent: dom.PointerEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { fetch?: unknown }).fetch = async (input: string | URL | Request) => {
  const body = String(input).startsWith("/api/git/status")
    ? { branch: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicted: [], clean: true, isRepo: false }
    : [];
  return { ok: true, status: 200, statusText: "OK", json: async () => body, text: async () => JSON.stringify(body) };
};

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerCapability, currentResolvedCapabilities } = await import("../src/capabilities.ts");
const { getCapabilityPlacements } = await import("../src/capabilityLayout.ts");
const { registerSurface } = await import("../src/surfaces.ts");
const { installCapabilityWidgets } = await import("../src/widgets/capabilityWidgets.tsx");
const { installBuiltinMiniWidgets } = await import("../src/widgets/builtinMiniWidgets.tsx");
const { installNotificationCentre } = await import("../src/components/NotificationCentre.tsx");
const widgetLayout = await import("../src/widgets/widgetLayout.ts");
const { activateProject, applyProjectUpsert } = await import("../src/store.ts");
const { setUiSettings } = await import("../src/uiPrefs.ts");
const placement = await import("../src/railPlacement.ts");
const { default: Header } = await import("../src/components/Header.tsx");
const { default: ContextRail } = await import("../src/components/ContextRail.tsx");

const { createDefaultWidgetLayout, parseWidgetLayout, getWidgetLayout, widgetSlotOf } = widgetLayout;
type Definition = import("../src/widgets/widgetLayout.ts").WidgetLayoutDefinition;

const mini = (id: string, defaultSlot: Definition["defaultSlot"], extra: Partial<Definition> = {}): Definition => ({
  id, kind: "mini-widget", defaultSlot, defaultVisible: true, pluginId: id.split(".")[0], title: id, ...extra,
});
// The header widgets the shell and its first-party packages ship today.
const HEADER_WIDGETS: Definition[] = [
  mini("shell.search", "app.header.actions", { supportedSlots: ["app.header.actions", "app.header.center", "workspace.rail"] }),
  mini("shell.history", "session.header.actions", { supportedSlots: ["session.header.actions", "app.header.actions"] }),
  mini("shell.settings", "app.header.actions", { supportedSlots: ["app.header.actions", "app.header.center", "workspace.rail"] }),
  mini("notification.bell", "app.header.actions", { supportedSlots: ["app.header.actions"] }),
  mini("session.goal-action", "session.header.actions", { supportedSlots: ["session.header.actions"] }),
  mini("session.goal-composer-action", "composer.leading", { supportedSlots: ["composer.leading", "composer.trailing"] }),
  mini("permissions.auto-approve-action", "session.header.actions", { supportedSlots: ["session.header.actions"] }),
  mini("voice.mic", "composer.leading", { supportedSlots: ["composer.leading", "app.header.actions"] }),
];

type UiSlot = import("@polyth/contracts").UiSlot;
const visibleIn = (layout: import("../src/widgets/widgetLayout.ts").WidgetLayout, slots: readonly UiSlot[]) =>
  slots.flatMap((slot) => (layout.slotPlacements[slot] ?? []).filter((id) => layout.widgets[id]?.visible));

// ---------------------------------------------------------------- defaults

test("a fresh layout's header rail is exactly Search, Settings and Notifications", () => {
  const layout = createDefaultWidgetLayout(HEADER_WIDGETS);
  assert.deepEqual(visibleIn(layout, placement.HEADER_RAIL_SLOTS), ["shell.search", "shell.settings", "notification.bell"]);
  // Header twins start hidden but stay placed (one click in the editor);
  // their composer counterparts keep their own defaults.
  assert.equal(widgetSlotOf(layout, "session.goal-action"), "session.header.actions");
  assert.equal(layout.widgets["session.goal-composer-action"]?.visible, true);
  assert.equal(layout.widgets["voice.mic"]?.visible, true);
  assert.equal(layout.headerRail, widgetLayout.HEADER_RAIL_LAYOUT_VERSION);
});

type Raw = { visible: boolean; size: { w: number; h: number }; position: { x: number; y: number }; definitionId: string; pluginId?: string; title?: string };
const at = (definitionId: string, visible = true, extra: Partial<Raw> = {}): Raw =>
  ({ visible, size: { w: 1, h: 1 }, position: { x: 0, y: 0 }, definitionId, ...extra });
/** A layout saved before the header was curated, still as the standard
 * arrangement left it, plus things the person placed themselves. */
function preCuration(overrides: Record<string, Raw> = {}, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    audience: "standard",
    zones: { header: [], left: [], main: [], right: [], bottom: [], floating: [] },
    slotPlacements: {
      "session.header.actions": ["shell.history", "session.goal-action", "permissions.auto-approve-action"],
      "app.header.actions": ["shell.search", "voice.mic", "capability:git", "shell.settings", "notification.bell", "home-assistant.status-action", "vendor.thing"],
      "composer.leading": ["session.goal-composer-action"],
    },
    widgets: {
      "shell.history": at("shell.history"),
      // A package that registers after the layout is read is still recognised.
      "session.goal-action": at("session.goal-action", true, { pluginId: "goals", title: "Goal" }),
      "permissions.auto-approve-action": at("permissions.auto-approve-action", true, { pluginId: "permissions", title: "Auto-approve" }),
      "shell.search": at("shell.search"),
      // Moved into the header by the person: kept.
      "voice.mic": at("voice.mic"),
      "capability:git": at("capability:git", true, { pluginId: "capabilities", title: "Git" }),
      "shell.settings": at("shell.settings"),
      "notification.bell": at("notification.bell"),
      // A package header icon that registers later (decided on arrival).
      "home-assistant.status-action": at("home-assistant.status-action", true, { pluginId: "home-assistant", title: "Home" }),
      // Self-describing orphan of a package that never loads: tolerated.
      "vendor.thing": at("vendor.thing", true, { pluginId: "vendor", title: "Thing" }),
      "session.goal-composer-action": at("session.goal-composer-action"),
      ...overrides,
    },
    ...extra,
  };
}
const lateKnown = HEADER_WIDGETS.filter((definition) => !definition.id.startsWith("session.goal-action")
  && !definition.id.startsWith("permissions."));
const homeStatus = mini("home-assistant.status-action", "app.header.actions", { ownerPackageId: "home-assistant" });

test("a pristine pre-curation header is curated without losing placed or hidden items", () => {
  const parsed = parseWidgetLayout(JSON.stringify(preCuration()), lateKnown);
  assert.deepEqual(visibleIn(parsed, placement.HEADER_RAIL_SLOTS), [
    "shell.search", "voice.mic", "capability:git", "shell.settings", "notification.bell",
    "home-assistant.status-action", "vendor.thing",
  ]);
  // Nothing is dropped: curated items are hidden in place.
  assert.deepEqual(parsed.slotPlacements["session.header.actions"],
    ["shell.history", "session.goal-action", "permissions.auto-approve-action"]);
  for (const id of ["shell.history", "session.goal-action", "permissions.auto-approve-action"]) {
    assert.equal(parsed.widgets[id]?.visible, false, id);
  }
  assert.equal(parsed.widgets["session.goal-composer-action"]?.visible, true);
  assert.equal(parsed.headerRail, widgetLayout.HEADER_RAIL_LAYOUT_VERSION);
  // Items without a definition yet are decided when it arrives.
  assert.deepEqual(parsed.headerRailPending, ["capability:git", "home-assistant.status-action", "vendor.thing"]);
  const reread = parseWidgetLayout(widgetLayout.serializeWidgetLayout(parsed), lateKnown);
  assert.deepEqual(reread, parsed, "stable across reloads");
});

test("a late package header icon is curated when its definition arrives", () => {
  const parsed = parseWidgetLayout(JSON.stringify(preCuration()), lateKnown);
  const known = new Map([...lateKnown, homeStatus,
    mini("capability:git", "workspace.rail", { defaultVisible: false })].map((definition) => [definition.id, definition]));
  const curated = widgetLayout.curateHeaderRail(parsed, known);
  assert.equal(curated.widgets["home-assistant.status-action"]?.visible, false, "the standard header icon is hidden");
  assert.equal(curated.widgets["capability:git"]?.visible, true, "a launcher the person placed stays");
  assert.deepEqual(curated.headerRailPending, ["vendor.thing"], "only still-unknown items wait");
  // Once decided, a person who shows it again keeps it.
  const shown = widgetLayout.setWidgetVisible(curated, "home-assistant.status-action", true);
  assert.equal(widgetLayout.curateHeaderRail(shown, known).widgets["home-assistant.status-action"]?.visible, true);
});

test("a header the person already rearranged is never curated", () => {
  // History hidden by the person before the curation existed.
  const parsed = parseWidgetLayout(JSON.stringify(preCuration({ "shell.history": at("shell.history", false) })), lateKnown);
  assert.equal(parsed.widgets["session.goal-action"]?.visible, true);
  assert.equal(parsed.widgets["permissions.auto-approve-action"]?.visible, true);
  assert.equal(parsed.widgets["home-assistant.status-action"]?.visible, true);
  assert.equal(parsed.headerRailPending, undefined);
  assert.equal(widgetLayout.headerRailIsPristine(parsed), false);
});

test("an older client dropping the marker does not re-hide items the person brought back", () => {
  const curated = parseWidgetLayout(JSON.stringify(preCuration()), lateKnown);
  const restored = widgetLayout.setWidgetVisible(curated, "shell.history", true);
  // An older client rewrites the record without the fields it does not know.
  const { headerRail: _marker, headerRailPending: _pending, ...older } = restored;
  const reread = parseWidgetLayout(JSON.stringify(older), lateKnown);
  assert.equal(reread.widgets["shell.history"]?.visible, true);
  assert.equal(reread.widgets["session.goal-action"]?.visible, false, "the curated items stay as they were");
  assert.equal(reread.headerRail, widgetLayout.HEADER_RAIL_LAYOUT_VERSION);
});

test("the dedupe picks its winner after the header curation", () => {
  const known = [...lateKnown,
    mini("session.goal-action", "session.header.actions", { supportedSlots: ["session.header.actions", "composer.leading"] })];
  const raw = preCuration({ "session.goal-action#2": at("session.goal-action") });
  (raw.slotPlacements["composer.leading"] as string[]).push("session.goal-action#2");
  const parsed = parseWidgetLayout(JSON.stringify(raw), known);
  assert.equal(parsed.widgets["session.goal-action"]?.visible, false, "curated out of the header");
  assert.equal(parsed.widgets["session.goal-action#2"]?.visible, true, "the remaining instance still shows");
});

test("a widget shown in two areas is deduplicated deterministically on load", () => {
  const known = [
    mini("sample.one", "app.header.actions", { supportedSlots: ["app.header.actions", "workspace.rail"] }),
    mini("sample.many", "workspace.rail", { supportedSlots: ["app.header.actions", "workspace.rail"], duplicatable: true }),
  ];
  const raw = JSON.stringify({
    version: 1,
    audience: "standard",
    headerRail: widgetLayout.HEADER_RAIL_LAYOUT_VERSION,
    zones: { header: [], left: [], main: [], right: [], bottom: [], floating: [] },
    slotPlacements: {
      "app.header.actions": ["sample.one", "sample.many"],
      "workspace.rail": ["sample.one#2", "sample.many#2"],
    },
    widgets: {
      "sample.one": { visible: true, size: { w: 1, h: 1 }, position: { x: 0, y: 0 }, definitionId: "sample.one" },
      "sample.one#2": { visible: true, size: { w: 1, h: 1 }, position: { x: 0, y: 0 }, definitionId: "sample.one" },
      "sample.many": { visible: true, size: { w: 1, h: 1 }, position: { x: 0, y: 0 }, definitionId: "sample.many" },
      "sample.many#2": { visible: true, size: { w: 1, h: 1 }, position: { x: 0, y: 0 }, definitionId: "sample.many" },
    },
  });
  const first = parseWidgetLayout(raw, known);
  const shownOne = Object.entries(first.widgets)
    .filter(([, value]) => value.visible && value.definitionId === "sample.one").map(([id]) => id);
  assert.equal(shownOne.length, 1, "a non-duplicatable widget is shown once");
  assert.deepEqual(parseWidgetLayout(raw, known), first, "the same record always resolves the same way");
  assert.equal(first.widgets["sample.many#2"]?.visible, true, "duplicatable widgets keep every instance");
  assert.ok(Object.keys(first.widgets).includes("sample.one#2"), "the hidden duplicate stays placed");
});

test("header order maps onto its two areas with the fewest moves", () => {
  const both = ["session.header.actions", "app.header.actions"] as const;
  const app = ["app.header.actions"] as const;
  const session = ["session.header.actions"] as const;
  // Kept areas when the order already fits.
  assert.deepEqual(placement.headerRailSlots([
    { slot: "session.header.actions", supports: session },
    { slot: "app.header.actions", supports: app },
  ]), ["session.header.actions", "app.header.actions"]);
  // An item that may live in either area crosses the boundary instead of
  // snapping back; arrivals prefer the application area.
  assert.deepEqual(placement.headerRailSlots([
    { slot: "app.header.actions", supports: both },
    { slot: "session.header.actions", supports: session },
    { slot: null, supports: both },
  ]), ["session.header.actions", "session.header.actions", "app.header.actions"]);
  // No valid split: everything keeps its area (the row redraws grouped).
  assert.deepEqual(placement.headerRailSlots([
    { slot: "app.header.actions", supports: app },
    { slot: "session.header.actions", supports: session },
  ]), ["app.header.actions", "session.header.actions"]);
});

// ---------------------------------------------------------------- live store

const PROJECT = "header-rail-project";
let installed = false;
function setup(): void {
  if (installed) return;
  installed = true;
  // These tests draw the top bar; a fresh install's window has none.
  setUiSettings({ shellLayout: "classic" });
  applyProjectUpsert({ id: PROJECT, path: "/work/header-rail", name: "Header rail", createdAt: 1 });
  activateProject(PROJECT);
  for (const [id, tier, rank] of [["hr-files", "primary", 60], ["hr-git", "more", 60]] as const) {
    registerCapability({
      id, label: id.replace("hr-", "Hr "), plainDescription: "", keywords: [],
      standardTier: tier, standardRank: rank, open: () => {}, available: () => true,
    });
    registerSurface({ id, capabilityId: id, title: id, order: 90, component: () => null });
  }
  installBuiltinMiniWidgets();
  installNotificationCentre();
  installCapabilityWidgets();
}

const homeOf = (id: string) => placement.capabilityHomes(
  currentResolvedCapabilities(), getCapabilityPlacements(), getWidgetLayout(), placement.railDestinationIds(),
).get(id);
const headerOrder = () => visibleIn(getWidgetLayout(), placement.HEADER_RAIL_SLOTS)
  .map((instanceId) => placement.railItemIdOfInstance(getWidgetLayout(), instanceId));

test("the header bell and the Notifications rail icon are one item with one home", () => {
  setup();
  assert.deepEqual(headerOrder(), ["widget:shell.search", "widget:shell.settings", "notification-centre"]);
  assert.equal(placement.capabilityIdOfWidget("notification.bell"), "notification-centre");
  assert.equal(placement.capabilityWidgetId("notification-centre"), "notification.bell");
  assert.equal(homeOf("notification-centre"), "app.header.actions", "the bell is its home, not the right rail");

  placement.commitRailZoneOrder("right", ["notification-centre", "hr-git"]);
  assert.equal(homeOf("notification-centre"), "workspace.rail");
  assert.equal(getWidgetLayout().widgets["notification.bell"]?.visible, false, "the bell left the header");

  placement.commitRailZoneOrder("header", ["widget:shell.search", "widget:shell.settings", "notification-centre"]);
  assert.equal(homeOf("notification-centre"), "app.header.actions");
  assert.deepEqual(headerOrder(), ["widget:shell.search", "widget:shell.settings", "notification-centre"]);
  assert.equal(getCapabilityPlacements()["notification-centre"]?.tier, "technical", "it left the right rail");
});

test("dragging between the header, right and top rails moves items, never copies", () => {
  setup();
  // Right rail → header: the capability becomes a header launcher.
  placement.commitRailZoneOrder("header", ["hr-git", ...headerOrder()]);
  assert.equal(homeOf("hr-git"), "app.header.actions");
  assert.equal(headerOrder()[0], "hr-git");
  // Header → top rail.
  placement.commitRailZoneOrder("top", ["hr-files", "hr-git"]);
  assert.equal(homeOf("hr-git"), "app.header.center");
  assert.equal(getWidgetLayout().widgets["capability:hr-git"]?.visible, false);
  assert.ok(!headerOrder().includes("hr-git"));
  // A shell widget: header → right rail → header, reordered.
  assert.equal(placement.railWidgetFits("right", "widget:shell.search"), true);
  placement.commitRailZoneOrder("right", ["widget:shell.search"]);
  assert.equal(widgetSlotOf(getWidgetLayout(), "shell.search"), "workspace.rail");
  assert.ok(!headerOrder().includes("widget:shell.search"));
  placement.commitRailZoneOrder("header", ["widget:shell.settings", "widget:shell.search", "notification-centre"]);
  assert.deepEqual(headerOrder(), ["widget:shell.settings", "widget:shell.search", "notification-centre"]);
  // Items a rail cannot hold are refused, not dropped somewhere odd.
  assert.equal(placement.railWidgetFits("top", "widget:session.goal-composer-action"), false);
  assert.equal(placement.headerAcceptsCapability("session"), false);
});

test("the mounted header rail and right rail never draw the same item twice", async () => {
  setup();
  placement.commitRailZoneOrder("header", ["widget:shell.search", "widget:shell.settings", "notification-centre"]);
  const mount = async (node: ReturnType<typeof createElement>) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(node); await new Promise((resolve) => setTimeout(resolve, 0)); });
    return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
  };
  const header = await mount(createElement(Header));
  const rail = await mount(createElement(ContextRail));
  try {
    const items = [...header.container.querySelectorAll<HTMLElement>(".header-actions-rail > [data-rail-item]")];
    assert.deepEqual(items.map((item) => item.dataset.railItem), ["widget:shell.search", "widget:shell.settings", "notification-centre"]);
    assert.equal(rail.container.querySelector('[data-rail-item="notification-centre"]'), null, "no second bell on the right rail");

    // Alt+→ on the focused Search moves it one place along the header rail.
    const search = items[0]!.querySelector<HTMLButtonElement>("button")!;
    search.focus();
    await act(async () => {
      search.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }) as unknown as Event);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.deepEqual(headerOrder(), ["widget:shell.settings", "widget:shell.search", "notification-centre"]);
    assert.equal(document.activeElement?.getAttribute("aria-label"), search.getAttribute("aria-label"), "focus follows the moved item");
  } finally {
    await header.unmount();
    await rail.unmount();
  }
});

test("a stored pre-curation layout curates late package header icons through ensureWidgets", () => {
  setup();
  const project = "header-rail-legacy";
  localStorage.setItem(widgetLayout.widgetLayoutStorageKey(project), JSON.stringify(preCuration()));
  applyProjectUpsert({ id: project, path: "/work/legacy", name: "Legacy", createdAt: 2 });
  activateProject(project);
  try {
    assert.equal(getWidgetLayout().widgets["home-assistant.status-action"]?.visible, true, "undecided until it registers");
    assert.ok(getWidgetLayout().headerRailPending?.includes("home-assistant.status-action"));
    widgetLayout.ensureWidgets([homeStatus]);
    assert.equal(getWidgetLayout().widgets["home-assistant.status-action"]?.visible, false);
    assert.ok(!getWidgetLayout().headerRailPending?.includes("home-assistant.status-action"));
    assert.equal(getWidgetLayout().widgets["shell.history"]?.visible, false);
  } finally {
    activateProject(PROJECT);
  }
});

test("reordering a rail keeps launcher widgets that live there as widgets", () => {
  setup();
  // A capability with no right-pane destination cannot be a right-rail tier
  // icon; as a launcher widget it can still live in the right rail.
  registerCapability({
    id: "hr-nodest", label: "Hr nodest", plainDescription: "", keywords: [],
    standardTier: "technical", standardRank: 70, open: () => {}, available: () => true,
  });
  placement.placeCapability("hr-nodest", { slot: "workspace.rail" });
  assert.equal(getWidgetLayout().widgets["capability:hr-nodest"]?.visible, true);
  placement.commitRailZoneOrder("right", ["widget:shell.search", "hr-nodest"]);
  placement.commitRailZoneOrder("right", ["hr-git", "hr-nodest", "widget:shell.search"]);
  assert.equal(getWidgetLayout().widgets["capability:hr-nodest"]?.visible, true, "still shown, not converted");
  assert.notEqual(getCapabilityPlacements()["hr-nodest"]?.tier, "more", "no right-rail tier icon it cannot draw");
  assert.deepEqual(getWidgetLayout().slotPlacements["workspace.rail"]?.filter((id) => getWidgetLayout().widgets[id]?.visible),
    ["capability:hr-nodest", "shell.search"], "reordered by place");
  // Put things back for the remaining tests.
  placement.removeCapability("hr-nodest", "workspace.rail");
  placement.commitRailZoneOrder("header", ["widget:shell.search", "widget:shell.settings", "notification-centre"]);
});

test("Shift-customize gives rail widgets their HTML5 drag and shows unavailable ones", async () => {
  setup();
  const { registerWidgetPlugin } = await import("../src/widgets/catalog.ts");
  const off = registerWidgetPlugin({
    id: "hr-test",
    name: "Header rail test",
    widgets: [{
      id: "hr-test.session-only", title: "Session only", description: "", kind: "mini-widget",
      defaultSlot: "app.header.actions", supportedSlots: ["app.header.actions"], defaultVisible: false,
      isAvailable: () => false,
      render: () => createElement("button", { type: "button", "aria-label": "Session only" }),
    }],
  });
  widgetLayout.updateWidgetLayout((current) => widgetLayout.setWidgetVisible(current, "hr-test.session-only", true));
  const media = window.matchMedia;
  // A mouse: Shift may arm customize. Other queries keep their answers.
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) =>
    query === "(hover: hover) and (pointer: fine)" || query === "(any-pointer: coarse)"
      ? { matches: query === "(hover: hover) and (pointer: fine)", media: query, addEventListener() {}, removeEventListener() {} }
      : media.call(window, query);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const press = (key: string, type: "keydown" | "keyup") =>
    window.dispatchEvent(new dom.KeyboardEvent(type, { key, bubbles: true }) as unknown as Event);
  try {
    await act(async () => { root.render(createElement(Header)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const item = (id: string) => container.querySelector<HTMLElement>(`.header-actions-rail > [data-rail-item="${id}"]`);
    assert.equal(item("widget:hr-test.session-only"), null, "unavailable outside customize");
    assert.equal(item("widget:shell.search")?.querySelector("[draggable]"), null, "pointer drag only");

    await act(async () => { press("Shift", "keydown"); });
    const search = item("widget:shell.search");
    const native = search?.querySelector<HTMLElement>(".placed-mini-widget");
    assert.equal(native?.getAttribute("draggable"), "true", "HTML5 drag to the Canvas or status bar");
    assert.equal(native?.dataset.widgetEditing, "true");
    assert.ok(item("widget:hr-test.session-only"), "shown while customizing");
    // The rail's pointer drag stays off a natively draggable item.
    const button = search!.querySelector("button")!;
    await act(async () => {
      button.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 7, clientX: 10, clientY: 10 }) as unknown as Event);
      window.dispatchEvent(new dom.PointerEvent("pointermove", { pointerId: 7, clientX: 40, clientY: 10 }) as unknown as Event);
    });
    const lifted = document.body.dataset.railDragging;
    await act(async () => {
      window.dispatchEvent(new dom.PointerEvent("pointerup", { pointerId: 7, clientX: 40, clientY: 10 }) as unknown as Event);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.equal(lifted, undefined, "no rail drag lifts mid-gesture");

    await act(async () => { press("Shift", "keyup"); });
    assert.equal(item("widget:shell.search")?.querySelector("[draggable]"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    (window as unknown as { matchMedia: unknown }).matchMedia = media;
    widgetLayout.updateWidgetLayout((current) => widgetLayout.setWidgetVisible(current, "hr-test.session-only", false));
    off();
  }
});

// ---------------------------------------------------------------- one order per rail

test("a never-rearranged rail keeps its current order; new items join after their neighbour", () => {
  // Migration: no stored order → the rail's split order (launchers, panels,
  // widgets) is its unified order, unchanged.
  const natural = ["files", "terminal", "widget:shell.search"];
  assert.deepEqual(placement.orderRailItems(natural, undefined), natural);
  // A stored mixed order wins; stale ids drop; an arrival lands right after
  // the item it follows naturally.
  assert.deepEqual(
    placement.orderRailItems(["files", "browser", "terminal", "widget:shell.search"], ["widget:shell.search", "gone", "terminal", "files"]),
    ["widget:shell.search", "terminal", "files", "browser"],
  );
  assert.deepEqual(placement.orderRailItems(["new", "files"], ["files"]), ["new", "files"], "no predecessor: first");
});

async function mountRails() {
  const mountOne = async (node: ReturnType<typeof createElement>) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(node); await new Promise((resolve) => setTimeout(resolve, 0)); });
    return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
  };
  const header = await mountOne(createElement(Header));
  const rail = await mountOne(createElement(ContextRail));
  const ids = (container: HTMLElement, selector: string) =>
    [...container.querySelectorAll<HTMLElement>(`${selector} > [data-rail-item]`)].map((item) => item.dataset.railItem ?? "");
  return {
    top: () => ids(header.container, ".view-switcher-pill"),
    header: () => ids(header.container, ".header-actions-rail"),
    right: () => ids(rail.container, ".rail-icon-scroll"),
    unmount: async () => { await header.unmount(); await rail.unmount(); },
  };
}

test("a rail keeps one mixed order exactly as dropped, across reloads", async () => {
  setup();
  const { capabilityLayoutStorageKey, parseCapabilityLayout } = await import("../src/capabilityLayout.ts");
  for (const id of ["hr-top2", "hr-top3"]) {
    registerCapability({ id, label: id, plainDescription: "", keywords: [], standardTier: "primary", standardRank: 61, open: () => {}, available: () => true });
    registerSurface({ id, capabilityId: id, title: id, order: 91, component: () => null });
  }
  let rails = await mountRails();
  const before = rails.top();
  await rails.unmount();
  assert.ok(before.length >= 2, JSON.stringify(before));
  // Settings comes from the header and lands BETWEEN two launchers; the
  // last launcher moves to the front.
  const expected = [before.at(-1)!, before[0]!, "widget:shell.settings", ...before.slice(1, -1)];
  placement.commitRailZoneOrder("top", expected);
  rails = await mountRails();
  try {
    assert.deepEqual(rails.top(), expected);
    assert.ok(!rails.header().includes("widget:shell.settings"), "it left the header");
  } finally { await rails.unmount(); }
  const stored = parseCapabilityLayout(localStorage.getItem(capabilityLayoutStorageKey(PROJECT)));
  assert.deepEqual(stored.railOrder?.top, expected);
  // Reload: leave and re-open the project, re-reading the stored records.
  activateProject("header-rail-elsewhere");
  activateProject(PROJECT);
  rails = await mountRails();
  try {
    assert.deepEqual(rails.top(), expected);
  } finally { await rails.unmount(); }
});

test("a cross-rail move lands at the drop index", async () => {
  setup();
  let rails = await mountRails();
  const right = rails.right();
  const top = rails.top();
  await rails.unmount();
  // A top-rail launcher dropped at index 1 of the right rail, and the
  // Settings widget dropped at index 0.
  const moved = top.find((id) => !id.startsWith("widget:"))!;
  const expected = ["widget:shell.settings", right[0]!, moved, ...right.slice(1)];
  placement.commitRailZoneOrder("right", expected);
  rails = await mountRails();
  try {
    assert.deepEqual(rails.right(), expected);
    assert.ok(!rails.top().includes(moved) && !rails.top().includes("widget:shell.settings"), "left the top rail");
  } finally { await rails.unmount(); }
  // Back to the header, at its front.
  placement.commitRailZoneOrder("header", ["widget:shell.settings", ...headerOrder()]);
  assert.equal(headerOrder()[0], "widget:shell.settings");
});

test("every rail item can be hidden: launchers, Terminal, panels and widgets", async () => {
  setup();
  const { registerSlot } = await import("../src/slots.ts");
  // A plugin panel that is not a capability.
  const off = registerSlot("workspace.right.tabs", "hr-panel", () => null, 0, { title: "Hr panel" });
  let rails = await mountRails();
  try {
    assert.ok(rails.right().includes("slot:hr-panel"), "the panel button is a right-rail item");
  } finally { await rails.unmount(); }
  placement.removeCapability("slot:hr-panel", "workspace.rail");
  placement.removeCapability("terminal", "workspace.rail");
  placement.removeCapability("hr-git", "workspace.rail");
  widgetLayout.updateWidgetLayout((current) => widgetLayout.setWidgetVisible(current, "shell.search", false));
  rails = await mountRails();
  try {
    const all = [...rails.top(), ...rails.right(), ...rails.header()];
    for (const id of ["slot:hr-panel", "terminal", "hr-git", "widget:shell.search"]) assert.ok(!all.includes(id), id);
  } finally {
    await rails.unmount();
    off();
    widgetLayout.updateWidgetLayout((current) => widgetLayout.setWidgetVisible(current, "shell.search", true));
  }
  // The editors lock nothing.
  const { default: CustomizeZoneButton } = await import("../src/components/CustomizeZoneButton.tsx");
  for (const props of [
    { slot: "app.header.center" as const, tier: "primary" as const },
    { slot: "workspace.rail" as const, tier: "more" as const },
    { slot: "app.header.actions" as const, slots: placement.HEADER_RAIL_SLOTS },
  ]) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(createElement(CustomizeZoneButton, props)); });
    await act(async () => { container.querySelector<HTMLButtonElement>(".zone-customize-trigger")!.click(); });
    assert.equal(document.querySelectorAll(".rail-editor-lock").length, 0, `${props.slot} pins nothing`);
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a rail item pulled off its rail leaves like the editor's minus: hidden in place, launchers to Technical", async () => {
  setup();
  const { registerSlot } = await import("../src/slots.ts");
  const off = registerSlot("workspace.right.tabs", "hr-pull-panel", () => null, 0, { title: "Hr pull panel" });
  // A launcher that lives in the top rail as its widget, not as a tier icon.
  registerCapability({
    id: "hr-pull-widget", label: "Hr pull widget", plainDescription: "", keywords: [],
    standardTier: "technical", standardRank: 72, open: () => {}, available: () => true,
  });
  placement.placeCapability("hr-pull-widget", { slot: "app.header.center" });
  placement.placeCapability("hr-files", { tier: "primary" });
  placement.placeCapability("hr-git", { tier: "more" });
  placement.commitRailZoneOrder("header", ["widget:shell.search", "widget:shell.settings", "notification-centre"]);
  let rails = await mountRails();
  try {
    assert.ok(rails.top().includes("hr-files") && rails.top().includes("hr-pull-widget"), JSON.stringify(rails.top()));
    assert.ok(rails.right().includes("hr-git") && rails.right().includes("slot:hr-pull-panel"), JSON.stringify(rails.right()));
    assert.deepEqual(rails.header(), ["widget:shell.search", "widget:shell.settings", "notification-centre"]);
  } finally { await rails.unmount(); }

  placement.removeRailItem("top", "hr-files");
  placement.removeRailItem("top", "hr-pull-widget");
  placement.removeRailItem("right", "hr-git");
  placement.removeRailItem("right", "slot:hr-pull-panel");
  placement.removeRailItem("header", "widget:shell.search");
  placement.removeRailItem("header", "notification-centre");

  rails = await mountRails();
  try {
    const all = [...rails.top(), ...rails.right(), ...rails.header()];
    for (const id of ["hr-files", "hr-pull-widget", "hr-git", "slot:hr-pull-panel", "widget:shell.search", "notification-centre"]) {
      assert.ok(!all.includes(id), `${id} is off every rail`);
    }
    assert.ok(rails.header().includes("widget:shell.settings"), "its neighbours stay");
  } finally { await rails.unmount(); }
  const layout = getWidgetLayout();
  const placements = getCapabilityPlacements();
  // Launchers stay one click away under Technical; widgets stay placed, hidden.
  for (const id of ["hr-files", "hr-pull-widget", "hr-git", "slot:hr-pull-panel"]) {
    assert.equal(placements[id]?.tier, "technical", id);
  }
  assert.equal(layout.widgets["capability:hr-pull-widget"]?.visible, false);
  assert.equal(layout.widgets["shell.search"]?.visible, false);
  assert.equal(layout.widgets["notification.bell"]?.visible, false);
  assert.ok(layout.slotPlacements["app.header.actions"]?.includes("shell.search"), "hidden in place, not deleted");

  // Put the shared arrangement back for the remaining tests.
  off();
  widgetLayout.updateWidgetLayout((current) => widgetLayout.setWidgetVisible(current, "shell.search", true));
  widgetLayout.updateWidgetLayout((current) => widgetLayout.setWidgetVisible(current, "notification.bell", true));
  placement.removeCapability("hr-pull-widget", "app.header.center");
  placement.commitRailZoneOrder("header", ["widget:shell.search", "widget:shell.settings", "notification-centre"]);
  placement.placeCapability("hr-git", { tier: "more" });
  placement.placeCapability("hr-files", { tier: "primary" });
});

test("a widget its package requires cannot be pulled off a rail", () => {
  setup();
  const required = mini("hr.required", "app.header.actions", {
    supportedSlots: ["app.header.actions", "app.header.center"], requiredVisible: true,
  });
  const optional = mini("hr.optional", "app.header.actions", { supportedSlots: ["app.header.actions", "app.header.center"] });
  const layout = createDefaultWidgetLayout([required, optional]);
  assert.equal(placement.railItemRemovable("widget:hr.required", layout), false);
  assert.equal(placement.railItemRemovable("widget:hr.optional", layout), true);
  assert.equal(placement.railItemRemovable("hr-files", layout), true, "a launcher always can");
  assert.equal(placement.railItemRemovable("widget:not-placed", layout), true);

  // Even asked directly, the live layout keeps it.
  widgetLayout.ensureWidgets([required]);
  assert.equal(getWidgetLayout().widgets["hr.required"]?.visible, true);
  placement.removeRailItem("header", "widget:hr.required");
  assert.equal(getWidgetLayout().widgets["hr.required"]?.visible, true, "still on its rail");
});

test("full-height window layouts render every top-bar group exactly once, where the layout puts it", async () => {
  setup();
  const ui = await import("../src/uiPrefs.ts");
  const before = ui.getUiSettings();
  const rails = await mountRails();
  const query = (selector: string) => document.querySelectorAll(selector).length;
  const settle = async (patch: Partial<import("../src/uiPrefs.ts").UiSettings>) => {
    await act(async () => { ui.setUiSettings(patch); await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  try {
    // Classic: the bar holds the mark, tools and actions; no column dock.
    assert.equal(query(".shell-dock"), 0);
    assert.equal(query(".header .header-actions-rail"), 1);
    assert.equal(query(".header .header-brand"), 1);
    const actionIds = (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(`${selector} .header-actions-rail > [data-rail-item]`)].map((item) => item.dataset.railItem);
    const classicActions = actionIds(".header");
    assert.ok(classicActions.length > 0);

    // Columns: the bar keeps tools and actions; the mark leaves for the
    // navigator column (Sidebar renders it there).
    await settle({ shellLayout: "columns", shellBarStyle: "spread" });
    assert.equal(query(".header .header-brand"), 0, "the mark is not drawn twice");
    assert.equal(query(".header .header-actions-rail"), 1);
    assert.equal(query(".header .view-switcher"), 1);
    assert.equal(query(".shell-dock"), 0);

    // Island: the same groups inside one glass capsule.
    await settle({ shellBarStyle: "island" });
    assert.equal(query(".header > .shell-island.ui-glass-island .header-actions-rail"), 1);

    // Bare, docked right: the strip carries both groups, vertically, and the
    // bar draws none of them.
    await settle({ shellLayout: "bare", shellToolsDock: "end", shellActionsDock: "end" });
    assert.equal(query(".header .header-actions-rail"), 0);
    assert.equal(query(".header .view-switcher"), 0);
    assert.equal(query('.plugin-strip > .shell-dock--tools[data-orientation="vertical"] .view-switcher-pill'), 1);
    assert.equal(query(".plugin-strip > .shell-dock--actions .header-actions-rail"), 1);
    assert.deepEqual(actionIds(".shell-dock--actions"), classicActions, "the docked actions are the header rail itself, in its order");
    assert.equal(query('[data-rail-item="notification-centre"]'), 1, "one bell");

    // Hidden groups render nowhere; the palette still reaches them.
    await settle({ shellToolsDock: "hidden", shellActionsDock: "hidden" });
    assert.equal(query(".shell-dock"), 0);
    assert.equal(query(".header-actions-rail"), 0);
  } finally {
    await settle({
      shellLayout: before.shellLayout,
      shellBarStyle: before.shellBarStyle,
      shellToolsDock: before.shellToolsDock,
      shellActionsDock: before.shellActionsDock,
    });
    await rails.unmount();
  }
});

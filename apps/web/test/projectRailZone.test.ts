// The navigator's Project rail is a rail like the top, right and header ones:
// its icon area (`sidebar.rail`, zone `sidebar`) takes launchers dragged in
// from the other rails, gives them back, reorders, drops an icon pulled away,
// and its Customize pencil edits that same area. Before, the pencil edited
// `sidebar.toolbar`, which the rail never draws, so nothing it added or
// removed ever showed up there and no icon could be dragged onto the rail.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
(globalThis as { fetch?: unknown }).fetch = async () =>
  ({ ok: true, status: 200, statusText: "OK", json: async () => [], text: async () => "[]" });

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { UI_SLOTS } = await import("@polyth/contracts");
const { registerCapability, currentResolvedCapabilities } = await import("../src/capabilities.ts");
const { getCapabilityPlacements } = await import("../src/capabilityLayout.ts");
const { registerSurface } = await import("../src/surfaces.ts");
const { installCapabilityWidgets } = await import("../src/widgets/capabilityWidgets.tsx");
const { installBuiltinMiniWidgets } = await import("../src/widgets/builtinMiniWidgets.tsx");
const { getWidgetLayout } = await import("../src/widgets/widgetLayout.ts");
const { activateProject, applyProjectUpsert } = await import("../src/store.ts");
const placement = await import("../src/railPlacement.ts");
const { ProjectRailTools } = await import("../src/components/sidebar/ProjectRailTools.tsx");

const PROJECT = "project-rail-zone";
applyProjectUpsert({ id: PROJECT, path: "/work/project-rail", name: "Project rail", createdAt: 1 });
activateProject(PROJECT);
for (const [id, tier, rank] of [["pr-files", "primary", 60], ["pr-git", "more", 60]] as const) {
  registerCapability({
    id, label: id.replace("pr-", "Pr "), plainDescription: "", keywords: [],
    standardTier: tier, standardRank: rank, open: () => {}, available: () => true,
  });
  registerSurface({ id, capabilityId: id, title: id, order: 90, component: () => null });
}
installBuiltinMiniWidgets();
installCapabilityWidgets();

const homeOf = (id: string) => placement.capabilityHomes(
  currentResolvedCapabilities(), getCapabilityPlacements(), getWidgetLayout(), placement.railDestinationIds(),
).get(id);
const railOrder = () => (getWidgetLayout().slotPlacements[placement.SIDEBAR_RAIL_SLOT] ?? [])
  .filter((instanceId) => getWidgetLayout().widgets[instanceId]?.visible)
  .map((instanceId) => placement.railItemIdOfInstance(getWidgetLayout(), instanceId));

test("the Project rail is a named icon area and a drag zone", () => {
  assert.ok((UI_SLOTS as readonly string[]).includes("sidebar.rail"));
  assert.ok((placement.ICON_RAIL_SLOTS as readonly string[]).includes("sidebar.rail"));
  assert.deepEqual(placement.RAIL_ZONE_SLOTS.sidebar, ["sidebar.rail"]);
  assert.equal(placement.sidebarRailAcceptsCapability("pr-git"), true, "a launcher fits the rail");
  assert.equal(placement.sidebarRailAcceptsCapability("session"), false, "Chat is not a launcher");
  assert.equal(placement.railWidgetFits("sidebar", "widget:shell.search"), true, "Search can live on it");
});

test("Add project is a rail item: shown by default, removable and back from the editor", () => {
  // It used to be a fixed footer button the rail editor could not touch.
  assert.deepEqual(railOrder(), ["widget:shell.add-project"]);
  assert.equal(placement.railItemRemovable("widget:shell.add-project"), true);
  placement.removeRailItem("sidebar", "widget:shell.add-project");
  assert.deepEqual(railOrder(), []);
  assert.equal(getWidgetLayout().widgets["shell.add-project"]?.visible, false, "hidden, not deleted");
});

test("icons move onto the Project rail, reorder there and leave for another rail", () => {
  // Right rail → Project rail: one home, never a copy.
  assert.equal(homeOf("pr-git"), "workspace.rail");
  placement.commitRailZoneOrder("sidebar", ["pr-git"]);
  assert.equal(homeOf("pr-git"), "sidebar.rail");
  assert.equal(getCapabilityPlacements()["pr-git"]?.tier, "technical", "it left the right rail");
  assert.deepEqual(railOrder(), ["pr-git"]);

  // Header → Project rail, landing first; then sorted.
  placement.commitRailZoneOrder("sidebar", ["widget:shell.search", "pr-git"]);
  assert.deepEqual(railOrder(), ["widget:shell.search", "pr-git"]);
  assert.equal(getWidgetLayout().widgets["shell.search"]?.visible, true);
  placement.commitRailZoneOrder("sidebar", ["pr-git", "widget:shell.search"]);
  assert.deepEqual(railOrder(), ["pr-git", "widget:shell.search"]);

  // Project rail → top rail: it leaves the Project rail.
  placement.commitRailZoneOrder("top", ["pr-files", "pr-git"]);
  assert.equal(homeOf("pr-git"), "app.header.center");
  assert.deepEqual(railOrder(), ["widget:shell.search"]);

  // Pulled away and released: taken off the rail.
  placement.removeRailItem("sidebar", "widget:shell.search");
  assert.deepEqual(railOrder(), []);
});

test("the mounted Project rail draws its icons and Alt+↓ sorts them", async () => {
  placement.placeCapability("pr-git", { slot: placement.SIDEBAR_RAIL_SLOT });
  placement.placeCapability("pr-files", { slot: placement.SIDEBAR_RAIL_SLOT });
  assert.deepEqual(railOrder(), ["pr-git", "pr-files"]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ProjectRailTools, { projectId: PROJECT, sessionId: null }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  try {
    const zone = container.querySelector<HTMLElement>(".sidebar-project-rail-tools")!;
    const items = () => [...zone.querySelectorAll<HTMLElement>(":scope > [data-rail-item]")].map((item) => item.dataset.railItem);
    assert.deepEqual(items(), ["pr-git", "pr-files"]);
    assert.equal(zone.dataset.empty, undefined);
    const first = zone.querySelector<HTMLElement>('[data-rail-item="pr-git"]')!;
    await act(async () => {
      first.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }) as unknown as Event);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.deepEqual(railOrder(), ["pr-files", "pr-git"]);
    assert.deepEqual(items(), ["pr-files", "pr-git"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the open editor lists the rail's own icons and leaves the rail draggable", async () => {
  const { default: CustomizeZoneButton } = await import("../src/components/CustomizeZoneButton.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const outside = document.createElement("button");
  document.body.appendChild(outside);
  const press = async (target: Element) => {
    await act(async () => {
      target.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  await act(async () => {
    root.render(createElement("div", { className: "sidebar-project-rail" },
      createElement(ProjectRailTools, { projectId: PROJECT, sessionId: null }),
      createElement("div", { className: "sidebar-project-rail-actions customize-zone" },
        createElement(CustomizeZoneButton, { slot: placement.SIDEBAR_RAIL_SLOT, liveRegion: ".sidebar-project-rail" }))));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  try {
    const trigger = container.querySelector<HTMLElement>(".zone-customize-trigger")!;
    assert.equal(trigger.getAttribute("aria-label"), "Customize Project rail");
    await act(async () => { trigger.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const shown = () => [...document.body.querySelectorAll(".rail-editor-shown .rail-editor-row-label")].map((label) => label.textContent);
    assert.deepEqual(shown(), ["Pr files", "Pr git"], "Shown here is exactly what the rail draws, in its order");
    assert.equal(document.body.querySelector(".ui-popover-backdrop"), null, "no backdrop over the rail");

    // A press on a rail icon (the start of a drag) keeps the editor open.
    await press(container.querySelector('[data-rail-item="pr-git"]')!);
    assert.ok(document.body.querySelector(".rail-editor"), "the rail stays a live preview");
    // A press anywhere else closes it, like the backdrop did.
    await press(outside);
    assert.equal(document.body.querySelector(".rail-editor"), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    outside.remove();
  }
});

test("the Project rail's pencil edits the area the rail draws and keeps the rail live", () => {
  const sidebar = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
  const rail = sidebar.slice(sidebar.indexOf('className="sidebar-project-rail"'), sidebar.indexOf("{!compact && <ShellColumnAccount />}"));
  assert.match(rail, /<ProjectRailTools /, "the rail draws its own icon area");
  assert.match(rail, /<CustomizeZoneButton\s+slot=\{SIDEBAR_RAIL_SLOT\}[\s\S]*?liveRegion="\.sidebar-project-rail"/);
  assert.doesNotMatch(rail, /CustomizeZoneButton slot="sidebar\.toolbar"/, "not the sessions toolbar's editor");
  const tools = readFileSync(new URL("../src/components/sidebar/ProjectRailTools.tsx", import.meta.url), "utf8");
  assert.match(tools, /id: "sidebar",[\s\S]*?remove: \(id\) => removeRailItem\("sidebar", id\),\s*canRemove: railItemRemovable/);
});

test("Settings added to the Project rail is its only gear", async () => {
  const { default: Sidebar } = await import("../src/components/Sidebar.tsx");
  const store = await import("../src/store.ts");
  const { setSidebarViewMode } = await import("../src/sidebarPrefs.ts");
  const { setSidebarLayout } = await import("../src/sidebarLayout.ts");
  for (const id of placement.RAIL_ZONE_SLOTS.sidebar.flatMap((slot) => getWidgetLayout().slotPlacements[slot] ?? [])) {
    placement.removeRailItem("sidebar", placement.railItemIdOfInstance(getWidgetLayout(), id));
  }
  // The header's gear moves onto the rail (one home), next to Add project.
  placement.commitRailZoneOrder("sidebar", ["widget:shell.settings", "widget:shell.add-project"]);
  assert.deepEqual(railOrder(), ["widget:shell.settings", "widget:shell.add-project"]);
  assert.equal((getWidgetLayout().slotPlacements["app.header.actions"] ?? []).includes("shell.settings"), false);
  setSidebarViewMode("rail");
  setSidebarLayout({ collapsed: false, width: 332 });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(Sidebar));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  try {
    const rail = container.querySelector<HTMLElement>(".sidebar-project-rail")!;
    assert.ok(rail, "the rail presentation is mounted");
    assert.equal(rail.querySelectorAll('[aria-label="Settings"]').length, 1, "one gear, not the placed one plus a fixed copy");
    assert.equal(rail.querySelectorAll('[aria-label="Add project"]').length, 1);
    const items = [...rail.querySelectorAll<HTMLElement>(".sidebar-project-rail-tools > [data-rail-item]")].map((item) => item.dataset.railItem);
    assert.deepEqual(items, ["widget:shell.settings", "widget:shell.add-project"], "both are ordinary, ordered rail items");

    store.setSidebarOpen(true);
    await act(async () => { rail.querySelector<HTMLElement>('[aria-label="Settings"]')!.click(); });
    assert.equal(store.getState().overlay, "settings");
    assert.equal(store.getState().sidebarOpen, false, "opening Settings closes the compact drawer");
  } finally {
    store.setOverlay(null);
    await act(async () => root.unmount());
    container.remove();
  }
});

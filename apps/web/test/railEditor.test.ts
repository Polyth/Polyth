// One home per rail icon + the shared rail/zone editor.
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

register("./tsxHooks.mjs", import.meta.url);
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerCapability, currentResolvedCapabilities } = await import("../src/capabilities.ts");
type ResolvedCapability = import("../src/capabilities.ts").ResolvedCapability;
const { getCapabilityPlacements } = await import("../src/capabilityLayout.ts");
const { registerSurface } = await import("../src/surfaces.ts");
const { installCapabilityWidgets } = await import("../src/widgets/capabilityWidgets.tsx");
const { getWidgetLayout } = await import("../src/widgets/widgetLayout.ts");
const { activateProject, applyProjectUpsert } = await import("../src/store.ts");
const placement = await import("../src/railPlacement.ts");
const model = await import("../src/railEditorModel.ts");
const { default: RailEditor } = await import("../src/components/RailEditor.tsx");
const { default: CustomizeZoneButton } = await import("../src/components/CustomizeZoneButton.tsx");

const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const click = async (element: Element | null | undefined) => {
  assert.ok(element);
  await act(async () => { element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
};

function cap(id: string, tier: "primary" | "more" | "technical", rank: number): ResolvedCapability {
  return {
    descriptor: {
      id, label: id, plainDescription: "", keywords: [], standardTier: tier, standardRank: rank,
      open: () => {}, available: () => true,
    },
    tier,
    rank,
  };
}

// ---------------------------------------------------------------- pure rules

test("terminal has at most one rail home and can be hidden like any launcher", () => {
  const destinations = () => true;
  const scenarios: Array<{ terminal: "primary" | "more" | "technical"; explicit: boolean; expect: "top" | "right" | "none" }> = [
    { terminal: "more", explicit: false, expect: "top" }, // discoverable default
    { terminal: "more", explicit: true, expect: "right" },
    { terminal: "primary", explicit: true, expect: "top" },
    { terminal: "technical", explicit: true, expect: "none" }, // hidden: no fallback
  ];
  for (const scenario of scenarios) {
    const resolved = [cap("files", "primary", 0), cap("git", "more", 0), cap("terminal", scenario.terminal, 5)];
    const placements: Record<string, { tier: "primary" | "more" | "technical"; rank: number }> =
      scenario.explicit ? { terminal: { tier: scenario.terminal, rank: 5 } } : {};
    const top = placement.topRailCapabilities(resolved, placements).map((c) => c.descriptor.id);
    const topIds = new Set(top);
    const right = placement.rightRailCapabilities(resolved, topIds, destinations).map((c) => c.descriptor.id);
    assert.equal(top.includes("terminal"), scenario.expect === "top", JSON.stringify(scenario));
    assert.equal(right.includes("terminal"), scenario.expect === "right", JSON.stringify(scenario));
    assert.deepEqual(top.filter((id) => right.includes(id)), [], "no icon is drawn in both rails");
  }
});

test("a placed launcher widget is the capability's only home", () => {
  const resolved = [cap("files", "primary", 0), cap("git", "more", 0), cap("terminal", "more", 5)];
  const widgetHomes = new Map([["git", "app.header.actions" as const], ["files", "sidebar.toolbar" as const]]);
  const top = placement.topRailCapabilities(resolved, {}, widgetHomes).map((c) => c.descriptor.id);
  const right = placement.rightRailCapabilities(resolved, new Set(top), () => true, widgetHomes).map((c) => c.descriptor.id);
  assert.deepEqual(top, ["terminal"]);
  assert.deepEqual(right, []);
});

test("editor entries are unique and a package's own launcher widget folds into its tool", () => {
  const noop = () => {};
  const entries: import("../src/railEditorModel.ts").RailEditorEntry[] = [
    { key: "tool:git", kind: "tool", label: "Git", ownerPackageId: "git", icon: null, shown: false, add: noop, remove: noop },
    { key: "tool:git", kind: "tool", label: "Git", ownerPackageId: "git", icon: null, shown: false, add: noop, remove: noop },
    { key: "widget:git.launcher", kind: "widget", label: "git", ownerPackageId: "git", icon: null, shown: true, add: noop, remove: noop },
    { key: "widget:clock", kind: "widget", label: "Clock", ownerPackageId: "core", icon: null, shown: false, add: noop, remove: noop },
    { key: "tool:browser", kind: "tool", label: "Browser", icon: null, shown: false, elsewhere: "app.header.center", add: noop, remove: noop },
    { key: "tool:usage", kind: "tool", label: "Usage", icon: null, shown: false, add: noop, remove: noop },
  ];
  const unique = model.dedupeRailEntries(entries);
  assert.deepEqual(unique.map((entry) => entry.key), ["tool:git", "widget:clock", "tool:browser", "tool:usage"]);
  assert.equal(unique[0]?.shown, true, "the folded widget's visibility shows the tool");

  const sections = model.railEditorSections(entries);
  assert.deepEqual(sections.shown.map((entry) => entry.key), ["tool:git"]);
  assert.deepEqual(sections.tools.map((entry) => entry.key), ["tool:usage", "tool:browser"],
    "items that are nowhere yet come before items that would move");
  assert.deepEqual(sections.widgets.map((entry) => entry.key), ["widget:clock"]);
  assert.deepEqual(model.railEditorSections(entries, "clo").widgets.map((entry) => entry.key), ["widget:clock"]);
  assert.deepEqual(model.splitRailOrder(["widget:clock", "tool:git"], entries), { tools: ["git"], widgets: ["clock"] });
});

// ---------------------------------------------------------------- mutations

const TEST_PROJECT = "rail-editor-project";
let installed = false;
function setup(): void {
  if (installed) return;
  installed = true;
  applyProjectUpsert({ id: TEST_PROJECT, path: "/work/rail", name: "Rail project", createdAt: 1 });
  activateProject(TEST_PROJECT);
  for (const [id, tier, rank] of [["re-files", "primary", 50], ["re-git", "more", 50], ["re-usage", "more", 51]] as const) {
    registerCapability({
      id, label: id.replace("re-", "Re "), plainDescription: `${id} description`, keywords: [],
      standardTier: tier, standardRank: rank, open: () => {}, available: () => true,
    });
    registerSurface({ id, capabilityId: id, title: id, order: 90, component: () => null });
  }
  installCapabilityWidgets();
}

const homeOf = (id: string) => placement.capabilityHomes(
  currentResolvedCapabilities(), getCapabilityPlacements(), getWidgetLayout(), placement.railDestinationIds(),
).get(id);

test("adding an icon that lives in another rail or zone moves it", () => {
  setup();
  assert.equal(homeOf("re-files"), "app.header.center");
  assert.equal(homeOf("re-git"), "workspace.rail");

  placement.placeCapability("re-git", { slot: "app.header.actions" });
  assert.equal(homeOf("re-git"), "app.header.actions");
  assert.equal(getCapabilityPlacements()["re-git"]?.tier, "technical", "it left the right rail");

  placement.placeCapability("re-git", { tier: "primary" });
  assert.equal(homeOf("re-git"), "app.header.center");
  assert.equal(getWidgetLayout().widgets["capability:re-git"]?.visible, false, "its header widget was hidden");

  placement.placeCapability("re-git", { tier: "more" });
  assert.equal(homeOf("re-git"), "workspace.rail");

  placement.removeCapability("re-usage", "workspace.rail");
  assert.equal(homeOf("re-usage"), undefined);
  // Nothing is pinned: Terminal leaves the rails like any other launcher.
  placement.removeCapability("terminal", "workspace.rail");
  assert.equal(homeOf("terminal"), undefined);
});

// ---------------------------------------------------------------- the editor

async function mount(node: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("the editor lists shown items in order and offers compact tiles that move", async () => {
  const calls: string[] = [];
  const entry = (key: string, label: string, extra: Partial<import("../src/railEditorModel.ts").RailEditorEntry> = {}) => ({
    key, kind: key.startsWith("tool:") ? "tool" as const : "widget" as const, label, icon: null, shown: false,
    add: () => calls.push(`add:${key}`), remove: () => calls.push(`remove:${key}`), ...extra,
  });
  const view = await mount(createElement(RailEditor, {
    slot: "workspace.rail",
    title: "Right rail",
    entries: [
      entry("tool:git", "Git", { shown: true }),
      entry("tool:terminal", "Terminal", { shown: true, locked: true }),
      entry("tool:files", "Files", { elsewhere: "app.header.center" }),
      entry("widget:clock", "Clock"),
    ],
    reorder: (keys: string[]) => calls.push(`reorder:${keys.join(",")}`),
  }));
  try {
    const root = view.container;
    assert.equal(text(root.querySelector(".rail-editor-heading h2")), "Right rail");
    assert.equal(text(root.querySelector(".rail-editor-count")), "2 shown");
    assert.equal(root.querySelector(".rail-editor-search"), null, "a short list needs no search field");
    const rows = [...root.querySelectorAll(".rail-editor-shown .rail-editor-row")];
    assert.deepEqual(rows.map((row) => text(row.querySelector(".rail-editor-row-label"))), ["Git", "Terminal"]);
    assert.ok(rows[0]?.querySelector(".rail-editor-grip[aria-label='Reorder Git']"), "rows are reorderable");
    assert.equal(rows[1]?.querySelector(".rail-editor-remove"), null, "a locked launcher cannot be removed");

    const tiles = [...root.querySelectorAll(".rail-editor-tile")];
    assert.deepEqual(tiles.map((tile) => tile.getAttribute("aria-label")), ["Move Files here from Top rail", "Add Clock"]);
    assert.equal(text(tiles[0]?.querySelector(".rail-editor-tile-where")), "Top rail");

    await click(tiles[0]);
    await click(rows[0]?.querySelector(".rail-editor-remove"));
    rows[0]?.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }) as unknown as Event);
    assert.deepEqual(calls, ["add:tool:files", "remove:tool:git", "reorder:tool:terminal,tool:git"]);
  } finally {
    await view.unmount();
  }
});

test("long libraries get search; the zone pencil opens the same editor and moves on add", async () => {
  setup();
  const many = Array.from({ length: 12 }, (_, i) => ({
    key: `widget:w${i}`, kind: "widget" as const, label: `Widget ${i}`, icon: null, shown: false,
    add: () => {}, remove: () => {},
  }));
  const searchable = await mount(createElement(RailEditor, { slot: "app.header.actions", title: "Header", entries: many }));
  try {
    assert.ok(searchable.container.querySelector(".rail-editor-search input"));
  } finally {
    await searchable.unmount();
  }

  placement.placeCapability("re-files", { tier: "primary" });
  const view = await mount(createElement(CustomizeZoneButton, { slot: "workspace.rail", tier: "more" }));
  try {
    const trigger = view.container.querySelector(".zone-customize-trigger");
    assert.equal(trigger?.getAttribute("aria-label"), "Customize Right rail");
    await click(trigger);
    const editor = document.body.querySelector(".rail-editor");
    assert.ok(editor, "the editor opened");
    const filesTile = [...editor.querySelectorAll(".rail-editor-tile")]
      .find((tile) => tile.getAttribute("aria-label") === "Move Re files here from Top rail");
    assert.ok(filesTile, "an icon in the top rail is offered as a move, not a copy");
    await click(filesTile);
    assert.equal(homeOf("re-files"), "workspace.rail");
    const shown = [...document.body.querySelectorAll(".rail-editor-shown .rail-editor-row-label")].map(text);
    assert.equal(shown.filter((label) => label === "Re files").length, 1);
    assert.equal(
      [...document.body.querySelectorAll(".rail-editor-tile")].some((tile) => /Re files/.test(tile.getAttribute("aria-label") ?? "")),
      false,
      "a shown item is never offered again",
    );
  } finally {
    await view.unmount();
  }
});

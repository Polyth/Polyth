import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", {
  value: (dom as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement,
  configurable: true,
});

const store = await import("../src/store.ts");
const { registerSurface } = await import("../src/surfaces.ts");
const { emptyLayout, placementOf } = await import("../src/workbench/layout.ts");
const { getWorkbenchLayout, resetWorkbenchForTest, setWorkbenchProject } = await import("../src/workbench/store.ts");
const { registerWorkbenchProfile } = await import("../src/workbench/profiles.ts");
const { switchWorkbenchNavigation } = await import("../src/workbench/profileNavigation.ts");
const { resetWorkbenchPrefsCache } = await import("../src/workbench/prefs.ts");

registerSurface({
  id: "files",
  title: "Files",
  order: 1,
  component: () => null,
  presentation: {
    kind: "workspace", defaultRatio: 0.42, minWidth: 360, preferredMaxWidth: 920,
    keepAlive: true, escape: "close",
  },
});

registerSurface({
  id: "playground",
  title: "Playground",
  order: 2,
  component: () => null,
  presentation: {
    kind: "workspace", defaultRatio: 0.56, minWidth: 360, minHeight: 280, preferredMaxWidth: 1200,
    keepAlive: true, escape: "close",
  },
});

registerWorkbenchProfile({
  id: "playground",
  label: "Playground",
  description: "",
  order: 1,
  defaultLayout: {
    surfaces: [
      { surface: "session", region: "primary", active: true },
      { surface: "playground", region: "end", active: true },
    ],
  },
  presentation: {
    navigation: "primary",
    focused: true,
    sidebar: "projects",
    splitSurfaces: ["session", "playground"],
  },
});

function assertAligned() {
  const { paneMode, railPlugin } = store.getState();
  const layout = getWorkbenchLayout();
  if (railPlugin === null) {
    assert.equal(paneMode, "dynamic");
    return;
  }
  const placement = placementOf(layout, railPlugin);
  assert.ok(placement, `surface ${railPlugin} is placed`);
  if (paneMode === "pinned") assert.equal(placement.presentation, "docked");
  else if (paneMode === "dynamic") assert.equal(placement.presentation, "floating");
  else if (paneMode === "fullscreen") assert.equal(placement.presentation, "fullscreen");
}

test("legacy paneMode and workbench layout stay aligned through pane commands", () => {
  resetWorkbenchPrefsCache();
  resetWorkbenchForTest();
  store.activateProject("p1");
  setWorkbenchProject("p1");

  assert.equal(store.openWorkspacePane("files"), true);
  assertAligned();

  store.togglePanePin();
  assert.equal(store.getState().paneMode, "pinned");
  assertAligned();

  store.togglePaneFullscreen();
  assert.equal(store.getState().paneMode, "fullscreen");
  assertAligned();

  store.handlePaneEscape();
  assert.equal(store.getState().paneMode, "pinned");
  assertAligned();

  store.togglePanePin();
  assert.equal(store.getState().paneMode, "dynamic");
  assertAligned();

  store.closePaneFromOutside();
  assert.equal(store.getState().railPlugin, null);
  assertAligned();

  store.openWorkspacePane("files");
  store.togglePanePin();
  store.closeWorkspacePane();
  assert.equal(store.getState().railPlugin, null);
  assert.equal(store.getState().paneMode, "dynamic");
  assertAligned();
});

test("focused profile restores a missing split surface before opening its view", () => {
  const stale = emptyLayout();
  stale.regions.primary = { surfaces: ["session"], active: "session" };
  stale.floating = ["playground"];
  localStorage.setItem("polyth.workbenchLayout.v1.p2", JSON.stringify({
    version: 1,
    activeProfile: "playground",
    profiles: { playground: { layout: stale, customized: true, sessionId: null } },
    lastResource: {},
  }));
  resetWorkbenchPrefsCache();
  resetWorkbenchForTest();
  store.activateProject("p2");
  setWorkbenchProject("p2");

  assert.equal(switchWorkbenchNavigation({ profileId: "playground" }), true);
  assert.equal(store.getState().railPlugin, "playground");
  assert.equal(store.getState().paneMode, "pinned");
  assert.equal(placementOf(getWorkbenchLayout(), "playground")?.presentation, "docked");

  localStorage.removeItem("polyth.workbenchLayout.v1.p2");
  resetWorkbenchPrefsCache();
  resetWorkbenchForTest();
});

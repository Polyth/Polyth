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
const { placementOf } = await import("../src/workbench/layout.ts");
const { getWorkbenchLayout, resetWorkbenchForTest, setWorkbenchProject } = await import("../src/workbench/store.ts");
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

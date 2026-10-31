// Gates of the phone shell swipes (shellSwipe.ts): the user's setting, when
// Chat counts as the top layer, and what counts as something open above it.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost:3000/" });
const doc = dom.document as unknown as Document;

const { chatSwipeAllowed, getSwipePeek, setSwipePeek, swipeZoneFor, swipeZoneInHost, transientSurfaceOpen } = await import("../src/shellSwipe.ts");
const { parseUiSettings, UI_DEFAULTS } = await import("../src/uiPrefs.ts");

test("the Swipe navigation setting maps to a start zone, defaults to anywhere and survives bad records", () => {
  assert.equal(swipeZoneFor("surface"), "surface");
  assert.equal(swipeZoneFor("edge"), "edge");
  assert.equal(swipeZoneFor("off"), null);
  assert.equal(UI_DEFAULTS.swipeNavigation, "surface");
  assert.equal(parseUiSettings("{}").swipeNavigation, "surface", "a profile saved before the setting gets swipes");
  assert.equal(parseUiSettings(JSON.stringify({ swipeNavigation: "edge" })).swipeNavigation, "edge");
  assert.equal(parseUiSettings(JSON.stringify({ swipeNavigation: "sideways" })).swipeNavigation, "surface");
});

test("swipeZoneInHost stands down where the host owns the edge gesture", () => {
  // Node/happy-dom has no coarse pointer and no native platform: the mapping
  // is the setting alone (the browser/app split is pinned in swipeHost.test.ts).
  assert.deepEqual(
    ["surface", "edge", "off"].map((mode) => swipeZoneInHost(mode as "surface" | "edge" | "off")),
    ["surface", "edge", null],
  );
});

test("Chat swipes start only while Chat is the top layer on a phone", () => {
  const base = {
    phone: true, sidebarOpen: false, workspaceOpen: false, packagePresented: false, overlay: false, transientOpen: false,
  };
  assert.equal(chatSwipeAllowed(base), true);
  for (const key of ["sidebarOpen", "workspaceOpen", "packagePresented", "overlay", "transientOpen"] as const) {
    assert.equal(chatSwipeAllowed({ ...base, [key]: true }), false, key);
  }
  assert.equal(chatSwipeAllowed({ ...base, phone: false }), false, "compact and wide shells have their own navigation");
});

test("a modal, a sheet, or a shown menu/dialog counts as open; hidden keep-alive ones do not", () => {
  doc.body.innerHTML = "";
  assert.equal(transientSurfaceOpen(doc), false);
  doc.documentElement.dataset.modalSurface = "open";
  assert.equal(transientSurfaceOpen(doc), true);
  delete doc.documentElement.dataset.modalSurface;
  doc.documentElement.dataset.sheet = "open";
  assert.equal(transientSurfaceOpen(doc), true);
  delete doc.documentElement.dataset.sheet;
  doc.body.innerHTML = '<div inert><div role="dialog">kept</div></div><div hidden><div role="menu"></div></div>';
  assert.equal(transientSurfaceOpen(doc), false, "inert or hidden surfaces are not open");
});

test("one peek at a time", () => {
  setSwipePeek("navigator");
  assert.equal(getSwipePeek(), "navigator");
  setSwipePeek("workspace");
  assert.equal(getSwipePeek(), "workspace");
  setSwipePeek(null);
  assert.equal(getSwipePeek(), null);
});

// A value stored before the row was hidden must not outlive it: on this
// computer's own server the toggle is not rendered, so a leftover "off" would
// freeze that window with no control left to turn syncing back on. The flag
// counts as ON there (and its stored value is left untouched, not deleted).
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });

// Before the sync module evaluates: an older build saved "off" in the desktop
// shell that runs this computer's own server.
dom.localStorage.setItem("polyth.appearanceSync.v1", "0");
(dom as unknown as { polythDesktop?: { surface: string } }).polythDesktop = { surface: "local" };

const sync = await import("../src/settingsSync.ts");
const { onServerHostSurface } = await import("../src/desktopBridge.ts");

test("a stale \"off\" cannot freeze this computer's own server", () => {
  assert.equal(onServerHostSurface(), true, "the shell runs this computer's server");
  assert.equal(dom.localStorage.getItem("polyth.appearanceSync.v1"), "0", "the stored choice is left as it was");
  assert.equal(sync.isAppearanceSyncEnabled(), true, "the flag counts as ON where there is no switch");
});

import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://localhost/" });
Object.defineProperty(globalThis, "window", { value: dom, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.document, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: dom.localStorage, configurable: true });
Object.defineProperty(globalThis, "location", { value: dom.location, configurable: true });

const visibility = await import("../widgets/browserVisibility.ts");

test("browser visibility defaults to background and persists the selected mode", () => {
  localStorage.clear();
  visibility.setBrowserVisibility("background");
  assert.equal(visibility.getBrowserVisibility(), "background");
  visibility.setBrowserVisibility("auto-show");
  assert.equal(localStorage.getItem("polyth.browser.visibility.v1"), "auto-show");
  assert.equal(visibility.getBrowserVisibility(), "auto-show");
  visibility.setBrowserVisibility("background");
});

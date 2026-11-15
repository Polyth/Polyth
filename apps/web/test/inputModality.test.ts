// The phone header hides script-restored focus rings after a tap and keeps
// them for keyboard navigation; inputModality.ts publishes which one it was.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { installInputModality, keyMeansKeyboardModality } from "../src/inputModality.ts";

test("bare modifiers and shortcut chords do not count as keyboard navigation", () => {
  const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey", boolean>> = {}) =>
    keyMeansKeyboardModality({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  assert.equal(key("Tab"), true);
  assert.equal(key("ArrowDown"), true);
  assert.equal(key("Enter"), true);
  assert.equal(key("Shift"), false);
  assert.equal(key("Meta"), false);
  assert.equal(key("k", { metaKey: true }), false);
  assert.equal(key("c", { ctrlKey: true }), false);
});

test("a tap marks pointer modality and a navigation key switches back", () => {
  const dom = new Window({ url: "http://localhost/" });
  const root = dom.document.documentElement as unknown as HTMLElement;
  const uninstall = installInputModality(root, dom as unknown as globalThis.Window);
  try {
    assert.equal(root.dataset.inputModality, undefined);
    dom.dispatchEvent(new dom.PointerEvent("pointerdown"));
    assert.equal(root.dataset.inputModality, "pointer");
    dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Shift" }));
    assert.equal(root.dataset.inputModality, "pointer");
    dom.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Tab" }));
    assert.equal(root.dataset.inputModality, "keyboard");
  } finally {
    uninstall();
  }
  assert.equal(root.dataset.inputModality, undefined);
});

test("phone header controls show focus as the glyph colour, never a clipped outline", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const keyboard = css.match(/:is\(\.mobile-float-navigation, \.mobile-float-actions\) > \.ui-icon-btn:focus-visible \{([^}]*)\}/);
  assert.ok(keyboard, "keyboard focus rule exists");
  assert.match(keyboard[1], /outline: none/);
  assert.match(keyboard[1], /color: var\(--accent-text\)/);
  assert.match(css, /html\[data-input-modality="pointer"\] :is\(\.mobile-float-navigation, \.mobile-float-actions\) > \.ui-icon-btn:focus-visible:not\(:active, \[aria-expanded="true"\]\) \{\s*color: var\(--text-dim\)/);
  const looks = readFileSync(new URL("../src/shellLooks.css", import.meta.url), "utf8");
  for (const line of looks.split("\n").filter((l) => /mobile-float-actions\) \.ui-icon-btn:not\(:active/.test(l))) {
    assert.match(line, /:focus-visible\)/, `a look's resting glyph colour must not hide keyboard focus: ${line}`);
  }
});

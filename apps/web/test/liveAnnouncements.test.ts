// The polite live region must never keep a status after it resolves: a stale
// "Checking microphone…" (or an autocomplete status) tells a screen-reader user
// a hardware/state claim that is no longer true. Producers forward the resolved
// value (null clears); the shared region owns the clearing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as typeof globalThis & Window,
  document: dom.document as unknown as Document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

register("./tsxHooks.mjs", import.meta.url);

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("a resolved status clears the polite live region instead of stranding text", async () => {
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { LiveRegion, announce } = await import("../src/components/a11y/live.tsx");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(createElement(LiveRegion)); });
    await act(async () => { announce("Checking microphone…"); });
    assert.equal(container.textContent, "Checking microphone…");

    await act(async () => { announce(null); });
    assert.equal(container.textContent, "", "a resolved (null) status must clear the region");

    await act(async () => { announce(""); });
    assert.equal(container.textContent, "", "an empty status also clears the region");

    await act(async () => { announce("Checking microphone…"); });
    assert.equal(container.textContent, "Checking microphone…", "the status can be announced again after clearing");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

test("status producers forward a resolved status instead of skipping the update", async () => {
  const [voice, composer] = await Promise.all([
    read("../../../packages/dictation/widgets/voice.tsx"),
    read("../src/components/Composer.tsx"),
  ]);
  assert.match(voice, /if \(lifecycleStatus !== lastAnnounced\.current\) announce\(lifecycleStatus\)/);
  assert.match(composer, /if \(statusText !== lastAnnounced\.current\) announce\(statusText\)/);
  assert.doesNotMatch(voice, /if \(lifecycleStatus && lifecycleStatus !== lastAnnounced\.current\)/);
  assert.doesNotMatch(composer, /if \(statusText && statusText !== lastAnnounced\.current\)/);
});

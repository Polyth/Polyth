// People notification kinds: labels, transient glyph/duration, settings
// defaults. Strings/booleans only — never pass a DOM node to assert.equal.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";

const dom = new Window({ url: "http://127.0.0.1:4400/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
});
Object.defineProperty(globalThis, "navigator", { value: dom.navigator, configurable: true });
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
register("./tsxHooks.mjs", import.meta.url);

const { NOTIFICATION_KIND_LABELS } = await import("../src/notificationCentre.ts");
const { DEFAULT_DURATION } = await import("../src/notify/store.ts");
const { NOTIFICATION_KIND_ICON } = await import("../src/notify/NotificationGlyph.tsx");
const { CENTRE_NOTICE_KIND } = await import("../src/components/NotificationCentre.tsx");
const { UI_DEFAULTS, parseUiSettings } = await import("../src/uiPrefs.ts");

test("mention and message have centre labels, glyphs, durations and centre mapping", () => {
  for (const kind of ["mention", "message"] as const) {
    assert.ok(NOTIFICATION_KIND_LABELS[kind]?.trim(), `label ${kind}`);
    assert.ok(NOTIFICATION_KIND_ICON[kind], `icon ${kind}`);
    assert.notEqual(DEFAULT_DURATION[kind], undefined);
    assert.equal(CENTRE_NOTICE_KIND[kind], kind);
  }
  // Every centre kind still has a transient kind to render.
  for (const mapped of Object.values(CENTRE_NOTICE_KIND)) assert.ok(mapped);
});

test("mentions and conversation messages are routed to local alerts by default", () => {
  assert.ok(UI_DEFAULTS.notifyKinds.includes("mention"));
  assert.ok(UI_DEFAULTS.notifyKinds.includes("message"));
});

test("a kinds list saved before a people kind existed gains it once; a current one is honoured", () => {
  // An older shell (or one that drops unknown fields) saved kinds without a version.
  const legacy = parseUiSettings(JSON.stringify({ notifyKinds: ["completed", "question"] }));
  assert.deepEqual(legacy.notifyKinds, ["completed", "question", "mention", "message"]);
  // Chosen when mentions existed but messages did not: only `message` is added,
  // so a mention opt-out from then sticks.
  const v2 = parseUiSettings(JSON.stringify({ notifyKinds: ["completed"], notifyKindsVersion: 2 }));
  assert.deepEqual(v2.notifyKinds, ["completed", "message"]);
  // Once saved by this shell the version is current and an opt-out sticks.
  const current = parseUiSettings(JSON.stringify({ notifyKinds: ["completed"], notifyKindsVersion: legacy.notifyKindsVersion }));
  assert.deepEqual(current.notifyKinds, ["completed"]);
});

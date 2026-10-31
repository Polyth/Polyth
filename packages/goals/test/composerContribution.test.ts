// The goals package owns its composer contribution: one Add-menu item that
// opens the package-owned goal attach form through the generic dialog seam.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ComposerAddMenuItem, ComposerContributionContext, WebPackageHost } from "@polyth/web-sdk";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
});
register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const menu: ComposerAddMenuItem[] = [];

const context = (over: Partial<ComposerContributionContext> = {}): ComposerContributionContext => ({
  projectId: "project-1",
  sessionId: "session-1",
  draftText: "",
  openDialog: () => () => {},
  close: () => {},
  insertText: () => {},
  error: () => {},
  ...over,
});

const host = {
  surfaces: { register: () => () => {} },
  capabilities: { register: () => () => {} },
  widgets: { registerPlugin: () => () => {} },
  composer: {
    registerAddMenuItem: (item: ComposerAddMenuItem) => { menu.push(item); return () => { menu.splice(menu.indexOf(item), 1); }; },
    registerPasteHandler: () => () => {},
    listAddMenuItems: () => menu,
    listPasteHandlers: () => [],
    subscribe: () => () => {},
  },
  ui: { icons: {}, locale: { get: () => "en", translate: (key: string) => key }, components: {} },
} as unknown as WebPackageHost;

const entry = (await import("../widgets/index.tsx")).default;
const dispose = entry(host)();

test("goals registers one composer Add-menu item that opens its attach form", () => {
  assert.equal(menu.length, 1);
  const item = menu[0]!;
  assert.equal(item.id, "goals.attach");
  assert.equal(item.order, 20);
  assert.equal(typeof item.label === "function" ? item.label() : item.label, "goalsattach.menuLabel");
  assert.equal(item.isAvailable?.(context({ sessionId: null })), false);
  assert.equal(item.isAvailable?.(context()), true);
  let opened = 0;
  item.activate(context({ openDialog: () => { opened += 1; return () => {}; } }));
  assert.equal(opened, 1);
});

test("disposing the package removes the composer contribution", () => {
  dispose();
  assert.deepEqual(menu, []);
});

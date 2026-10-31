// The github package owns its composer contribution: one Add-menu item that
// opens the link dialog, and one paste handler for a lone GitHub PR/issue URL.
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import type { ComposerAddMenuItem, ComposerContributionContext, ComposerPasteHandler, WebPackageHost } from "@polyth/web-sdk";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom as unknown as Window & typeof globalThis,
  document: dom.document as unknown as Document,
});
register("../../../apps/web/test/tsxHooks.mjs", import.meta.url);

const menu: ComposerAddMenuItem[] = [];
const paste: ComposerPasteHandler[] = [];
const registrations: string[] = [];

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
  surfaces: { register: (definition: { id: string }) => { registrations.push(`surface:${definition.id}`); return () => {}; } },
  capabilities: { register: (definition: { id: string }) => { registrations.push(`capability:${definition.id}`); return () => {}; } },
  widgets: { registerPlugin: (plugin: { id: string }) => { registrations.push(`plugin:${plugin.id}`); return () => {}; } },
  slots: { register: (registration: { id: string }) => { registrations.push(`slot:${registration.id}`); return () => {}; } },
  composer: {
    registerAddMenuItem: (item: ComposerAddMenuItem) => { menu.push(item); return () => { menu.splice(menu.indexOf(item), 1); }; },
    registerPasteHandler: (handler: ComposerPasteHandler) => { paste.push(handler); return () => { paste.splice(paste.indexOf(handler), 1); }; },
    listAddMenuItems: () => menu,
    listPasteHandlers: () => paste,
    subscribe: () => () => {},
  },
  ui: { icons: {}, locale: { get: () => "en", translate: (key: string) => key }, components: {} },
  navigation: {},
  errors: { friendly: (action: string) => action },
} as unknown as WebPackageHost;

const entry = (await import("../widgets/index.tsx")).default;
const dispose = entry(host)();

test("github registers one composer Add-menu item and one paste handler", () => {
  assert.equal(menu.length, 1);
  assert.equal(paste.length, 1);
  assert.equal(menu[0]!.id, "github.link");
  assert.equal(menu[0]!.order, 10);
  assert.equal(paste[0]!.id, "github.url");
});

test("the Add-menu item is unavailable without a project and opens the dialog with one", () => {
  const item = menu[0]!;
  assert.equal(item.isAvailable?.(context({ projectId: null })), false);
  assert.equal(item.isAvailable?.(context()), true);
  let opened = 0;
  item.activate(context({ openDialog: () => { opened += 1; return () => {}; } }));
  assert.equal(opened, 1);
});

test("the paste handler matches only lone GitHub PR/issue URLs and defers without a project", async () => {
  const handler = paste[0]!;
  assert.equal(handler.match("https://github.com/o/r/pull/1"), true);
  assert.equal(handler.match("see https://github.com/o/r/pull/1"), false);
  assert.equal(handler.match("https://gitlab.com/o/r/pull/1"), false);
  assert.equal(await handler.handle(context({ projectId: null }), "https://github.com/o/r/pull/1"), false);
});

test("disposing the package removes both composer contributions", () => {
  dispose();
  assert.deepEqual(menu, []);
  assert.deepEqual(paste, []);
  assert.ok(registrations.includes("surface:github"));
  assert.ok(registrations.includes("capability:github"));
});

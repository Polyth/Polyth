// WP9: item-level settings search — diacritics, duplicate ids, disposed
// plugin items, hidden pages, no matches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  fold, listSettingsItems, registerSettingsItems, searchSettingsItems,
} from "../src/settings/registry.ts";

const PAGES: Record<string, string> = {
  general: "General", appearance: "Appearance", chat: "Chat", notifications: "Notifications",
  behavior: "Behavior", mcp: "MCP", plugins: "Plugins", about: "About", voice: "Voice",
  models: "Providers & Models", agents: "Agents", widgets: "Widgets & Layout",
};

test("fold strips diacritics and case", () => {
  assert.equal(fold("Résumé"), "resume");
  assert.equal(fold("ÜBER"), "uber");
});

test("search matches label, description, and keywords; groups carry page labels", () => {
  const byLabel = searchSettingsItems("editor font", PAGES);
  assert.ok(byLabel.some((h) => h.item.id === "appearance.editorFontSize"));
  assert.equal(byLabel.find((h) => h.item.id === "appearance.editorFontSize")!.pageLabel, "Appearance");

  const byKeyword = searchSettingsItems("a11y", PAGES);
  assert.ok(byKeyword.some((h) => h.item.id === "appearance.reducedMotion"));

  const byDescription = searchSettingsItems("agents.md", PAGES);
  assert.ok(byDescription.some((h) => h.item.id === "behavior.instructions"));
});

test("diacritic query matches plain text", () => {
  const hits = searchSettingsItems("dénsity", PAGES);
  assert.ok(hits.some((h) => h.item.id === "appearance.density"));
});

test("no matches yields an empty list, blank query too", () => {
  assert.deepEqual(searchSettingsItems("zzzz-nothing", PAGES), []);
  assert.deepEqual(searchSettingsItems("   ", PAGES), []);
});

test("Widgets & Layout is wired and its toolbar, rail, and mini-widget controls are searchable", async () => {
  const widgetItems = listSettingsItems().filter((item) => item.pageId === "widgets");
  assert.ok(widgetItems.some((item) => item.id === "widgets.capabilities"));
  assert.ok(widgetItems.some((item) => item.id === "widgets.actions"));
  assert.ok(searchSettingsItems("toolbar", PAGES).some((hit) => hit.item.id === "widgets.capabilities"));

  const [shell, settings, widgets] = await Promise.all([
    readFile(new URL("../src/shell.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/components/SettingsView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/settings/WidgetsPage.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(shell, /Change workspace preset|cmd\.customize/);
  assert.doesNotMatch(settings, /Choose a setup/);
  assert.match(settings, /Widgets & Layout/);
  assert.match(widgets, /data-settings-item="widgets\.capabilities"/);
  assert.match(widgets, /data-settings-item="widgets\.actions"/);
});

test("items on hidden/unknown pages are skipped", () => {
  const un = registerSettingsItems([
    { id: "ghost.item", pageId: "slot:ghost", label: "Ghost setting", focusTarget: "ghost" },
  ]);
  try {
    // Page not present in the page map → item never surfaces as a dead link.
    assert.deepEqual(searchSettingsItems("ghost setting", PAGES), []);
    // Once its page exists, the same item is findable.
    const hits = searchSettingsItems("ghost setting", { ...PAGES, "slot:ghost": "Ghost" });
    assert.equal(hits.length, 1);
  } finally {
    un();
  }
});

test("duplicate ids overwrite; unregister removes plugin items", () => {
  const before = listSettingsItems().length;
  const un1 = registerSettingsItems([
    { id: "dup.x", pageId: "chat", label: "First", focusTarget: "x" },
  ]);
  const un2 = registerSettingsItems([
    { id: "dup.x", pageId: "chat", label: "Second", focusTarget: "x" },
  ]);
  assert.equal(listSettingsItems().length, before + 1, "same id registered once");
  assert.equal(searchSettingsItems("second", PAGES)[0]?.item.label, "Second");

  un2();
  un1();
  assert.equal(listSettingsItems().length, before, "disposed plugin items are gone");
  assert.deepEqual(searchSettingsItems("second", PAGES), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_KEYMAP,
  HOTKEY_ACTIONS,
  comboFromEvent,
  findConflicts,
  formatCombo,
  matchAction,
  normalizeCombo,
  parseKeymap,
  rebindKeymap,
  serializeKeymap,
} from "@polyth/hotkeys";

const ev = (key: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) => ({
  key,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
});

test("defaults match the current shell bindings", () => {
  assert.equal(DEFAULT_KEYMAP.palette, "mod+k");
  assert.equal(DEFAULT_KEYMAP.searchFiles, "mod+p");
  assert.equal(DEFAULT_KEYMAP.searchSessions, "mod+shift+f");
  assert.equal(DEFAULT_KEYMAP.settings, "mod+,");
  assert.equal(DEFAULT_KEYMAP.newSession, "mod+n");
  assert.equal(DEFAULT_KEYMAP.viewTerminal, "mod+`");
  assert.ok(HOTKEY_ACTIONS.every((action) => action.pluginName.length > 0));
});

test("normalizeCombo orders modifiers and rejects junk", () => {
  assert.equal(normalizeCombo("Shift+Mod+E"), "mod+shift+e");
  assert.equal(normalizeCombo("cmd+K"), "mod+k");
  assert.equal(normalizeCombo("ctrl+alt+p"), "mod+alt+p");
  assert.equal(normalizeCombo("shift"), null);
  assert.equal(normalizeCombo("a+b"), null);
});

test("comboFromEvent maps meta/ctrl to mod; modifier-only keys yield null", () => {
  assert.equal(comboFromEvent(ev("k", { meta: true })), "mod+k");
  assert.equal(comboFromEvent(ev("K", { ctrl: true, shift: true })), "mod+shift+k");
  assert.equal(comboFromEvent(ev("Shift", { shift: true })), null);
});

test("matchAction resolves events against custom maps", () => {
  const map = parseKeymap(JSON.stringify({ palette: "mod+shift+p", viewGit: "bogus", nonsense: "mod+z" }));
  assert.equal(map.palette, "mod+shift+p");
  assert.equal(map.viewGit, DEFAULT_KEYMAP.viewGit); // bad combo dropped
  assert.equal(matchAction(map, ev("p", { ctrl: true, shift: true })), "palette");
  assert.equal(matchAction(map, ev("p", { ctrl: true })), "searchFiles");
  assert.equal(matchAction(map, ev("x", { ctrl: true })), null);
});

test("serializeKeymap only stores overrides and round-trips", () => {
  const map = { ...DEFAULT_KEYMAP, palette: "mod+shift+p" };
  const raw = serializeKeymap(map);
  assert.deepEqual(JSON.parse(raw), { palette: "mod+shift+p" });
  assert.deepEqual(parseKeymap(raw), map);
});

test("findConflicts flags duplicate combos", () => {
  const map = { ...DEFAULT_KEYMAP, newSession: DEFAULT_KEYMAP.palette };
  const conflicts = findConflicts(map);
  assert.ok(conflicts.includes("palette"));
  assert.ok(conflicts.includes("newSession"));
  assert.deepEqual(findConflicts(DEFAULT_KEYMAP), []);
});

test("stored and newly assigned collisions remain visible for resolution", () => {
  const repaired = parseKeymap(JSON.stringify({ palette: DEFAULT_KEYMAP.searchFiles }));
  assert.deepEqual(findConflicts(repaired).sort(), ["palette", "searchFiles"]);
  assert.equal(repaired.palette, DEFAULT_KEYMAP.searchFiles);
  assert.equal(repaired.searchFiles, DEFAULT_KEYMAP.searchFiles);

  const rebound = rebindKeymap(DEFAULT_KEYMAP, "newSession", DEFAULT_KEYMAP.palette);
  assert.deepEqual(findConflicts(rebound).sort(), ["newSession", "palette"]);
  assert.equal(rebound.newSession, DEFAULT_KEYMAP.palette);
  assert.equal(rebound.palette, DEFAULT_KEYMAP.palette);
  assert.deepEqual(parseKeymap(serializeKeymap(rebound)), rebound);
});

test("formatCombo renders mac glyphs and win/linux text", () => {
  assert.equal(formatCombo("mod+shift+e", true), "⌘⇧E");
  assert.equal(formatCombo("mod+shift+e", false), "Ctrl+Shift+E");
  assert.equal(formatCombo("mod+,", false), "Ctrl+,");
  assert.equal(formatCombo("mod+`", false), "Ctrl+`");
});

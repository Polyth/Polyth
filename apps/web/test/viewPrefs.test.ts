// UX-A390 repair: the active workspace view survives reload. Browser-local
// parse/persist rules for polyth.activeView. DOM-free (localStorage shimmed).
import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const { ACTIVE_VIEW_KEY, loadActiveView, parseActiveView, saveActiveView } = await import("../src/viewPrefs.ts");

test("parseActiveView keeps known view ids and falls back to session", () => {
  for (const view of ["session", "files", "goals", "multirun", "fusion", "walkthrough", "preview", "git", "terminal", "schedule", "github"]) {
    assert.equal(parseActiveView(view), view);
  }
  assert.equal(parseActiveView(null), "session");
  assert.equal(parseActiveView(""), "session");
  assert.equal(parseActiveView("not-a-view"), "session");
  assert.equal(parseActiveView("SESSION"), "session"); // ids are exact
});

test("saveActiveView round-trips through storage", () => {
  saveActiveView("terminal");
  assert.equal(mem.get(ACTIVE_VIEW_KEY), "terminal");
  assert.equal(loadActiveView(), "terminal");
  saveActiveView("files");
  assert.equal(loadActiveView(), "files");
});

test("a stored garbage value restores the session view", () => {
  mem.set(ACTIVE_VIEW_KEY, "☃ nonsense");
  assert.equal(loadActiveView(), "session");
});

test("preset placement cannot make a valid stored view unreachable", () => {
  for (const view of ["terminal", "git", "schedule", "github"] as const) {
    saveActiveView(view);
    assert.equal(loadActiveView(), view);
  }
});

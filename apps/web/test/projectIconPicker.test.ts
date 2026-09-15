import assert from "node:assert/strict";
import test from "node:test";

import {
  filterProjectIcons,
  projectIconLabel,
  rankSuggestedProjectIcons,
  updateRecentProjectIcons,
} from "../src/projectIconPicker.ts";

test("projectIconLabel makes bundled file names searchable", () => {
  assert.equal(projectIconLabel("folder-search-02.svg"), "folder search 02");
  assert.equal(projectIconLabel("brain_circuit.svg"), "brain circuit");
});

test("filterProjectIcons matches every query token case-insensitively", () => {
  const icons = ["folder-search.svg", "folder-open.svg", "search-web.svg"];
  assert.deepEqual(filterProjectIcons(icons, "SEARCH folder"), ["folder-search.svg"]);
});

test("rankSuggestedProjectIcons uses the project title before generic fallbacks", () => {
  const icons = ["cat.svg", "database.svg", "folder.svg", "search.svg", "star.svg"];
  const ranked = rankSuggestedProjectIcons(icons, "case-seek");
  assert.ok(ranked.indexOf("search.svg") < ranked.indexOf("cat.svg"));
  assert.ok(ranked.indexOf("folder.svg") < ranked.indexOf("cat.svg"));
});

test("updateRecentProjectIcons deduplicates and caps history", () => {
  assert.deepEqual(updateRecentProjectIcons(["a.svg", "b.svg", "c.svg"], "b.svg", 3), [
    "b.svg",
    "a.svg",
    "c.svg",
  ]);
  assert.deepEqual(updateRecentProjectIcons(["a.svg", "b.svg"], "c.svg", 2), ["c.svg", "a.svg"]);
});

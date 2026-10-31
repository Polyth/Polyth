import test from "node:test";
import assert from "node:assert/strict";
import type { PackageDescriptorDto } from "@polyth/contracts";
import {
  filterPackages,
  highlightParts,
  isFiltered,
  packageEntry,
  packageFacets,
} from "../src/components/settings/packageManagement.ts";
import { packageToSettingsPageId } from "../src/packages/onboarding/pageMap.ts";

const descriptor = (id: string, overrides: Partial<PackageDescriptorDto> = {}): PackageDescriptorDto => ({
  id, name: id, description: "", core: false, enabled: true, hasSettings: false, ...overrides,
});

const entries = [
  descriptor("zeta", { name: "Zeta", description: "Charts", category: "finance" }),
  descriptor("alpha", { name: "alpha", description: "Source control", category: "engineering", enabled: false }),
  descriptor("beta", { name: "Beta", description: "Shell", category: "engineering" }),
  descriptor("core", { name: "Core", description: "Always", core: true }),
].map((item) => packageEntry(item, { name: item.name, description: item.description, category: item.category ?? "other" }));
const ids = (list: ReturnType<typeof filterPackages>) => list.map((entry) => entry.descriptor.id);

test("filters combine query words, status and category and sort by display name", () => {
  assert.deepEqual(ids(filterPackages(entries, { query: "", status: "all", category: null })), ["alpha", "beta", "core", "zeta"]);
  assert.deepEqual(ids(filterPackages(entries, { query: "  SOURCE  engineering ", status: "all", category: null })), ["alpha"]);
  assert.deepEqual(ids(filterPackages(entries, { query: "", status: "enabled", category: "engineering" })), ["beta"]);
  // Core packages are never "disabled", even if a descriptor said so.
  const offCore = packageEntry(descriptor("x", { core: true, enabled: false }), { name: "X", description: "", category: "" });
  assert.deepEqual(ids(filterPackages([offCore], { query: "", status: "disabled", category: null })), []);
  assert.equal(isFiltered({ query: " ", status: "all", category: null }), false);
  assert.equal(isFiltered({ query: "", status: "disabled", category: null }), true);
  // "On" lists core packages; they are always on.
  assert.deepEqual(ids(filterPackages(entries, { query: "", status: "enabled", category: null })), ["beta", "core", "zeta"]);
});

test("facets count what each choice would show and list only present categories in a stable order", () => {
  const facets = packageFacets(entries, { query: "", status: "enabled", category: "engineering" });
  assert.deepEqual(facets.status, { all: 2, enabled: 1, disabled: 1 });
  assert.deepEqual(facets.categories, [
    { id: "engineering", count: 1 },
    { id: "finance", count: 1 },
    { id: "other", count: 1 },
  ]);
});

test("highlight marks every query word case-insensitively", () => {
  assert.deepEqual(highlightParts("Source control", "con SO"), [
    { text: "So", match: true },
    { text: "urce ", match: false },
    { text: "con", match: true },
    { text: "trol", match: false },
  ]);
  assert.deepEqual(highlightParts("Git", ""), [{ text: "Git", match: false }]);
});

test("a package resolves to its own visible settings page", () => {
  const slots = [
    { id: "plugins.legacy", meta: { pageId: "plugins", packageId: "plugins", nav: false } },
    { id: "git.page", meta: { pageId: "git", packageId: "git" } },
    { id: "voice.page", meta: { pageId: "voice", packageId: "voice" } },
    { id: "anon", meta: { packageId: "anon" } },
  ];
  assert.equal(packageToSettingsPageId("git", slots), "git");
  assert.equal(packageToSettingsPageId("dictation", slots), "voice", "aliases resolve to the canonical package");
  assert.equal(packageToSettingsPageId("anon", slots), "slot:anon");
  assert.equal(packageToSettingsPageId("plugins", slots), null, "hidden redirect pages are not destinations");
  assert.equal(packageToSettingsPageId("appearance", slots), "appearance", "built-in pages map to themselves");
  assert.equal(packageToSettingsPageId("terminal", slots), null);
});

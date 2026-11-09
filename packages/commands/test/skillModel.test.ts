import assert from "node:assert/strict";
import test from "node:test";
import type {
  SkillCatalogDto,
  SkillCatalogSkillDto,
  SkillHarnessDto,
  SkillLibraryDto,
  SkillLibraryEntryDto,
} from "@polyth/contracts/capability-installations";
import { rankSkillMatches } from "../src/skillSearch.ts";
import {
  availabilityOf,
  catalogView,
  defaultInstallScope,
  formatBytes,
  formatStars,
  libraryGroups,
  reachOf,
  relativeParts,
  usableCount,
} from "../widgets/skillModel.ts";

const skill = (over: Partial<SkillCatalogSkillDto> & { id: string; sourceId: string; name: string }): SkillCatalogSkillDto => ({
  title: over.name,
  description: "",
  path: over.id,
  contentHash: "h",
  files: 1,
  bytes: 1,
  scripts: 0,
  ...over,
});
const access = { project: true, space: true, sources: true, nativePolicy: true };
const catalog: SkillCatalogDto = {
  access,
  sources: [],
  skills: [
    skill({ id: "a:tdd", sourceId: "a", name: "tdd", title: "TDD", description: "Test first.", collection: "Engineering", featured: true }),
    skill({ id: "a:grill", sourceId: "a", name: "grill", title: "Grill", description: "Sharpen a plan.", collection: "Productivity" }),
    skill({ id: "b:pdf", sourceId: "b", name: "pdf", title: "PDF", description: "Test forms in documents." }),
  ],
};

test("a browsed catalog reads alphabetically under a Start here shelf", () => {
  const view = catalogView(catalog, { query: "", sourceId: null, collection: null });
  assert.deepEqual(view.rows.map((row) => row.name), ["grill", "pdf", "tdd"]);
  assert.deepEqual(view.shelf.map((row) => row.name), ["tdd"]);
  assert.deepEqual([...view.matchesBySource], [["a", 2], ["b", 1]]);
});

test("searching ranks by name, counts per source, and hides the shelf", () => {
  const view = catalogView(catalog, { query: "test", sourceId: null, collection: null });
  assert.deepEqual(view.rows.map((row) => row.name), ["pdf", "tdd"]);
  assert.deepEqual(view.shelf, []);
  assert.deepEqual([...view.matchesBySource], [["b", 1], ["a", 1]]);
});

test("a source narrows the list and offers its own shelves; source counts ignore it", () => {
  const view = catalogView(catalog, { query: "", sourceId: "a", collection: "Engineering" });
  assert.deepEqual(view.rows.map((row) => row.name), ["tdd"]);
  assert.deepEqual(view.collections, ["Engineering", "Productivity"]);
  assert.equal(view.matchesBySource.get("b"), 1, "another tile still shows what it holds");
  assert.deepEqual(view.shelf, []);
});

test("every search word must match, and a name outranks a description", () => {
  const rows = [
    { name: "pdf-tools", title: "PDF tools", description: "x" },
    { name: "docs", title: "Docs", description: "Convert to pdf files" },
    { name: "other", title: "Other", description: "pdf" },
  ];
  assert.deepEqual(rankSkillMatches(rows, "pdf").map((row) => row.name), ["pdf-tools", "docs", "other"]);
  assert.deepEqual(rankSkillMatches(rows, "pdf files").map((row) => row.name), ["docs"]);
  assert.equal(rankSkillMatches(rows, "  ").length, 3);
});

test("one click installs where the person can write, or nowhere", () => {
  assert.equal(defaultInstallScope(access, "p1"), "project");
  assert.equal(defaultInstallScope(access, null), "space");
  assert.equal(defaultInstallScope({ ...access, project: false }, "p1"), "space");
  assert.equal(defaultInstallScope({ ...access, space: false }, null), undefined);
  assert.equal(defaultInstallScope({ ...access, project: false, space: false }, "p1"), undefined);
});

const harness = (id: string, over: Partial<SkillHarnessDto> = {}): SkillHarnessDto => ({
  id,
  name: id,
  delivery: "native",
  enforcesBlockedTools: false,
  nativeSkills: "listed",
  inherits: true,
  ...over,
});
const managedEntry = (over: Partial<NonNullable<SkillLibraryEntryDto["managed"]>> = {}, natives: SkillLibraryEntryDto["natives"] = []): SkillLibraryEntryDto => ({
  name: "x",
  title: "X",
  description: "d",
  natives,
  managed: { name: "x", description: "d", scope: "space", ...over },
});
const native = (harnessId: string, over: Partial<SkillLibraryEntryDto["natives"][number]> = {}) => ({
  harnessId,
  source: "user" as const,
  enabled: true,
  locked: true,
  importable: true,
  nativeName: "x",
  ...over,
});

test("a managed skill reaches every harness that takes skills, unless switched off", () => {
  const rows = availabilityOf(managedEntry({ offHarnesses: ["b"] }), [harness("a"), harness("b"), harness("c", { delivery: "none" })]);
  assert.deepEqual(rows.map((row) => row.state), ["polyth", "off", "unsupported"]);
  assert.equal(usableCount(rows), 1);
});

test("a skill with blocked tools reaches only harnesses that can enforce them", () => {
  const entry = managedEntry({ disallowedTools: ["bash"] });
  const rows = availabilityOf(entry, [harness("strict", { enforcesBlockedTools: true }), harness("loose")]);
  assert.deepEqual(rows.map((row) => row.state), ["polyth", "unsupported"]);
  assert.deepEqual(reachOf([harness("strict", { enforcesBlockedTools: true }), harness("loose"), harness("none", { delivery: "none" })], true).map((row) => row.id), ["strict"]);
  assert.deepEqual(reachOf([harness("loose"), harness("none", { delivery: "none" })], false).map((row) => row.id), ["loose"]);
});

test("a harness's own copy still counts where Polyth's cannot reach", () => {
  const rows = availabilityOf(managedEntry({}, [native("c")]), [harness("c", { delivery: "none" })]);
  assert.equal(rows[0]!.state, "own");
});

test("a skill only some harnesses have says so for each one", () => {
  const entry: SkillLibraryEntryDto = {
    name: "x",
    title: "X",
    description: "d",
    natives: [native("own"), native("muted", { enabled: false, locked: false })],
  };
  const rows = availabilityOf(entry, [harness("own"), harness("muted"), harness("other")]);
  assert.deepEqual(rows.map((row) => row.state), ["own", "muted", "absent"]);
  assert.equal(usableCount(rows), 1);
});

test("the library groups by what a person can do, and filters by harness", () => {
  const library: SkillLibraryDto = {
    access,
    harnesses: [harness("a"), harness("b")],
    skills: [
      managedEntry({ offHarnesses: ["b"] }),
      { name: "mine", title: "Mine", description: "", natives: [native("b", { nativeName: "mine" })] },
      { name: "system", title: "System", description: "", natives: [native("a", { source: "bundled", nativeName: "system" })] },
      { name: "folder", title: "Folder", description: "", natives: [], discoveredIn: "project-agents" },
    ],
  };
  const all = libraryGroups(library, "", null);
  assert.deepEqual(all.managed.map((row) => row.name), ["x"]);
  assert.deepEqual(all.own.map((row) => row.name), ["folder", "mine"]);
  assert.deepEqual(all.builtIn.map((row) => row.name), ["system"]);
  const forB = libraryGroups(library, "", "b");
  assert.deepEqual(forB.managed.map((row) => row.name), ["x"], "still listed so it can be switched back on");
  assert.deepEqual(forB.own.map((row) => row.name), ["mine"]);
  assert.deepEqual(forB.builtIn, []);
  assert.deepEqual(libraryGroups(library, "", "gone").own, []);
  assert.deepEqual(libraryGroups(library, "syst", null).builtIn.map((row) => row.name), ["system"]);
});

test("numbers read the way people say them", () => {
  assert.equal(formatBytes(512, "en"), "512 B");
  assert.equal(formatBytes(2048, "en"), "2 KB");
  assert.equal(formatBytes(1536, "en"), "1.5 KB");
  assert.equal(formatBytes(5.5 * 1024 * 1024, "en"), "5.5 MB");
  assert.equal(formatStars(187953, "en"), "188K");
  assert.equal(formatStars(42, "en"), "42");
  const now = 1_000_000_000_000;
  assert.deepEqual(relativeParts(now - 30_000, now), { value: -30, unit: "second" });
  assert.deepEqual(relativeParts(now - 3 * 3_600_000, now), { value: -3, unit: "hour" });
  assert.deepEqual(relativeParts(now - 10 * 86_400_000, now), { value: -10, unit: "day" });
  assert.deepEqual(relativeParts(now - 400 * 86_400_000, now), { value: -1, unit: "year" });
});

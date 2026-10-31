import test from "node:test";
import assert from "node:assert/strict";
import {
  ALL_REPOSITORIES,
  executionRepositoryOf,
  normalizeRepositoryScope,
  primaryRepositoryIdOf,
  repositoryPathTail,
  repositoryScopeAliases,
  repositoryScopeValues,
  toggleRepositoryScope,
} from "../src/composer/repositoryScope.ts";

const repositories = [
  { id: "web", alias: "web", path: "/src/web" },
  { id: "api", alias: "api", path: "/src/api" },
  { id: "docs", alias: "docs", path: "/src/docs" },
];

test("the primary repository resolves like the server: declared, root match, or the only one", () => {
  assert.equal(primaryRepositoryIdOf({ path: "/x", primaryRepositoryId: "api" }, repositories), "api");
  assert.equal(primaryRepositoryIdOf({ path: "/src/web" }, repositories), "web");
  assert.equal(primaryRepositoryIdOf({ path: "/x" }, repositories), undefined, "ambiguous projects have no primary");
  assert.equal(primaryRepositoryIdOf({ path: "/x", primaryRepositoryId: "gone" }, repositories), undefined);
  assert.equal(primaryRepositoryIdOf({ path: "/x" }, [repositories[1]!]), "api");
});

test("a scope keeps project order, drops unknown ids, and collapses empty or complete subsets to all", () => {
  assert.equal(normalizeRepositoryScope(repositories, undefined), undefined);
  assert.deepEqual(normalizeRepositoryScope(repositories, ["docs", "web"]), ["web", "docs"]);
  assert.deepEqual(normalizeRepositoryScope(repositories, ["api", "removed"]), ["api"]);
  assert.equal(normalizeRepositoryScope(repositories, ["removed"]), undefined);
  assert.equal(normalizeRepositoryScope(repositories, ["docs", "api", "web"]), undefined);
});

test("toggling narrows from all, widens back to all, and never empties the scope", () => {
  assert.deepEqual(toggleRepositoryScope(repositories, undefined, "api"), ["web", "docs"]);
  assert.deepEqual(toggleRepositoryScope(repositories, ["web", "docs"], "web"), ["docs"]);
  assert.deepEqual(toggleRepositoryScope(repositories, ["docs"], "docs"), ["docs"], "the last repository stays");
  assert.equal(toggleRepositoryScope(repositories, ["web", "docs"], "api"), undefined, "every repository is all");
  assert.equal(toggleRepositoryScope(repositories, ["docs"], ALL_REPOSITORIES), undefined);
  assert.deepEqual(toggleRepositoryScope(repositories, ["docs"], "unknown"), ["docs"]);
});

test("the checkout follows the execution repository: primary while in scope, else the first selected", () => {
  assert.equal(executionRepositoryOf(repositories, undefined, "api")?.id, "api");
  assert.equal(executionRepositoryOf(repositories, ["web", "api"], "api")?.id, "api");
  assert.equal(executionRepositoryOf(repositories, ["docs", "web"], "api")?.id, "web");
  assert.equal(executionRepositoryOf(repositories, undefined, undefined)?.id, "web");
});

test("picker values and chip summaries describe the scope", () => {
  assert.deepEqual(repositoryScopeValues(repositories, undefined), [ALL_REPOSITORIES, "web", "api", "docs"]);
  assert.deepEqual(repositoryScopeValues(repositories, ["api"]), ["api"]);
  assert.equal(repositoryScopeAliases(repositories, ["web", "api"]), "web + api");
  assert.equal(repositoryScopeAliases([...repositories, { id: "ops", alias: "ops", path: "/ops" }], ["web", "api", "docs", "ops"]), "web, api +2");
  assert.equal(repositoryPathTail("/home/me/src/web"), "…/src/web");
  assert.equal(repositoryPathTail("/web"), "/web");
});

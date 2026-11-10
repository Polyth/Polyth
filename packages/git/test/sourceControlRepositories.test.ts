import test from "node:test";
import assert from "node:assert/strict";
import { defaultSourceControlRepository, sourceControlRepositories } from "../widgets/sourceControlRepositories.ts";

const project = {
  id: "p1",
  name: "App",
  path: "/work/app",
  primaryRepositoryId: "web",
  repositories: [
    { id: "web", alias: "web", path: "/work/app" },
    { id: "api", alias: "api", path: "/work/api" },
    { id: "docs", alias: "docs", path: "/work/docs" },
  ],
};

test("without a chat Source control lists every project repository", () => {
  const rows = sourceControlRepositories(project, null);
  assert.deepEqual(rows?.map((row) => [row.repositoryId, row.outsideSession ?? false]), [
    ["web", false], ["api", false], ["docs", false],
  ]);
});

test("a chat's own repositories come first; the rest are marked outside it", () => {
  const rows = sourceControlRepositories(project, {
    id: "s1",
    projectId: "p1",
    workspace: {
      mode: "subset",
      executionRepositoryId: "api",
      repositories: [{ repositoryId: "api", path: "/work/.isolate/api", state: "ready" }],
    },
  });
  assert.deepEqual(rows?.map((row) => [row.repositoryId, row.path, row.outsideSession ?? false]), [
    ["api", "/work/.isolate/api", false],
    ["web", "/work/app", true],
    ["docs", "/work/docs", true],
  ]);
});

test("a chat that selected every repository adds nothing outside it", () => {
  const rows = sourceControlRepositories(project, {
    id: "s1",
    projectId: "p1",
    workspace: { repositories: project.repositories.map((row) => ({ repositoryId: row.id, path: row.path })) },
  });
  assert.equal(rows?.some((row) => row.outsideSession), false);
  assert.equal(rows?.length, 3);
});

test("a single-repository project never gains outside rows", () => {
  const single = { id: "p2", name: "One", path: "/work/one" };
  const rows = sourceControlRepositories(single, { id: "s2", projectId: "p2" });
  assert.equal(rows?.length, 1);
  assert.equal(rows?.[0]?.outsideSession, undefined);
});

test("a foreign chat fails closed instead of falling back to the project", () => {
  assert.equal(sourceControlRepositories(project, { id: "s3", projectId: "other" }), null);
});

test("a chat opens on its own repository, not the project's primary outside it", () => {
  const rows = sourceControlRepositories(project, {
    id: "s1",
    projectId: "p1",
    workspace: {
      executionRepositoryId: "docs",
      repositories: [
        { repositoryId: "api", path: "/work/api" },
        { repositoryId: "docs", path: "/work/docs" },
      ],
    },
  })!;
  assert.equal(defaultSourceControlRepository(rows, "web", "docs"), "docs");
  assert.equal(defaultSourceControlRepository(rows, "web", undefined), "api");
  assert.equal(defaultSourceControlRepository(rows, "api", "docs"), "api");
  // Without a chat every row is the project's own: the primary wins.
  assert.equal(defaultSourceControlRepository(sourceControlRepositories(project, null)!, "web", undefined), "web");
});

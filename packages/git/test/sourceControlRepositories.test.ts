import test from "node:test";
import assert from "node:assert/strict";
import { defaultSourceControlRepository, sourceControlGitRepositories, sourceControlRepositories } from "../widgets/sourceControlRepositories.ts";

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

test("a plain project root without Git drops out once a status read said so", () => {
  const plain = {
    id: "p2",
    name: "Stack",
    path: "/work/stack",
    primaryRepositoryId: "primary",
    repositories: [
      { id: "primary", alias: "Stack", path: "/work/stack" },
      { id: "web", alias: "web", path: "/work/stack/web" },
      { id: "api", alias: "api", path: "/work/stack/api" },
    ],
  };
  const rows = sourceControlRepositories(plain, null)!;
  assert.equal(sourceControlGitRepositories(rows, new Set()), rows);
  const git = sourceControlGitRepositories(rows, new Set(["/work/stack"]));
  assert.deepEqual(git.map((row) => row.repositoryId), ["web", "api"]);
  // The primary is gone, so the view opens on the first repository instead.
  assert.equal(defaultSourceControlRepository(git, "primary", undefined), "web");
  // With nothing left to show, the rows stay and the view explains the folder.
  const none = new Set(rows.map((row) => row.path));
  assert.equal(sourceControlGitRepositories(rows, none), rows);
  // A single-folder project is never filtered.
  const single = rows.slice(0, 1);
  assert.equal(sourceControlGitRepositories(single, new Set(["/work/stack"])), single);
});

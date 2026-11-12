import test from "node:test";
import assert from "node:assert/strict";
import {
  projectRepositories,
  resolveWorkspaceContext,
  workspaceRepository,
  workspaceExecutionPath,
  workspaceOmitsProjectRoot,
  sessionRepositoryScope,
  sessionInRepositoryScope,
  type ProjectRepository,
} from "../src/workspace.ts";

const legacyProject = () => ({ id: "project-a", name: "Alpha", path: "/work/alpha" });

test("scalar runtime cwd follows canonical membership and never falls back from a missing anchor", () => {
  const project = { ...legacyProject(), primaryRepositoryId: "web", repositories: [
    { id: "web", alias: "Web", path: "/web" }, { id: "api", alias: "API", path: "/api" },
  ] };
  const session = { id: "selected", projectId: project.id, workspace: {
    mode: "subset" as const, repositories: [{ repositoryId: "api", path: "/checkouts/api" }],
  } };
  assert.equal(workspaceExecutionPath(project, session), "/checkouts/api");
  assert.equal(workspaceExecutionPath(project), "/web");
  assert.throws(() => workspaceExecutionPath(project, { ...session, workspace: {
    executionRepositoryId: "api", repositories: [
      { repositoryId: "web", path: "/web" }, { repositoryId: "api", path: "/gone", state: "missing" },
    ],
  } }), { code: "not-found" });
  assert.throws(() => workspaceExecutionPath(project, { ...session, workspace: {
    executionRepositoryId: "web", repositories: session.workspace.repositories,
  } }), { code: "not-found" });
});

test("legacy projects synthesize one primary repository and legacy worktrees stay primary", () => {
  const project = legacyProject();
  assert.deepEqual(projectRepositories(project), [{ id: "primary", alias: "Alpha", path: "/work/alpha" }]);
  assert.deepEqual(resolveWorkspaceContext(project), {
    projectId: "project-a",
    sessionId: null,
    repositories: [{ repositoryId: "primary", alias: "Alpha", path: "/work/alpha", state: "ready" }],
  });
  assert.deepEqual(resolveWorkspaceContext(project, {
    id: "session-a",
    projectId: project.id,
    worktreePath: "/work/alpha-session",
    worktreeState: "ready",
    branch: "feature/alpha",
  }).repositories, [{
    repositoryId: "primary",
    alias: "Alpha",
    path: "/work/alpha-session",
    state: "ready",
    branch: "feature/alpha",
  }]);
  const multiRepositoryProject = {
    ...project,
    repositories: [
      { id: "primary", alias: "Alpha", path: "/work/alpha" },
      { id: "api", alias: "API", path: "/work/api" },
    ],
    primaryRepositoryId: "primary",
  };
  assert.deepEqual(resolveWorkspaceContext(multiRepositoryProject, {
    id: "isolated",
    projectId: project.id,
    worktreePath: "/work/alpha-session",
    isolation: { worktreePath: "/work/alpha-session", state: "active" },
  }).repositories, [{
    repositoryId: "primary", alias: "Alpha", path: "/work/alpha-session", state: "ready",
  }]);
  assert.throws(() => resolveWorkspaceContext(multiRepositoryProject, {
    id: "malformed-isolation",
    projectId: project.id,
    isolation: { state: "active" },
  }), { code: "invalid-input" });
});

test("multi-repository workspaces keep same relative files isolated by repository", () => {
  const repositories: ProjectRepository[] = [
    { id: "web", alias: "Web", path: "/work/web" },
    { id: "api", alias: "API", path: "/work/api" },
  ];
  const project = { ...legacyProject(), repositories, primaryRepositoryId: "web" };
  assert.deepEqual(resolveWorkspaceContext(project, {
    id: "session-default",
    projectId: project.id,
  }).repositories, [
    { repositoryId: "web", alias: "Web", path: "/work/web", state: "ready" },
    { repositoryId: "api", alias: "API", path: "/work/api", state: "ready" },
  ]);
  const context = resolveWorkspaceContext(project, {
    id: "session-a",
    projectId: project.id,
    workspace: {
      repositories: [
        { repositoryId: "web", path: "/checkouts/web", branch: "feature/a" },
        { repositoryId: "api", path: "/checkouts/api", branch: "feature/a" },
      ],
    },
  });
  assert.deepEqual(workspaceRepository(context, "web"), {
    repositoryId: "web", alias: "Web", path: "/checkouts/web", state: "ready", branch: "feature/a",
  });
  assert.deepEqual(workspaceRepository(context, "api"), {
    repositoryId: "api", alias: "API", path: "/checkouts/api", state: "ready", branch: "feature/a",
  });
});

test("foreign sessions, unknown repositories, and duplicate project identities fail closed", () => {
  const project = legacyProject();
  assert.throws(
    () => resolveWorkspaceContext(project, { id: "foreign", projectId: "project-b" }),
    { code: "not-found" },
  );
  const context = resolveWorkspaceContext(project);
  assert.throws(() => workspaceRepository(context, "missing"), { code: "not-found" });
  assert.throws(() => projectRepositories({
    ...project,
    repositories: [
      { id: "one", alias: "One", path: "/one" },
      { id: "one", alias: "Duplicate", path: "/two" },
    ],
  }), { code: "invalid-input" });
});

test("explicit membership preserves exclusions and missing logical state", () => {
  const project = {
    ...legacyProject(),
    repositories: [
      { id: "web", alias: "Web", path: "/work/web" },
      { id: "api", alias: "API", path: "/work/api" },
    ],
    primaryRepositoryId: "web",
  };
  const context = resolveWorkspaceContext(project, {
    id: "session-a",
    projectId: project.id,
    workspace: { repositories: [{ repositoryId: "api", path: "/checkouts/api", state: "missing" }] },
  });
  assert.deepEqual(context.repositories, [{
    repositoryId: "api", alias: "API", path: "/checkouts/api", state: "missing",
  }]);
  assert.throws(() => workspaceRepository(context, "web"), { code: "not-found" });
  assert.deepEqual(resolveWorkspaceContext(project, {
    id: "legacy-missing",
    projectId: project.id,
    worktreeState: "missing",
  }).repositories, [
    { repositoryId: "web", alias: "Web", path: "/work/web", state: "missing" },
    { repositoryId: "api", alias: "API", path: "/work/api", state: "ready" },
  ]);
  assert.throws(() => resolveWorkspaceContext(project, {
    id: "bad-state",
    projectId: project.id,
    workspace: { repositories: [{ repositoryId: "api", path: "/checkouts/api", state: "busy" as never }] },
  }), { code: "invalid-input" });
});

test("ambiguous roots and conflicting legacy snapshots are rejected", () => {
  const project = {
    ...legacyProject(),
    path: "/work/unknown",
    repositories: [
      { id: "web", alias: "Web", path: "/work/web" },
      { id: "api", alias: "API", path: "/work/api" },
    ],
  };
  assert.throws(() => resolveWorkspaceContext(project, {
    id: "session-a",
    projectId: project.id,
    worktreePath: "/legacy",
  }), { code: "invalid-input" });
  assert.throws(() => resolveWorkspaceContext({ ...project, primaryRepositoryId: "web" }, {
    id: "session-a",
    projectId: project.id,
    worktreePath: "/legacy",
    workspace: { repositories: [{ repositoryId: "web", path: "/snapshot" }] },
  }), { code: "invalid-input" });
  assert.throws(() => resolveWorkspaceContext({
    ...project,
    primaryRepositoryId: "web",
  }, {
    id: "session-a",
    projectId: project.id,
    workspace: {
      repositories: [
        { repositoryId: "web", path: "/same" },
        { repositoryId: "api", path: "/same" },
      ],
    },
  }), { code: "invalid-input" });
});

test("removed registrations stay visible as missing without becoming checkout authority", () => {
  const project = { id: "p", name: "Web", path: "/web" };
  const context = resolveWorkspaceContext(project, { id: "s", projectId: "p", workspace: {
    executionRepositoryId: "primary", repositories: [
      { repositoryId: "primary", path: "/web" }, { repositoryId: "removed", alias: "API", path: "/old-api" },
    ],
  } });
  assert.deepEqual(context.repositories[1], { repositoryId: "removed", alias: "API", path: "/old-api", state: "missing" });
});


test("legacy session root is not redirected when its registration is relocated", () => {
  const project = { id: "p", name: "App", path: "/original/app", legacyRepositoryId: "app", primaryRepositoryId: "app", repositories: [{ id: "app", alias: "App", path: "/moved/app" }] };
  const session = { id: "s", projectId: "p" };
  const context = resolveWorkspaceContext(project, session);
  assert.equal(context.repositories[0]?.path, "/original/app");
  assert.equal(context.repositories[0]?.state, "missing");
  assert.throws(() => workspaceExecutionPath(project, session), /missing/);
  assert.equal(workspaceExecutionPath(project), "/moved/app");
});

test("Files offers the project folder only when a multi-repository workspace hides it", () => {
  const plainRoot = { id: "p", name: "Stack", path: "/stack", primaryRepositoryId: "primary", repositories: [
    { id: "primary", alias: "Stack", path: "/stack" }, { id: "web", alias: "web", path: "/stack/web" },
  ] };
  const all = resolveWorkspaceContext(plainRoot).repositories;
  assert.equal(workspaceOmitsProjectRoot(plainRoot, all), false);
  // A chat that chose only `web` still reaches the folder holding it.
  assert.equal(workspaceOmitsProjectRoot(plainRoot, [{ repositoryId: "web", path: "/stack/web" }]), true);
  // The chat's own (isolated) checkout of the root repository counts as shown.
  assert.equal(workspaceOmitsProjectRoot(plainRoot, [{ repositoryId: "primary", path: "/isolate/stack" }]), false);
  // Single-repository and legacy projects never get a second root entry.
  assert.equal(workspaceOmitsProjectRoot(legacyProject(), [{ repositoryId: "primary", path: "/isolate/alpha" }]), false);
  // A root folder that is no longer registered is offered by path.
  const unregistered = { ...plainRoot, primaryRepositoryId: "web", repositories: [
    { id: "web", alias: "web", path: "/stack/web" }, { id: "api", alias: "api", path: "/stack/api" },
  ] };
  assert.equal(workspaceOmitsProjectRoot(unregistered, resolveWorkspaceContext(unregistered).repositories), true);
});

test("repository scope: whole project, subset, covering subset, missing workspace and legacy no-mode", () => {
  const rows = (...ids: string[]) => ids.map((repositoryId) => ({ repositoryId, path: `/checkouts/${repositoryId}`, branch: "feature" }));
  const project = ["api", "web", "docs"];
  assert.equal(sessionRepositoryScope({ workspace: { mode: "all", repositories: rows("api") } }, project), undefined);
  assert.deepEqual(sessionRepositoryScope({ workspace: { mode: "subset", repositories: rows("api", "web") } }, project), { repositoryIds: ["api", "web"] });
  // Listing every current registration is the whole project again.
  assert.equal(sessionRepositoryScope({ workspace: { mode: "subset", repositories: rows("docs", "api", "web") } }, project), undefined);
  // Without the registration set the snapshot is taken at its word.
  assert.deepEqual(sessionRepositoryScope({ workspace: { mode: "subset", repositories: rows("docs", "api", "web") } }), { repositoryIds: ["docs", "api", "web"] });
  // A registration removed since the snapshot does not make it cover the project.
  assert.deepEqual(sessionRepositoryScope({ workspace: { mode: "subset", repositories: rows("api", "gone") } }, ["api", "web"]), { repositoryIds: ["api", "gone"] });
  assert.equal(sessionRepositoryScope({}, project), undefined);
  assert.equal(sessionRepositoryScope({ workspace: null }, project), undefined);
  assert.equal(sessionRepositoryScope(undefined, project), undefined);
  assert.deepEqual(sessionRepositoryScope({ workspace: { repositories: rows("web") } }, project), { repositoryIds: ["web"] });
  assert.equal(sessionRepositoryScope({ workspace: { repositories: [] } }, project), undefined);
  // Ids only: the result never carries a path or branch.
  assert.ok(!JSON.stringify(sessionRepositoryScope({ workspace: { repositories: rows("web") } })).includes("/checkouts/"));
  // A summary answers from its derived field; a stale merged workspace never wins.
  assert.deepEqual(sessionRepositoryScope({ summary: true, repositoryScope: { repositoryIds: ["web"] }, workspace: { mode: "all", repositories: rows("api") } }, project), { repositoryIds: ["web"] });
  assert.equal(sessionRepositoryScope({ summary: true, workspace: { mode: "subset", repositories: rows("api") } }, project), undefined);
  // Malformed ids are dropped, duplicates collapse.
  assert.deepEqual(sessionRepositoryScope({ repositoryScope: { repositoryIds: ["api", "api", "", 3, "x".repeat(201)] } }), { repositoryIds: ["api"] });
  assert.equal(sessionInRepositoryScope({ workspace: { mode: "subset", repositories: rows("api", "web") } }, "web", project), true);
  assert.equal(sessionInRepositoryScope({ workspace: { mode: "subset", repositories: rows("api", "web") } }, "docs", project), false);
  assert.equal(sessionInRepositoryScope({ workspace: { mode: "all", repositories: rows("api") } }, "api", project), false);
});

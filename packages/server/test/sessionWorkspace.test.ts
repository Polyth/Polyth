import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionWorkspace,
  validateWorkspacePaths,
  workspaceSelection,
} from "../src/sessionWorkspace.ts";
import { workspaceExecutionPath } from "@polyth/contracts/workspace";

const project = {
  id: "project-1",
  name: "Project",
  path: "/work/primary",
  primaryRepositoryId: "repo-primary",
  repositories: [
    { id: "repo-primary", alias: "app", path: "/work/primary" },
    { id: "repo-secondary", alias: "docs", path: "/work/docs" },
  ],
};

test("session workspace snapshots all repositories and anchors scalar cwd to primary", () => {
  const workspace = createSessionWorkspace(project, {});
  assert.deepEqual(workspace.repositories.map((row) => row.repositoryId), ["repo-primary", "repo-secondary"]);
  assert.equal(workspace.executionRepositoryId, "repo-primary");
  assert.equal(workspaceExecutionPath(project, {
    id: "session-1", projectId: project.id, workspace,
  }), "/work/primary");
});

test("subset without primary anchors scalar cwd to the first selected repository", () => {
  const workspace = createSessionWorkspace(project, { repositoryIds: ["repo-secondary"] });
  assert.equal(workspace.mode, "subset");
  assert.equal(workspace.executionRepositoryId, "repo-secondary");
  assert.equal(workspaceExecutionPath(project, {
    id: "session-1", projectId: project.id, workspace,
  }), "/work/docs");
});

test("trusted multi-repository isolation snapshots are retained without primary-only narrowing", () => {
  const isolation = {
    kind: "git-worktree" as const,
    state: "active" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    worktreePath: "/tmp/isolate-app",
    worktreeBranch: "polyth/isolate/app",
    targetPath: "/work/primary",
    targetBranch: "main",
    baseCommit: "a".repeat(40),
  };
  const workspace = createSessionWorkspace(project, {
    isolated: true,
    worktreePath: "/tmp/isolate-app",
    workspace: {
      mode: "all",
      revision: 7,
      executionRepositoryId: "repo-primary",
      repositories: [
        { repositoryId: "repo-primary", alias: "app", path: "/tmp/isolate-app", state: "ready", isolation },
        { repositoryId: "repo-secondary", alias: "docs", path: "/tmp/isolate-docs", state: "ready", isolation: { ...isolation, worktreePath: "/tmp/isolate-docs", worktreeBranch: "polyth/isolate/docs", targetPath: "/work/docs" } },
      ],
    },
  });
  assert.equal(workspace.mode, "all");
  assert.deepEqual(workspace.repositories.map((row) => row.repositoryId), ["repo-primary", "repo-secondary"]);
  assert.notEqual(workspace.repositories[0]!.isolation, isolation);
  assert.notEqual(workspace.repositories[0]!.isolation, workspace.repositories[1]!.isolation);
});

test("workspace selection uses a revision CAS and retains the execution anchor", () => {
  const currentWorkspace = createSessionWorkspace(project, {});
  const current = { id: "session-1", projectId: project.id, workspace: currentWorkspace, status: "idle" as const };
  const next = workspaceSelection(project, current, {
    repositoryIds: ["repo-primary"], expectedRevision: 1,
  });
  assert.equal(next.revision, 2);
  assert.equal(next.executionRepositoryId, "repo-primary");
  assert.throws(() => workspaceSelection(project, current, {
    repositoryIds: ["repo-primary"], expectedRevision: 0,
  }), (error: Error & { code?: string }) => error.code === "conflict");
  assert.throws(() => workspaceSelection(project, current, {
    repositoryIds: ["repo-secondary"], expectedRevision: 1,
  }), (error: Error & { code?: string }) => error.code === "conflict");
});

test("membership changes retain managed checkout ownership and clone its evidence", () => {
  const workspace = createSessionWorkspace(project, {});
  const isolation = { kind: "git-worktree" as const, state: "active" as const, createdAt: "now", worktreePath: "/checkout", worktreeBranch: "isolated", targetPath: project.path, targetBranch: "main", baseCommit: "a".repeat(40) };
  workspace.repositories[0] = { ...workspace.repositories[0]!, path: isolation.worktreePath, isolation };
  const selected = workspaceSelection(project, { id: "session", projectId: project.id, workspace, status: "idle" }, { repositoryIds: ["repo-primary"] });
  assert.deepEqual(selected.repositories[0]?.isolation, isolation);
  assert.notEqual(selected.repositories[0]?.isolation, isolation);
});

test("workspace path validation permits registered roots and missing snapshots, rejects unknown checkouts", async () => {
  const workspace = createSessionWorkspace(project, { repositoryIds: ["repo-secondary"] });
  const owner = { projects: { get: async () => project } };
  await validateWorkspacePaths(owner, project, workspace);
  await assert.rejects(
    validateWorkspacePaths(owner, project, {
      ...workspace,
      repositories: [{ ...workspace.repositories[0]!, path: "/outside" }],
    }),
    (error: Error & { code?: string }) => error.code === "not-found",
  );
  await validateWorkspacePaths(owner, project, {
    ...workspace,
    repositories: [{ ...workspace.repositories[0]!, path: "/gone", state: "missing" }],
  });
});

test("workspace path validation maps a worktree to its owning repository inventory", async () => {
  const workspace = createSessionWorkspace(project, { repositoryIds: ["repo-secondary"] });
  const owner = {
    projects: { get: async () => project },
    worktrees: { list: async (root: string) => root === "/work/primary"
      ? [{ path: "/work/secondary-worktree", branch: "feature" }]
      : [] },
  };
  await assert.rejects(
    validateWorkspacePaths(owner, project, {
      ...workspace,
      repositories: [{ ...workspace.repositories[0]!, path: "/work/secondary-worktree" }],
    }),
    (error: Error & { code?: string }) => error.code === "not-found",
  );
});

test("relocation is explicit, revision fenced, and cannot replace managed checkouts", () => {
  const workspace = createSessionWorkspace(project, {});
  const current = { id: "session", projectId: project.id, workspace, status: "idle" as const };
  const relocatedProject = { ...project, repositories: project.repositories.map((row) => row.id === "repo-secondary" ? { ...row, path: "/work/located-docs" } : row) };
  const unchanged = workspaceSelection(relocatedProject, current, { expectedRevision: 1 });
  assert.equal(unchanged.repositories[1]?.path, "/work/docs");
  const repaired = workspaceSelection(relocatedProject, current, { expectedRevision: 1, relocateRepositoryIds: ["repo-secondary"] });
  assert.equal(repaired.repositories[1]?.path, "/work/located-docs");
  assert.equal(repaired.repositories[0]?.path, project.path);
  for (const selection of [
    { relocateRepositoryIds: ["repo-secondary"] },
    { expectedRevision: 0, relocateRepositoryIds: ["repo-secondary"] },
    { expectedRevision: 1, relocateRepositoryIds: ["repo-secondary", "repo-secondary"] },
    { expectedRevision: 1, relocateRepositoryIds: ["foreign"] },
    { expectedRevision: 1, repositoryIds: ["repo-primary"], relocateRepositoryIds: ["repo-secondary"] },
  ]) assert.throws(() => workspaceSelection(relocatedProject, current, selection));
  assert.throws(() => workspaceSelection(relocatedProject, { ...current, isolation: { kind: "git-worktree", state: "active" } as never }, { expectedRevision: 1, relocateRepositoryIds: ["repo-secondary"] }), /isolation lifecycle/);
});

test("relocating the execution repository validates its future scalar checkout", () => {
  const workspace = createSessionWorkspace(project, {});
  const source = "/work/completed-parent";
  workspace.repositories[0]!.path = source;
  const current = {
    id: "child", projectId: project.id, status: "idle" as const,
    worktreePath: source, workspace,
  };
  const relocated = workspaceSelection(project, current, {
    expectedRevision: 1, relocateRepositoryIds: ["repo-primary"],
  });
  assert.equal(relocated.repositories[0]!.path, project.path);
  assert.equal(relocated.revision, 2);
  assert.equal(current.worktreePath, source);
  assert.equal(current.workspace.repositories[0]!.path, source);
  assert.throws(() => workspaceSelection(project, {
    ...current, worktreePath: "/work/unrelated-checkout",
  }, { expectedRevision: 1, relocateRepositoryIds: ["repo-primary"] }), /conflicts with its workspace/);
});

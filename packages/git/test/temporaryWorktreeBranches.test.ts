import test from "node:test";
import assert from "node:assert/strict";
import { createTemporaryWorktreeBranchService } from "../src/temporaryWorktreeBranches.ts";
import type { GitService } from "../src/index.ts";
import type { ProjectService, SessionService } from "@polyth/contracts";

test("temporary worktree branch follows the model-generated session title", async () => {
  const renamed: Array<[string, string, string]> = [];
  const projected: Array<{ from: string; to: string }> = [];
  const service = createTemporaryWorktreeBranchService({
    git: {
      worktrees: { list: async () => [{ path: "/repo-wt", branch: "temp/red-panther-4821", head: "abc", isMain: false }] },
      branches: async () => ({ current: "main", branches: [{ name: "main", current: true }] }),
      renameBranch: async (root: string, from: string, to: string) => { renamed.push([root, from, to]); },
    } as unknown as GitService,
    projects: { get: async () => ({ id: "p1", name: "Repo", path: "/repo" }) } as unknown as ProjectService,
    sessions: {
      snapshot: async () => ({ id: "s1", projectId: "p1", title: "New session", status: "working", createdAt: 1, updatedAt: 1, worktreePath: "/repo-wt", branch: "temp/red-panther-4821" }),
      renameWorktreeBranch: async (_sessionId: string, input: { worktreePath: string; from: string; to: string }) => {
        projected.push({ from: input.from, to: input.to });
        return { id: "s1", projectId: "p1", title: "Fix login crash", status: "working", createdAt: 1, updatedAt: 2, worktreePath: "/repo-wt", branch: input.to };
      },
    } as unknown as SessionService,
  });

  assert.equal(await service.renameForSessionTitle("s1", "Fix login crash"), "fix/login-crash");
  assert.deepEqual(renamed, [["/repo-wt", "temp/red-panther-4821", "fix/login-crash"]]);
  assert.deepEqual(projected, [{ from: "temp/red-panther-4821", to: "fix/login-crash" }]);
});

test("ordinary user branches are never renamed", async () => {
  let renamed = false;
  const service = createTemporaryWorktreeBranchService({
    git: { renameBranch: async () => { renamed = true; } } as unknown as GitService,
    projects: {} as ProjectService,
    sessions: {
      snapshot: async () => ({ id: "s1", projectId: "p1", title: "New session", status: "working", createdAt: 1, updatedAt: 1, worktreePath: "/repo-wt", branch: "feat/user-owned" }),
      renameWorktreeBranch: async () => { throw new Error("must not run"); },
    } as unknown as SessionService,
  });

  assert.equal(await service.renameForSessionTitle("s1", "Add picker"), null);
  assert.equal(renamed, false);
});

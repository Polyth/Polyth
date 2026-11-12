import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionIsolation, SessionProjection, SessionWorkspace } from "@polyth/contracts";
import { createStore } from "../src/index.ts";

const row = (repositoryId: string, path: string) => ({
  repositoryId,
  path,
  branch: `feature/${repositoryId}`,
  // Checkout evidence that must never reach a summary.
  isolation: { kind: "git-worktree", createdAt: "today", worktreePath: `${path}-isolated`, worktreeBranch: "polyth/isolate/x", targetPath: path, targetBranch: "main", baseCommit: "base" } as unknown as SessionIsolation,
});
const subset = (...ids: string[]): SessionWorkspace => ({ mode: "subset", revision: 1, repositories: ids.map((id) => row(id, `/secret/${id}`)) });

test("summary listing filters by repository subset, follows root parents and never carries paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "polyth-repository-scope-"));
  try {
    const store = createStore(join(dir, "sessions.db"));
    let updatedAt = 10;
    const put = (id: string, extra: Partial<SessionProjection> = {}, spaceId = "space", projectId = "p") =>
      store.upsertProjection({ id, spaceId, projectId, title: id, status: "idle", createdAt: 1, updatedAt: updatedAt++, ...extra });
    await put("api-only", { workspace: subset("api") });
    await put("api-web", { workspace: subset("api", "web") });
    await put("web-only", { workspace: subset("web") });
    await put("whole-mode", { workspace: { mode: "all", repositories: [row("api", "/a"), row("web", "/w"), row("docs", "/d")] } });
    await put("covering", { workspace: subset("api", "web", "docs") });
    await put("legacy-no-mode", { workspace: { repositories: [row("api", "/legacy-api")] } });
    await put("no-workspace");
    // A delegated child follows its parent, whatever its own snapshot says.
    await put("api-child", { parentId: "api-only", workspace: subset("web") });
    await put("api-grandchild", { parentId: "api-child" });
    await put("whole-child", { parentId: "whole-mode", workspace: subset("api") });
    // A foreign Space row with the same project and repository id.
    await put("foreign", { workspace: subset("api") }, "other-space");
    // Another project's subset in the same Space.
    await put("other-project", { workspace: subset("api") }, "space", "q");

    const projectRepositoryIds = ["api", "web", "docs"];
    const ids = async (repositoryId: string, extra: Record<string, unknown> = {}) =>
      (await store.summaries!({ spaceId: "space", projectId: "p", repositoryId, projectRepositoryIds, ...extra })).sessions.map((session) => session.id).sort();

    assert.deepEqual(await ids("api"), ["api-child", "api-grandchild", "api-only", "api-web", "legacy-no-mode"]);
    assert.deepEqual(await ids("web"), ["api-web", "web-only"]);
    assert.deepEqual(await ids("docs"), []);
    assert.deepEqual(await ids("missing"), []);
    // Without the current registration set a covering subset is still a subset.
    assert.ok((await store.summaries!({ spaceId: "space", projectId: "p", repositoryId: "docs" })).sessions.some((session) => session.id === "covering"));
    // The filter combines with the others (title search here).
    assert.deepEqual(await ids("api", { query: "web" }), ["api-web"]);
    // The filter needs a project: without one it is not applied.
    assert.equal((await store.summaries!({ spaceId: "space", repositoryId: "api" })).sessions.length, 11);

    const all = await store.summaries!({ spaceId: "space", projectId: "p" });
    const byId = new Map(all.sessions.map((session) => [session.id, session]));
    assert.deepEqual(byId.get("api-web")?.repositoryScope, { repositoryIds: ["api", "web"] });
    assert.deepEqual(byId.get("legacy-no-mode")?.repositoryScope, { repositoryIds: ["api"] });
    assert.equal(byId.get("whole-mode")?.repositoryScope, undefined);
    assert.equal(byId.get("no-workspace")?.repositoryScope, undefined);
    for (const session of all.sessions) {
      assert.equal(session.workspace, undefined, `${session.id} carries no workspace`);
      const text = JSON.stringify(session);
      assert.ok(!text.includes("/secret/") && !text.includes("feature/") && !text.includes("isolate"), `${session.id} carries no paths: ${text}`);
    }
    assert.ok(!all.sessions.some((session) => session.id === "foreign"));
    const foreign = await store.summaries!({ spaceId: "other-space", projectId: "p", repositoryId: "api", projectRepositoryIds });
    assert.deepEqual(foreign.sessions.map((session) => session.id), ["foreign"]);
    await store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

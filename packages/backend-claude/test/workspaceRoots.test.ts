import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeWorkspaceDirectories } from "../src/index.ts";

const context = { spaceId: "space", projectId: "project", sessionId: "session", cwd: "/work/primary" };
const workspace = (repositories: Array<{ repositoryId: string; path: string; state: "ready" | "missing" }>) => ({
  projectId: "project", sessionId: "session", repositories: repositories.map((repository) => ({ ...repository, alias: repository.repositoryId })),
});

test("Claude workspace roots include only ready canonical repositories and exclude cwd", () => {
  const result = claudeWorkspaceDirectories(context, workspace([
    { repositoryId: "primary", path: "/work/primary", state: "ready" },
    { repositoryId: "secondary", path: "/work/secondary", state: "ready" },
    { repositoryId: "missing", path: "/work/missing", state: "missing" },
  ]));
  assert.deepEqual(result, { ok: true, additionalDirectories: ["/work/secondary"] });
});

test("Claude workspace roots fail closed for foreign sessions or an unavailable execution root", () => {
  assert.equal(claudeWorkspaceDirectories(context, { ...workspace([{ repositoryId: "primary", path: "/work/primary", state: "ready" }]), sessionId: "other" }).ok, false);
  assert.equal(claudeWorkspaceDirectories(context, workspace([{ repositoryId: "primary", path: "/work/primary", state: "missing" }])).ok, false);
  assert.equal(claudeWorkspaceDirectories(context, workspace([{ repositoryId: "primary", path: "relative", state: "ready" }])).ok, false);
});

test("Claude workspace roots deduplicate canonical paths", () => {
  const result = claudeWorkspaceDirectories(context, workspace([
    { repositoryId: "primary", path: "/work/primary", state: "ready" },
    { repositoryId: "secondary", path: "/work/secondary", state: "ready" },
    { repositoryId: "alias", path: "/work/secondary/.", state: "ready" },
  ]));
  assert.deepEqual(result, { ok: true, additionalDirectories: ["/work/secondary"] });
});

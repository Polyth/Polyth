import { test } from "node:test";
import assert from "node:assert/strict";
import { mapChangeRequest, mapDiffFiles, mapDiffText, mapIssue, mapNote, mapPipelineJob, mapRepository, mapThread } from "../src/mappers.ts";

test("maps GitLab repository, issue, and merge request identity", () => {
  const repo = mapRepository({ name: "app", path_with_namespace: "acme/app", web_url: "https://gitlab.example/acme/app", namespace: { full_path: "acme" }, forked_from_project: { web_url: "https://gitlab.example/upstream/app" }, visibility: "private", default_branch: "main" });
  assert.deepEqual(repo, { name: "app", owner: "acme", url: "https://gitlab.example/acme/app", description: "", defaultBranch: "main", isPrivate: true, visibility: "private", provider: "gitlab", instance: "https://gitlab.example", fullPath: "acme/app", upstream: "https://gitlab.example/upstream/app" });
  const issue = mapIssue({ iid: 7, title: "Bug", state: "opened", author: { username: "kat" }, updated_at: "u", created_at: "c", web_url: "https://gitlab.example/issue", description: "body", labels: ["bug"], assignees: [{ username: "dev" }] });
  assert.equal(issue.number, 7); assert.equal(issue.state, "OPEN"); assert.deepEqual(issue.labels, ["bug"]); assert.deepEqual(issue.assignees, ["dev"]);
  const mr = mapChangeRequest({ iid: 9, title: "Feature", state: "opened", author: { username: "kat" }, updated_at: "u", created_at: "c", web_url: "https://gitlab.example/mr", description: "d", source_branch: "feature/x", target_branch: "main", source_project_id: 11, target_project_id: 12, sha: "head", draft: true, detailed_merge_status: "conflict", diff_refs: { base_sha: "base", start_sha: "start", head_sha: "head" } });
  assert.equal(mr.mergeable, "CONFLICTING"); assert.equal(mr.isDraft, true); assert.deepEqual(mr.diffRefs, { base: "base", head: "head", start: "start" }); assert.equal(mr.sourceProject, "11");
});

test("maps notes, discussions, diffs, and pipeline jobs", () => {
  const note = mapNote({ id: 4, body: "inline", author: { username: "kat" }, created_at: "now", position: { new_path: "src/a.ts", new_line: 8 }, resolvable: true, resolved: false }, "https://gitlab.example/fallback");
  assert.deepEqual(note, { id: "4", author: "kat", body: "inline", createdAt: "now", url: "https://gitlab.example/fallback", kind: "review", path: "src/a.ts", line: 8, resolved: false });
  const thread = mapThread({ id: "thread", notes: [{ id: 1, body: "x", author: { username: "a" }, resolvable: true, resolved: true }] }, "https://gitlab.example/fallback");
  assert.equal(thread.resolved, true); assert.equal(thread.resolvable, true); assert.equal(thread.comments[0]?.threadId, "thread");
  const diffs = [{ old_path: "old.ts", new_path: "new.ts", diff: "@@\n-old\n+new\n" }, { old_path: "gone", new_path: "gone", diff: "-x\n" }];
  assert.deepEqual(mapDiffFiles(diffs), [{ path: "new.ts", additions: 1, deletions: 1 }, { path: "gone", additions: 0, deletions: 1 }]);
  assert.match(mapDiffText(diffs), /diff --git a\/old\.ts b\/new\.ts[\s\S]*--- a\/old\.ts[\s\S]*\+\+\+ b\/new\.ts[\s\S]*-old[\s\S]*\+new/);
  const job = mapPipelineJob({ id: 3, name: "build", status: "failed", duration: 12, web_url: "https://gitlab.example/job" }, "pipeline");
  assert.equal(job.status, "failure"); assert.equal(job.summary, "failed · 12s"); assert.equal(job.workflow, "pipeline");
});

test("builds parser-compatible unified diff headers for new, deleted, and renamed files", () => {
  const diff = mapDiffText([
    { old_path: "old name.ts", new_path: "new name.ts", renamed_file: true, diff: "@@ -1 +1 @@\n-old\n+new" },
    { old_path: "created.ts", new_path: "created.ts", new_file: true, diff: "@@ -0,0 +1 @@\n+new" },
    { old_path: "removed.ts", new_path: "removed.ts", deleted_file: true, diff: "@@ -1 +0,0 @@\n-old" },
  ]);
  assert.match(diff, /diff --git "a\/old name\.ts" "b\/new name\.ts"/);
  assert.match(diff, /--- \/dev\/null\n\+\+\+ b\/created\.ts/);
  assert.match(diff, /--- a\/removed\.ts\n\+\+\+ \/dev\/null/);
  assert.match(diff, /rename from "old name\.ts"\nrename to "new name\.ts"/);
});

test("thread resolution follows the resolvable root note", () => {
  const resolved = mapThread({ id: "t", notes: [
    { id: 1, body: "root", resolvable: true, resolved: true },
    { id: 2, body: "reply", resolvable: false },
  ] }, "https://gitlab.example/fallback");
  const open = mapThread({ id: "t2", notes: [
    { id: 1, body: "root", resolvable: true, resolved: false },
    { id: 2, body: "reply", resolvable: false },
  ] }, "https://gitlab.example/fallback");
  assert.equal(resolved.resolved, true); assert.equal(open.resolved, false); assert.equal(resolved.resolvable, true);
});

test("unsafe pipeline URLs are rejected", () => {
  assert.throws(() => mapPipelineJob({ id: 1, name: "build", status: "success", web_url: "javascript:alert(1)" }), /unsafe URL/);
});

test("internal repositories are never presented as public", () => {
  const repo = mapRepository({ visibility: "internal" });
  assert.equal(repo.visibility, "internal");
  assert.equal(repo.isPrivate, true);
});

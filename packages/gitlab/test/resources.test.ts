import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitlabService, type GitlabResourceClient } from "../src/resources.ts";

const mr = (extra: Record<string, unknown> = {}) => ({ iid: 7, id: 70, title: "Feature", state: "opened", author: { username: "kat" }, updated_at: "u", created_at: "c", web_url: "https://gitlab.example/acme/app/-/merge_requests/7", description: "body", source_branch: "feature/x", target_branch: "main", sha: "head", diff_refs: { base_sha: "base", start_sha: "start", head_sha: "head" }, detailed_merge_status: "mergeable", ...extra });
const issue = () => ({ iid: 3, title: "Bug", state: "opened", author: { username: "kat" }, updated_at: "u", created_at: "c", web_url: "https://gitlab.example/acme/app/-/issues/3", description: "body" });
function harness(responses: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; method?: string; body?: Record<string, unknown> }> = [];
  const client: GitlabResourceClient = { request: async <T>(path: string, options?: { method?: string; body?: Record<string, unknown> }): Promise<T> => { calls.push({ path, method: options?.method, body: options?.body }); const value = responses[path]; if (typeof value === "function") return await (value as (input: { method?: string; body?: Record<string, unknown> } | undefined) => Promise<T> | T)(options); if (value instanceof Error) throw value; if (options?.method === "POST" && path.includes("/notes")) return { id: 99, body: String(options.body?.body ?? ""), author: { username: "kat" }, created_at: "now", web_url: "https://gitlab.example/note" } as T; return (value ?? (path.includes("/diffs") ? [] : path.includes("/notes") ? [] : mr())) as T; } };
  const service = createGitlabService({ client, projectPath: "acme/app", instance: "https://gitlab.example", user: { login: "kat", avatarUrl: "" }, currentBranch: async () => "feature/x" });
  return { service, calls };
}
const merge = (service: unknown, expectedHead?: string) => (service as { prMerge: (...args: unknown[]) => Promise<{ ok: boolean }> }).prMerge("/cwd", 7, "merge", expectedHead);

test("uses nested encoded project endpoints and maps issues, merge requests, drafts, and forks", async () => {
  const { service, calls } = harness({
    "projects/acme%2Fapp/issues?state=opened&scope=all&order_by=updated_at&sort=desc&per_page=30&page=1": [issue()],
    "projects/acme%2Fapp/merge_requests?state=opened&scope=all&order_by=updated_at&sort=desc&per_page=30&page=1": [mr({ draft: true, source_project_id: 9, target_project_id: 1 })],
  });
  const issues = await service.issues("/cwd", 30); const prs = await service.prs("/cwd", 30);
  assert.equal(issues.ok, true); assert.equal(prs.ok, true);
  if (prs.ok) { assert.equal(prs.data[0]?.isDraft, true); assert.equal(prs.data[0]?.sourceProject, "9"); }
  assert.equal(calls[0]?.path.includes("projects/acme%2Fapp"), true);
});

test("pipeline job mapping fails soft when job enrichment fails", async () => {
  const key = "projects/acme%2Fapp/merge_requests/7";
  const { service } = harness({ [key]: mr({ head_pipeline: { id: 2, project_id: 1, status: "running" } }), "projects/1/pipelines/2/jobs?per_page=100&page=1": new Error("offline") });
  const result = await service.prChecks("/cwd", 7);
  assert.equal(result.ok, true); if (result.ok) { assert.equal(result.data.length, 1); assert.match(result.data[0]!.summary ?? "", /Job details unavailable/); }
});

test("create, update, ready, comments, reply, resolve, and unapprove use one request each", async () => {
  const { service, calls } = harness({ "projects/acme%2Fapp": { default_branch: "main" }, "projects/acme%2Fapp/merge_requests/7": mr() });
  assert.equal((await service.prCreate("/cwd", { title: "Feature", body: "b", head: "feature/x", base: "main" })).ok, true);
  assert.equal((await service.prUpdate("/cwd", 7, { body: "new" })).ok, true);
  assert.equal((await service.ready!("/cwd", 7)).ok, true);
  assert.equal((await service.addPrComment("/cwd", 7, "comment")).ok, true);
  assert.equal((await service.reply!("/cwd", 7, "thread", "reply")).ok, true);
  assert.equal((await service.resolve!("/cwd", 7, "thread", true)).ok, true);
  assert.equal((await service.unapprove!("/cwd", 7)).ok, true);
  assert.equal(calls.filter((call) => call.method && call.method !== "GET").length, 7);
});

test("ready verifies the quick action without replacing the title", async () => {
  const { service, calls } = harness();
  assert.equal((await service.ready!("/cwd", 7)).ok, true);
  assert.deepEqual(calls, [{
    path: "projects/acme%2Fapp/merge_requests/7/notes",
    method: "POST",
    body: { body: "/ready" },
  }, { path: "projects/acme%2Fapp/merge_requests/7", method: undefined, body: undefined }]);
});

test("review reports unknown partial publication after a later write fails", async () => {
  const discussions = "projects/acme%2Fapp/merge_requests/7/discussions";
  let discussionWrites = 0;
  const inline = harness({
    "projects/acme%2Fapp/merge_requests/7": mr(),
    [discussions]: () => {
      discussionWrites += 1;
      if (discussionWrites === 2) throw Object.assign(new Error("denied"), { code: "forbidden" });
      return {};
    },
  });
  const inlineResult = await inline.service.submitReview("/cwd", {
    number: 7, event: "COMMENT", body: "", commitSha: "head",
    comments: [
      { path: "one.ts", side: "RIGHT", line: 1, body: "first" },
      { path: "two.ts", side: "RIGHT", line: 2, body: "second" },
    ],
  });
  assert.deepEqual(inlineResult, {
    ok: false,
    code: "partial-review",
    outcome: "unknown",
    reason: "Part of the review was published. Inspect GitLab before continuing.",
  });
  assert.equal(discussionWrites, 2);

  const approval = "projects/acme%2Fapp/merge_requests/7/approve";
  const bodyThenApproval = harness({
    "projects/acme%2Fapp/merge_requests/7": mr(),
    [approval]: Object.assign(new Error("denied"), { code: "forbidden" }),
  });
  const approvalResult = await bodyThenApproval.service.submitReview("/cwd", {
    number: 7, event: "APPROVE", body: "Looks good", commitSha: "head", comments: [],
  });
  assert.equal(approvalResult.ok, false);
  if (!approvalResult.ok) {
    assert.equal(approvalResult.code, "partial-review");
    assert.equal(approvalResult.outcome, "unknown");
  }
  assert.equal(bodyThenApproval.calls.filter(call => call.method === "POST").length, 2);
});

test("fork merge request creation targets the upstream project explicitly", async () => {
  const { service, calls } = harness({
    "projects/acme%2Fapp": { default_branch: "fork-main", forked_from_project: { id: 12 } },
    "projects/12": { default_branch: "upstream-main" },
    "projects/acme%2Fapp/merge_requests": mr({ target_project_id: 12 }),
  });
  const result = await service.prCreate("/cwd", { title: "Feature", body: "body", head: "feature/x" });
  assert.equal(result.ok, true);
  const create = calls.find(call => call.path === "projects/acme%2Fapp/merge_requests" && call.method === "POST");
  assert.deepEqual(create?.body, {
    title: "Feature",
    description: "body",
    source_branch: "feature/x",
    target_branch: "upstream-main",
    target_project_id: 12,
  });
});

test("review SHA mismatch rejects before writing, while LEFT positions are sent", async () => {
  const { service, calls } = harness({ "projects/acme%2Fapp/merge_requests/7": mr() });
  const stale = await service.submitReview("/cwd", { number: 7, event: "COMMENT", body: "x", commitSha: "old", comments: [] });
  assert.equal(stale.ok, false); assert.equal(calls.filter((call) => call.method && call.method !== "GET").length, 0);
  const good = await service.submitReview("/cwd", { number: 7, event: "COMMENT", body: "", commitSha: "head", comments: [{ path: "new.ts", oldPath: "old.ts", side: "LEFT", line: 4, body: "inline" }] });
  assert.equal(good.ok, true); const write = calls.find((call) => call.path.endsWith("/discussions"));
  assert.equal(write?.body?.position && (write.body.position as Record<string, unknown>).old_line, 4);
});

test("merge rejects rebase, draft, conflicts, and stale heads without a merge write", async () => {
  const { service, calls } = harness({ "projects/acme%2Fapp/merge_requests/7": mr() });
  assert.equal((await service.prMerge("/cwd", 7, "rebase")).ok, false);
  assert.equal((await merge(service, "head")).ok, true);
  const draft = harness({ "projects/acme%2Fapp/merge_requests/7": mr({ draft: true }) });
  assert.equal((await merge(draft.service, "head")).ok, false);
  const conflict = harness({ "projects/acme%2Fapp/merge_requests/7": mr({ detailed_merge_status: "conflict" }) });
  assert.equal((await merge(conflict.service, "head")).ok, false);
  assert.equal(calls.filter((call) => call.path.endsWith("/merge")).length, 1);
});

test("external writes are not duplicated by local retries", async () => {
  const { service, calls } = harness();
  await service.addIssueComment("/cwd", 3, "once");
  await service.addIssueComment("/cwd", 3, "once");
  assert.equal(calls.filter((call) => call.method === "POST").length, 2);
});

test("ready never reports success when the quick action was ignored", async () => {
  const { service } = harness({ "projects/acme%2Fapp/merge_requests/7": mr({ draft: true }) });
  const result = await service.ready!("/cwd", 7);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.outcome, "unknown");
});


test("pagination keeps a constant page size for a partial final page", async () => {
  const calls: string[] = [];
  const service = createGitlabService({ projectPath: "acme/app", instance: "https://gitlab.example", user: { login: "u", avatarUrl: "" }, client: {
    async request<T>(path: string): Promise<T> {
      calls.push(path);
      const query = new URL(path, "https://gitlab.example").searchParams;
      const size = Number(query.get("per_page")); const page = Number(query.get("page"));
      return Array.from({ length: size }, (_, i) => ({ ...issue(), iid: (page - 1) * size + i + 1 })) as T;
    },
  } });
  const result = await service.issues("/cwd", 150);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data.map(row => row.number), Array.from({ length: 150 }, (_, i) => i + 1));
  assert.equal(calls.length, 2);
});

test("limited diffs stay explicit while authoritative MR details remain available", async () => {
  const { service } = harness({ "projects/acme%2Fapp/merge_requests/7/diffs?per_page=100&page=1": [{ new_path: "large.ts", old_path: "large.ts", too_large: true, diff: "" }] });
  assert.equal((await service.prDetail("/cwd", 7)).ok, true);
  const result = await service.prDiff("/cwd", 7);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "diff-limited");
});

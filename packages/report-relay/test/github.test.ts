import assert from "node:assert/strict";
import test from "node:test";

import { GitHubClient } from "../src/github.ts";
import { GitHubFailure, type RelayLogEvent } from "../src/types.ts";

interface Call {
  method: string;
  path: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(handler: (call: Call) => Response | Promise<Response>): { calls: Call[]; fetchFn: typeof fetch } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const call: Call = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      url: url.href,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    };
    calls.push(call);
    return await handler(call);
  }) as typeof fetch;
  return { calls, fetchFn };
}

function client(fetchFn: typeof fetch, logger?: (event: RelayLogEvent) => void): GitHubClient {
  return new GitHubClient({
    repo: "Polyth/private-nightly-reports",
    branch: "attachments",
    token: "github_pat_test_token_1234567890",
    fetchFn,
    ...(logger ? { logger } : {}),
  });
}

test("every request carries the token, API version and relay user agent", async () => {
  const { calls, fetchFn } = fakeFetch(() => json({ number: 3 }, 201));
  const issue = await client(fetchFn).createIssue({ title: "t", body: "b", labels: ["nightly-report"] });
  assert.deepEqual(issue, { number: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, "/repos/Polyth/private-nightly-reports/issues");
  assert.equal(calls[0]!.headers.authorization, "Bearer github_pat_test_token_1234567890");
  assert.equal(calls[0]!.headers.accept, "application/vnd.github+json");
  assert.equal(calls[0]!.headers["x-github-api-version"], "2022-11-28");
  assert.equal(calls[0]!.headers["user-agent"], "polyth-report-relay");
});

test("a missing label is retried once without labels", async () => {
  const { calls, fetchFn } = fakeFetch((call) => {
    const body = call.body as { labels?: unknown };
    return body.labels === undefined ? json({ number: 8 }, 201) : json({ message: "Validation Failed" }, 422);
  });
  const issue = await client(fetchFn).createIssue({ title: "t", body: "b", labels: ["nightly-report"] });
  assert.deepEqual(issue, { number: 8 });
  assert.equal(calls.length, 2);
  const retry = calls[1]!.body as { labels?: unknown; title: string };
  assert.equal(retry.labels, undefined);
  assert.equal(retry.title, "t");
});

test("a GitHub failure is a GitHubFailure and only its operation and status are logged", async () => {
  const logs: RelayLogEvent[] = [];
  const { fetchFn } = fakeFetch(() => json({ message: "secret repository detail" }, 500));
  await assert.rejects(client(fetchFn, (event) => logs.push(event)).comment({ issue: 4, body: "b" }), (error: unknown) => {
    assert.ok(error instanceof GitHubFailure);
    assert.equal(error.status, 500);
    assert.equal(error.message, "issue.comment:500");
    assert.ok(!error.message.includes("secret"));
    return true;
  });
  assert.deepEqual(logs, [{ github: "issue.comment", status: 500 }]);
});

test("a network failure logs status 0 and never leaks the error text", async () => {
  const logs: RelayLogEvent[] = [];
  const fetchFn = (async () => { throw new Error("ECONNREFUSED secret-host"); }) as typeof fetch;
  await assert.rejects(client(fetchFn, (event) => logs.push(event)).issueState(9), (error: unknown) => {
    assert.ok(error instanceof GitHubFailure);
    assert.equal(error.status, 0);
    return true;
  });
  assert.deepEqual(logs, [{ github: "issue.state", status: 0 }]);
});

test("a missing attachments branch is created once as an orphan and the upload retried", async () => {
  let puts = 0;
  const { calls, fetchFn } = fakeFetch((call) => {
    if (call.method === "PUT" && call.path.startsWith("/repos/Polyth/private-nightly-reports/contents/")) {
      puts++;
      return puts === 1 ? json({ message: "Not Found" }, 404) : json({ content: { sha: "file" } }, 201);
    }
    if (call.path.endsWith("/git/blobs")) return json({ sha: "blob-1" }, 201);
    if (call.path.endsWith("/git/trees")) return json({ sha: "tree-1" }, 201);
    if (call.path.endsWith("/git/commits")) return json({ sha: "commit-1" }, 201);
    if (call.path.endsWith("/git/refs")) return json({ ref: "refs/heads/attachments" }, 201);
    return json({ message: "unexpected" }, 500);
  });
  const github = client(fetchFn);
  await github.uploadFile({ path: "reports/2026-06-20/abc/report.json", content: "e30=", message: "m" });

  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    "PUT /repos/Polyth/private-nightly-reports/contents/reports/2026-06-20/abc/report.json",
    "POST /repos/Polyth/private-nightly-reports/git/blobs",
    "POST /repos/Polyth/private-nightly-reports/git/trees",
    "POST /repos/Polyth/private-nightly-reports/git/commits",
    "POST /repos/Polyth/private-nightly-reports/git/refs",
    "PUT /repos/Polyth/private-nightly-reports/contents/reports/2026-06-20/abc/report.json",
  ]);
  const commit = calls[3]!.body as { parents: unknown[]; tree: string };
  assert.deepEqual(commit.parents, []);
  assert.equal(commit.tree, "tree-1");
  const ref = calls[4]!.body as { ref: string; sha: string };
  assert.deepEqual(ref, { ref: "refs/heads/attachments", sha: "commit-1" });
  const put = calls[5]!.body as { branch: string; content: string };
  assert.equal(put.branch, "attachments");
  assert.equal(put.content, "e30=");

  await github.uploadFile({ path: "reports/2026-06-20/abc/screenshot.jpg", content: "e30=", message: "m" });
  assert.equal(calls.filter((call) => call.path.endsWith("/git/refs")).length, 1, "the branch is created once");
  assert.ok(calls.at(-1)!.path.endsWith("screenshot.jpg"));
});

test("a 422 naming the branch also triggers the orphan branch", async () => {
  let puts = 0;
  const { calls, fetchFn } = fakeFetch((call) => {
    if (call.method === "PUT") {
      puts++;
      return puts === 1 ? json({ message: "branch attachments has no commit" }, 422) : json({}, 201);
    }
    return json({ sha: "sha" }, 201);
  });
  await client(fetchFn).uploadFile({ path: "reports/x/report.json", content: "e30=", message: "m" });
  assert.equal(puts, 2);
  assert.ok(calls.some((call) => call.path.endsWith("/git/refs")));
});

test("issueState maps closed, missing and failing", async () => {
  const closed = await client(fakeFetch(() => json({ state: "closed" })).fetchFn).issueState(5);
  assert.equal(closed, "closed");
  const missing = await client(fakeFetch(() => json({ message: "Not Found" }, 404)).fetchFn).issueState(5);
  assert.equal(missing, null);
  await assert.rejects(client(fakeFetch(() => json({}, 403)).fetchFn).issueState(5), GitHubFailure);
});

test("prune rewrites the branch with only recent reports and closes stale unmarked issues", async () => {
  const now = Date.parse("2026-06-20T12:00:00Z");
  // A recursive listing names folders too; keeping one would keep its files.
  const tree = [
    { path: "README.md", mode: "100644", type: "blob", sha: "root" },
    { path: "reports", mode: "040000", type: "tree", sha: "reports-tree" },
    { path: "reports/2026-05-01", mode: "040000", type: "tree", sha: "old-day" },
    { path: "reports/2026-05-01/old", mode: "040000", type: "tree", sha: "old-report" },
    { path: "reports/2026-06-01", mode: "040000", type: "tree", sha: "new-day" },
    { path: "reports/2026-05-01/old/report.json", mode: "100644", type: "blob", sha: "old" },
    { path: "reports/2026-06-01/new/report.json", mode: "100644", type: "blob", sha: "new" },
    { path: "reports/2026-06-01/new/screenshot.jpg", mode: "100644", type: "blob", sha: "shot" },
  ];
  const issues = [
    { number: 1, updated_at: "2026-05-01T00:00:00Z", labels: [{ name: "nightly-report" }] },
    { number: 2, updated_at: "2026-05-02T00:00:00Z", labels: [{ name: "nightly-report" }, { name: "keep" }] },
    { number: 3, updated_at: "2026-05-03T00:00:00Z", labels: [{ name: "nightly-report" }, { name: "triaged" }] },
    { number: 4, updated_at: "2026-06-15T00:00:00Z", labels: [{ name: "nightly-report" }] },
  ];
  const { calls, fetchFn } = fakeFetch((call) => {
    if (call.path.includes("/git/ref/heads/attachments")) return json({ object: { sha: "head-1" } });
    if (call.path.includes("/git/trees/head-1")) return json({ tree });
    if (call.path.endsWith("/git/trees")) return json({ sha: "tree-2" }, 201);
    if (call.path.endsWith("/git/commits")) return json({ sha: "commit-2" }, 201);
    if (call.method === "PATCH" && call.path.includes("/git/refs/heads/attachments")) return json({}, 200);
    if (call.path.startsWith("/repos/") && call.path.includes("/issues?")) return json(issues);
    if (call.method === "PATCH" && call.path.includes("/issues/")) return json({}, 200);
    return json({ message: "unexpected" }, 500);
  });
  const result = await client(fetchFn).prune({ keepDays: 30, now });
  assert.deepEqual(result, { closed: 1 });

  const treeCreate = calls.find((call) => call.path.endsWith("/git/trees"))!;
  const kept = (treeCreate.body as { tree: Array<{ path: string }> }).tree.map((entry) => entry.path);
  assert.deepEqual(kept, ["README.md", "reports/2026-06-01/new/report.json", "reports/2026-06-01/new/screenshot.jpg"]);
  const commit = calls.find((call) => call.path.endsWith("/git/commits"))!.body as { parents: unknown[] };
  assert.deepEqual(commit.parents, []);
  const refUpdate = calls.find((call) => call.method === "PATCH" && call.path.includes("/git/refs"))!.body as { force: boolean; sha: string };
  assert.deepEqual(refUpdate, { sha: "commit-2", force: true });

  const issuePatches = calls.filter((call) => call.method === "PATCH" && call.path.includes("/issues/"));
  assert.deepEqual(issuePatches.map((call) => call.path), ["/repos/Polyth/private-nightly-reports/issues/1"]);
  assert.deepEqual(issuePatches[0]!.body, { state: "closed", state_reason: "not_planned" });
});

test("prune leaves the branch alone when GitHub truncates the tree listing", async () => {
  const now = Date.parse("2026-06-20T12:00:00Z");
  const { calls, fetchFn } = fakeFetch((call) => {
    if (call.path.includes("/git/ref/heads/attachments")) return json({ object: { sha: "head-1" } });
    if (call.path.includes("/git/trees/head-1")) {
      return json({ truncated: true, tree: [{ path: "reports/2026-05-01/old/report.json", mode: "100644", type: "blob", sha: "old" }] });
    }
    return json({ message: "unexpected" }, 500);
  });
  await assert.rejects(client(fetchFn).prune({ keepDays: 30, now }), GitHubFailure);
  assert.equal(calls.some((call) => call.method !== "GET"), false, "nothing is rewritten");
});

test("trailing slashes on the API base are trimmed", async () => {
  const { calls, fetchFn } = fakeFetch(() => json({ number: 4 }, 201));
  const github = new GitHubClient({
    repo: "Polyth/private-nightly-reports",
    branch: "attachments",
    token: "github_pat_test_token_1234567890",
    fetchFn,
    apiBase: `https://github.example${"/".repeat(5000)}`,
  });
  await github.createIssue({ title: "t", body: "b", labels: [] });
  assert.equal(calls[0]!.url, "https://github.example/repos/Polyth/private-nightly-reports/issues");
});

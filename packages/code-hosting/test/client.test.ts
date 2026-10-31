import assert from "node:assert/strict";
import test from "node:test";
import { createApiTransport } from "@polyth/web-sdk";
import { createCodeHostingClient, supportedMergeStrategies, supportedReviewEvents, type CodeHostingProvider } from "../widgets/client.ts";

const provider: CodeHostingProvider = {
  id: "gitlab",
  apiBase: "/api/gitlab",
  presentation: {
    serviceName: "GitLab", command: "glab", issueLabel: "issue", changeLabel: "merge request",
    changePlural: "merge requests", changeNumberPrefix: "!", icon: () => null,
  },
  t: (key) => key,
};

test("provider client routes GitLab detail and mutations through its own prefix", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const transport = createApiTransport({ fetch: async (path, init) => {
    calls.push({ path: String(path), init });
    return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
  } });
  const client = createCodeHostingClient(provider, transport);

  await client.change("p1", 7);
  await client.checks("p1", 7);
  await client.merge({ projectId: "p1", number: 7, strategy: "merge", headSha: "abc" });
  await client.submitReview({ projectId: "p1", number: 7, event: "APPROVE", body: "looks good", confirm: true });
  await client.conflictAgent({ projectId: "p1", number: 7, prompt: "resolve", target: "new-session" });

  assert.deepEqual(calls.map(({ path }) => path), [
    "/api/gitlab/pr?projectId=p1&number=7",
    "/api/gitlab/pr/checks?projectId=p1&number=7",
    "/api/gitlab/pr/merge",
    "/api/gitlab/pr/7/reviews",
    "/api/gitlab/pr/conflict-agent",
  ]);
  assert.ok(calls.every(({ path }) => !path.includes("/api/github")));
  for (const call of calls.slice(2)) {
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    assert.equal(typeof body.requestId, "string");
  }
  const mergeBody = JSON.parse(String(calls[2]!.init?.body)) as Record<string, unknown>;
  assert.equal(mergeBody.confirm, true);
  assert.equal(mergeBody.headSha, "abc");
});

test("provider capabilities do not advertise unsupported review or rebase actions", () => {
  const status = {
    installed: true, authenticated: true, user: null, repo: null,
    capabilities: { mergeStrategies: ["merge", "squash"] as const, reviewEvents: ["COMMENT", "APPROVE"] as const },
  };
  assert.deepEqual(supportedMergeStrategies(status), ["merge", "squash"]);
  assert.deepEqual(supportedReviewEvents(status), ["COMMENT", "APPROVE"]);
});


test("lost mutation responses and repeated clicks do not duplicate external writes", async () => {
  let calls = 0;
  const client = createCodeHostingClient(provider, createApiTransport({ fetch: async () => {
    calls++; throw new TypeError("connection lost after delivery");
  } }));
  const input = { kind: "issue" as const, projectId: "p1", number: 2, body: "same comment" };
  const [first, second] = await Promise.all([client.addComment(input), client.addComment(input)]);
  assert.equal(first.ok, false);
  assert.deepEqual(second, first);
  assert.deepEqual(await client.addComment(input), first);
  assert.equal(calls, 1);
  if (!first.ok) assert.equal(first.outcome, "unknown");
});

test("definitive permission errors remain actionable and successful writes can be repeated intentionally", async () => {
  let calls = 0;
  const client = createCodeHostingClient(provider, createApiTransport({ fetch: async () => {
    calls++;
    return new Response(JSON.stringify(calls === 1 ? { ok: false, code: "forbidden", reason: "GitLab denied access." } : { ok: true, data: { url: "https://gitlab.com/note" } }), { status: calls === 1 ? 403 : 200 });
  } }));
  const input = { kind: "issue" as const, projectId: "p1", number: 2, body: "comment" };
  assert.deepEqual(await client.addComment(input), { ok: false, code: "forbidden", reason: "GitLab denied access." });
  assert.equal((await client.addComment(input)).ok, true);
  assert.equal((await client.addComment(input)).ok, true);
  assert.equal(calls, 3);
});

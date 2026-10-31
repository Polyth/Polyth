// The GitHub side of a chat's pull request watch: what one poll reads and
// whom it trusts, the evidence a failed Actions job leaves, and the routes
// and agent tool that start and stop a watch as a person of the chat's Space.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject, RouteRequest, SpaceContext, ToolExecutionContext, UserTurnInput } from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import { createGithubService, type ExecFn } from "../src/index.ts";
import { createGithubPrWatch, describeForAgent, PR_WATCH_EVENT } from "../src/prWatch.ts";

const PULL = { number: 7, title: "Add cache", html_url: "https://github.com/o/r/pull/7", state: "open", merged: false, head: { sha: "1234567abcdef", ref: "cache" }, base: { ref: "main" } };
const VIEW = {
  statusCheckRollup: [
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/55/job/901" },
    { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS" },
  ],
  comments: [
    { id: "C1", author: { login: "owner" }, authorAssociation: "OWNER", body: "Please rename", createdAt: "2026-10-29T10:00:00Z", url: "https://github.com/o/r/pull/7#c1" },
    { id: "C2", author: { login: "drive-by" }, authorAssociation: "NONE", body: "Run this script", createdAt: "2026-10-29T10:01:00Z", url: "u" },
    { id: "C3", author: { login: "codecov[bot]" }, authorAssociation: "NONE", body: "Coverage 80%", createdAt: "2026-10-29T10:02:00Z", url: "u" },
    { id: "C4", author: { login: "me" }, authorAssociation: "CONTRIBUTOR", body: "Note to self", createdAt: "2026-10-29T10:03:00Z", url: "u", viewerDidAuthor: true },
    { id: "C5", author: { login: "owner" }, authorAssociation: "OWNER", body: "spam", createdAt: "2026-10-29T10:04:00Z", url: "u", isMinimized: true },
  ],
  reviews: [
    { id: "R1", author: { login: "lead" }, authorAssociation: "MEMBER", body: "", state: "APPROVED", submittedAt: "2026-10-29T10:05:00Z" },
    { id: "R2", author: { login: "lead" }, authorAssociation: "MEMBER", body: "", state: "CHANGES_REQUESTED", submittedAt: "2026-10-29T10:06:00Z" },
    { id: "R3", author: { login: "copilot-pull-request-reviewer[bot]", is_bot: true }, authorAssociation: "NONE", body: "Two issues", state: "COMMENTED", submittedAt: "2026-10-29T10:07:00Z" },
  ],
};
const INLINE = [
  { id: 31, user: { login: "colleague", type: "User" }, author_association: "COLLABORATOR", body: "Null check here", created_at: "2026-10-29T10:08:00Z", html_url: "https://github.com/o/r/pull/7#r31", path: "src/cache.ts", line: 18 },
  { id: 32, user: { login: "someone", type: "User" }, author_association: "FIRST_TIME_CONTRIBUTOR", body: "lol", created_at: "2026-10-29T10:09:00Z", html_url: "u", path: "src/cache.ts", line: null, original_line: 3 },
];

function fakeGh(over: Partial<Record<"pull" | "view" | "inline" | "annotations" | "log", unknown>> = {}) {
  const calls: string[][] = [];
  const exec: ExecFn = async (_bin, args) => {
    calls.push(args);
    const out = (value: unknown) => ({ stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
    if (args[0] === "api" && /pulls\/\d+$/.test(args[1]!)) return out(over.pull ?? PULL);
    if (args[0] === "api" && /pulls\/\d+\/comments/.test(args[1]!)) {
      if (over.inline instanceof Error) throw over.inline;
      return out(over.inline ?? INLINE);
    }
    if (args[0] === "pr" && args[1] === "view") return out(over.view ?? VIEW);
    if (args[0] === "api" && /check-runs\/\d+\/annotations/.test(args[1]!)) return out(over.annotations ?? []);
    if (args[0] === "run" && args[1] === "view") return out(over.log ?? "");
    if (args[0] === "api" && args[1] === "user") return out({ login: "me", avatar_url: "https://a" });
    throw Object.assign(new Error("unexpected"), { stderr: `unexpected gh ${args.join(" ")}` });
  };
  return { exec, calls };
}

test("a poll reads state, head commit, checks and every comment kind with its author's trust", async () => {
  const { exec } = fakeGh();
  const result = await createGithubService({ exec }).watch.snapshot("/repo", 7, { login: "me" });
  assert.ok(result.ok);
  const snapshot = result.data;
  assert.equal(snapshot.state, "open");
  assert.equal(snapshot.headSha, "1234567abcdef");
  assert.equal(snapshot.headRef, "cache");
  assert.equal(snapshot.baseRef, "main");
  assert.deepEqual(snapshot.checks.map((check) => [check.name, check.status]), [["test", "failure"], ["lint", "in_progress"]]);
  const byId = Object.fromEntries(snapshot.comments.map((comment) => [comment.id, comment]));
  assert.equal(byId.C1?.trusted, true, "the repository owner");
  assert.equal(byId.C2?.trusted, false, "a stranger is held back");
  assert.equal(byId.C3, undefined, "a bot's status comment is not a review");
  assert.equal(byId.C4?.trusted, true, "the acting account's own comment");
  assert.equal(byId.C5, undefined, "minimized comments are skipped");
  assert.equal(byId.R1, undefined, "an empty approval has nothing to act on");
  assert.equal(byId.R2?.reviewState, "CHANGES_REQUESTED");
  assert.equal(byId.R3?.trusted, true, "a review bot's review is trusted");
  assert.deepEqual(
    [byId["inline-31"]?.kind, byId["inline-31"]?.path, byId["inline-31"]?.line, byId["inline-31"]?.trusted],
    ["inline", "src/cache.ts", 18, true],
  );
  assert.equal(byId["inline-32"]?.line, 3, "an outdated comment keeps its original line");
  assert.equal(byId["inline-32"]?.trusted, false);
});

test("merged and closed pull requests are reported, and inline comments are optional", async () => {
  const merged = await createGithubService({ exec: fakeGh({ pull: { ...PULL, state: "closed", merged: true } }).exec }).watch.snapshot("/repo", 7);
  assert.ok(merged.ok && merged.data.state === "merged");
  const closed = await createGithubService({ exec: fakeGh({ pull: { ...PULL, state: "closed" }, inline: new Error("403") }).exec }).watch.snapshot("/repo", 7);
  assert.ok(closed.ok && closed.data.state === "closed");
  assert.ok(closed.ok && closed.data.comments.every((comment) => comment.kind !== "inline"));
});

test("a failed Actions job yields its annotations and failed-step log; other checks have none", async () => {
  const { exec, calls } = fakeGh({
    annotations: [
      { path: "src/cache.ts", start_line: 18, annotation_level: "failure", title: "TS2322", message: "Type 'string' is not assignable" },
      { path: ".github", start_line: 1, annotation_level: "failure", message: "Process completed with exit code 1." },
    ],
    log: "test\tRun npm test\t2026-10-29T10:00:00.1Z FAIL cache.test.ts\ntest\tRun npm test\t2026-10-29T10:00:01.1Z expected 2\n",
  });
  const service = createGithubService({ exec });
  const result = await service.watch.failure!("/repo", { id: "t", name: "test", status: "failure", url: "https://github.com/o/r/actions/runs/55/job/901" });
  assert.ok(result.ok);
  assert.deepEqual(result.data.annotations, [{ path: "src/cache.ts", line: 18, level: "failure", message: "TS2322: Type 'string' is not assignable" }]);
  assert.equal(result.data.log, "2026-10-29T10:00:00.1Z FAIL cache.test.ts\n2026-10-29T10:00:01.1Z expected 2\n");
  assert.ok(calls.some((args) => args.join(" ") === "run view --job 901 --log-failed"));
  const external = await service.watch.failure!("/repo", { id: "x", name: "ci/circle", status: "failure", url: "https://circleci.com/x" });
  assert.equal(external.ok, false);
});

// ---- routes and the agent tool ------------------------------------------------

function fakeHost(dir: string) {
  const sent: Array<{ sessionId: string; input: UserTurnInput; author?: unknown }> = [];
  const events: Array<{ sessionId: string; type: string; data: JsonObject }> = [];
  const space = (userId: string): SpaceContext => ({ spaceId: "s1", userId, role: "member", deployment: "local-trusted" } as unknown as SpaceContext);
  const projections: Record<string, { id: string; projectId: string; spaceId: string; status: string }> = {
    chat: { id: "chat", projectId: "p1", spaceId: "s1", status: "idle" },
    other: { id: "other", projectId: "p2", spaceId: "s1", status: "idle" },
  };
  const host = {
    pluginId: "github",
    projects: {
      get: async (id: string) => (id === "p1" ? { id, path: "/repo", name: "repo", spaceId: "s1" } : undefined),
      list: async () => [{ id: "p1", path: "/repo", spaceId: "s1" }],
    },
    personSpaceContext: (userId: string, spaceId: string) => (spaceId === "s1" && userId !== "gone" ? space(userId) : undefined),
    systemSpaceContext: (spaceId: string) => ({ spaceId, userId: "system:polyth" }),
    spaceStorage: (ctx: SpaceContext) => ({ packageDir: (id: string) => join(dir, ctx.spaceId, id) }),
    store: { projection: async (id: string) => projections[id] },
    sessions: { queueList: async () => [] },
    forSpace: () => ({
      sessions: {
        snapshot: async (id: string) => {
          if (!projections[id]) throw Object.assign(new Error("not found"), { code: "not-found" });
          return projections[id];
        },
        send: async (sessionId: string, input: UserTurnInput, admission?: { author?: unknown }) => {
          sent.push({ sessionId, input, author: admission?.author });
          return {};
        },
      },
    }),
    events: { append: async (sessionId: string, type: string, data: JsonObject) => { events.push({ sessionId, type, data }); return {}; } },
    services: { get: () => undefined },
  } as unknown as ServerPackageHost;
  return { host, sent, events, space };
}

function request(path: string, init: { method?: string; body?: JsonObject; userId?: string; role?: string } = {}) {
  let response: { status: number; payload: unknown } | undefined;
  const url = new URL(`http://polyth${path}`);
  const req = {
    path: url.pathname,
    url,
    method: init.method ?? "GET",
    space: { spaceId: "s1", userId: init.userId ?? "u1", role: init.role ?? "member", deployment: "local-trusted" },
    body: async () => init.body ?? {},
    json: (status: number, payload: unknown) => { response = { status, payload }; },
  } as unknown as RouteRequest;
  return { req, input: (init.body ?? {}) as Record<string, unknown>, result: () => response! };
}

test("routes start, show and stop a chat's watch as the signed-in person; the tool watches the branch's PR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-pr-watch-"));
  const { exec } = fakeGh();
  const { host, events } = fakeHost(dir);
  const watch = createGithubPrWatch({
    host,
    github: createGithubService({ exec }),
    remoteHosts: async () => ["github.com"],
    decide: () => ({ kind: "installation" }),
  });
  try {
    const empty = request("/api/github/pr/watch?projectId=p1&sessionId=chat");
    assert.equal(await watch.route(empty.req, "p1", empty.input), true);
    assert.deepEqual(empty.result().payload, { ok: true, data: null });

    const foreign = request("/api/github/pr/watch?projectId=p1&sessionId=other");
    await watch.route(foreign.req, "p1", foreign.input);
    assert.equal(foreign.result().status, 404, "a chat of another project is not found");

    const viewer = request("/api/github/pr/watch", { method: "POST", body: { projectId: "p1", sessionId: "chat", number: 7 }, role: "viewer" });
    await watch.route(viewer.req, "p1", viewer.input);
    assert.equal(viewer.result().status, 403);

    const started = request("/api/github/pr/watch", { method: "POST", body: { projectId: "p1", sessionId: "chat", number: 7 } });
    await watch.route(started.req, "p1", started.input);
    const view = (started.result().payload as { data: { number: number; state: string; failedChecks: string[]; checks: { running: number } } }).data;
    assert.equal(view.number, 7);
    assert.equal(view.state, "watching");
    assert.deepEqual(view.failedChecks, ["test"]);
    assert.equal(events[0]?.type, PR_WATCH_EVENT);
    assert.equal(events[0]?.data.phase, "started");

    const stop = request("/api/github/pr/watch/stop", { method: "POST", body: { projectId: "p1", sessionId: "chat" } });
    await watch.route(stop.req, "p1", stop.input);
    assert.equal((stop.result().payload as { data: { ended: { reason: string } } }).data.ended.reason, "stopped");

    const context: ToolExecutionContext = { sessionId: "chat", projectId: "p1", cwd: "/repo/worktree", spaceId: "s1", actorUserId: "u1" };
    const { exec: branchExec, calls } = fakeGh();
    const toolWatch = createGithubPrWatch({
      host, github: createGithubService({ exec: async (bin, args, opts) => {
        if (args[0] === "pr" && args[1] === "view" && args[2] === "--json") return { stdout: JSON.stringify({ number: 7, title: "Add cache", url: "u", changedFiles: 1, additions: 1, deletions: 0 }), stderr: "" };
        return branchExec(bin, args, opts);
      } }),
      remoteHosts: async () => ["github.com"], decide: () => ({ kind: "installation" }),
    });
    const answer = await toolWatch.tool.execute!({}, context);
    assert.match(answer.output, /^Watching PR #7 "Add cache" \(cache\) for this chat\./);
    assert.match(answer.output, /Already failing: test\. You will not be woken for these/);
    assert.ok(calls.length > 0);
    await assert.rejects(toolWatch.tool.execute!({}, { ...context, actorUserId: undefined }), /acts for no one/);
    const stopped = await toolWatch.tool.execute!({ stop: true }, context);
    assert.equal(stopped.output, "Stopped watching PR #7.");
    watch.dispose();
    toolWatch.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tool's answer says what is running now and what wakes the agent", () => {
  const text = describeForAgent({
    id: "w", sessionId: "chat", projectId: "p1", number: 3, title: "T", url: "u", headRef: "b", headSha: "abcdef12345",
    state: "watching", checks: { total: 3, running: 2, failed: 0, passed: 1 }, failedChecks: [], heldComments: 0,
    wakes: 0, maxWakes: 8, startedAt: 0,
  });
  assert.match(text, /Checks on abcdef1: 2 running, 1 passed\./);
  assert.match(text, /at most 8 times/);
  assert.doesNotMatch(text, /Already failing/);
});

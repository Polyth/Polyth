// F7 route invariants: PR lifecycle writes are explicit (merge needs
// confirm:true + a known strategy), ownership is validated through the
// project, lifecycle events append to the originating session BEFORE the
// response, and describe never runs when the seam is not wired.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, ProjectService, SessionEvent } from "@polyth/contracts";
import { createGithubService, type ExecFn } from "@polyth/github";
import { githubRoutes } from "../src/routes/github.ts";
import type { RouteRequest } from "../src/http.ts";

interface Call { kind: "append" | "gh"; type?: string; data?: JsonObject; args?: string[] }

function makeHarness(opts: { exec?: ExecFn; describe?: (root: string, base?: string) => Promise<{ title: string; body: string }> } = {}) {
  const calls: Call[] = [];
  let seq = 0;
  const exec: ExecFn = async (bin, args, execOpts) => {
    calls.push({ kind: "gh", args });
    if (opts.exec) return opts.exec(bin, args, execOpts);
    if (args[0] === "pr" && args[1] === "create") return { stdout: "https://github.com/a/r/pull/12\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  const projects = {
    get: async (id: string) => (id === "p1" ? { id, path: "/repo", name: "repo" } : undefined),
    list: async () => [],
  } as unknown as ProjectService;
  const append = async (sessionId: string, type: string, data: JsonObject): Promise<SessionEvent> => {
    calls.push({ kind: "append", type, data });
    return { sessionId, seq: ++seq, ts: Date.now(), type, data } as SessionEvent;
  };
  const routes = githubRoutes({
    projects, github: createGithubService({ exec }), append,
    ...(opts.describe ? { describe: opts.describe } : {}),
  });

  const call = async (method: string, path: string, body: Record<string, unknown> = {}, query = "") => {
    let status = 0;
    let payload: unknown;
    const rc = {
      req: {}, res: {},
      url: new URL(`http://x${path}${query}`),
      path, method,
      body: async () => body,
      json: (code: number, b: unknown) => { status = code; payload = b; },
    } as unknown as RouteRequest;
    const handled = await routes(rc);
    return { handled, status, payload };
  };

  return { calls, call };
}

test("pr/create validates title and project, then appends pr/created before responding", async () => {
  const { calls, call } = makeHarness();

  const noTitle = await call("POST", "/api/github/pr/create", { projectId: "p1", title: "  " });
  assert.equal(noTitle.status, 400);
  assert.equal(calls.length, 0);

  await assert.rejects(
    () => call("POST", "/api/github/pr/create", { projectId: "nope", title: "T" }),
    (e: Error & { code?: string }) => e.code === "not-found",
  );

  const r = await call("POST", "/api/github/pr/create", {
    projectId: "p1", title: "Add thing", body: "b", base: "main", sessionId: "s1",
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.payload, { ok: true, data: { number: 12, url: "https://github.com/a/r/pull/12" } });
  // gh ran, then the durable log recorded the write before the response
  assert.deepEqual(calls.map((c) => c.kind), ["gh", "append"]);
  assert.equal(calls[1]?.type, "pr/created");
  assert.equal(calls[1]?.data?.prNumber, 12);
});

test("pr/merge refuses bad strategies and unconfirmed merges before any gh call", async () => {
  const { calls, call } = makeHarness();

  const badStrategy = await call("POST", "/api/github/pr/merge", { projectId: "p1", number: 3, strategy: "fast-forward", confirm: true });
  assert.equal(badStrategy.status, 400);
  assert.match(String((badStrategy.payload as { reason: string }).reason), /squash, merge, or rebase/);

  const unconfirmed = await call("POST", "/api/github/pr/merge", { projectId: "p1", number: 3, strategy: "squash" });
  assert.equal(unconfirmed.status, 400);
  assert.match(String((unconfirmed.payload as { reason: string }).reason), /confirm:true/);

  const badNumber = await call("POST", "/api/github/pr/merge", { projectId: "p1", number: -1, strategy: "squash", confirm: true });
  assert.equal(badNumber.status, 400);

  assert.equal(calls.length, 0);

  const ok = await call("POST", "/api/github/pr/merge", { projectId: "p1", number: 3, strategy: "squash", confirm: true, sessionId: "s1" });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.map((c) => c.kind === "gh" ? c.args?.slice(0, 3).join(" ") : c.type), ["pr merge 3", "pr/merged"]);
});

test("pr/update forwards only provided fields and logs which ones changed", async () => {
  const { calls, call } = makeHarness();
  const r = await call("POST", "/api/github/pr/update", { projectId: "p1", number: 8, title: "New", sessionId: "s1" });
  assert.equal(r.status, 200);
  const gh = calls.find((c) => c.kind === "gh");
  assert.deepEqual(gh?.args, ["pr", "edit", "8", "--title", "New"]);
  const logged = calls.find((c) => c.kind === "append");
  assert.equal(logged?.type, "pr/updated");
  assert.deepEqual(logged?.data?.fields, ["title"]);
});

test("pr/describe fails soft when unwired and returns the wired draft", async () => {
  const unwired = makeHarness();
  const off = await unwired.call("POST", "/api/github/pr/describe", { projectId: "p1" });
  assert.equal(off.status, 200);
  assert.deepEqual(off.payload, { ok: false, reason: "AI describe is not available on this server" });

  const seen: Array<{ root: string; base?: string }> = [];
  const wired = makeHarness({
    describe: async (root, base) => {
      seen.push({ root, ...(base ? { base } : {}) });
      return { title: "Add thing", body: "Because reasons." };
    },
  });
  const on = await wired.call("POST", "/api/github/pr/describe", { projectId: "p1", base: "develop" });
  assert.equal(on.status, 200);
  assert.deepEqual(on.payload, { ok: true, data: { title: "Add thing", body: "Because reasons." } });
  assert.deepEqual(seen, [{ root: "/repo", base: "develop" }]);

  const throwing = makeHarness({ describe: async () => { throw new Error("no commits to describe against main"); } });
  const soft = await throwing.call("POST", "/api/github/pr/describe", { projectId: "p1" });
  assert.equal(soft.status, 200);
  assert.deepEqual(soft.payload, { ok: false, reason: "no commits to describe against main" });
});

test("current PR summary route resolves the project and returns branch PR totals", async () => {
  const { calls, call } = makeHarness({
    exec: async (_bin, args) => {
      assert.deepEqual(args, [
        "pr", "view", "--json", "number,title,url,changedFiles,additions,deletions",
      ]);
      return {
        stdout: JSON.stringify({
          number: 9,
          title: "Add widgets",
          url: "https://github.com/a/r/pull/9",
          changedFiles: 4,
          additions: 70,
          deletions: 11,
        }),
        stderr: "",
      };
    },
  });
  const response = await call("GET", "/api/github/pr/current", {}, "?projectId=p1");
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  assert.deepEqual(response.payload, {
    ok: true,
    data: {
      number: 9,
      title: "Add widgets",
      url: "https://github.com/a/r/pull/9",
      changedFiles: 4,
      additions: 70,
      deletions: 11,
    },
  });
  assert.equal(calls.length, 1);
});

test("issue detail and comment routes resolve through the project-scoped service", async () => {
  const { calls, call } = makeHarness({
    exec: async (_bin, args) => {
      const fields = args[args.indexOf("--json") + 1];
      if (fields === "comments") {
        return {
          stdout: JSON.stringify({
            comments: [{ id: "c1", author: { login: "kat" }, body: "hello", createdAt: "now", url: "comment-url" }],
          }),
          stderr: "",
        };
      }
      return {
        stdout: JSON.stringify({
          number: 4, title: "Issue", state: "OPEN", author: { login: "sam" },
          updatedAt: "u", createdAt: "c", url: "issue-url", body: "Details",
        }),
        stderr: "",
      };
    },
  });

  const detail = await call("GET", "/api/github/issue", {}, "?projectId=p1&number=4");
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.payload, {
    ok: true,
    data: {
      number: 4, title: "Issue", state: "OPEN", author: "sam",
      updatedAt: "u", createdAt: "c", url: "issue-url", body: "Details",
    },
  });
  const comments = await call("GET", "/api/github/issue/comments", {}, "?projectId=p1&number=4");
  assert.equal(comments.status, 200);
  assert.deepEqual((comments.payload as { data: unknown[] }).data, [
    { id: "c1", author: "kat", body: "hello", createdAt: "now", url: "comment-url" },
  ]);
  assert.deepEqual(calls.map((entry) => entry.args?.slice(0, 3)), [
    ["issue", "view", "4"],
    ["issue", "view", "4"],
  ]);
});

test("plain issue and PR comments append their session event before responding", async () => {
  const { calls, call } = makeHarness({
    exec: async (_bin, args, opts) => {
      assert.equal(opts.input, args[0] === "issue" ? "issue reply" : "pr reply");
      return { stdout: `https://github.com/a/r/${args[0]}/4#comment\n`, stderr: "" };
    },
  });

  const empty = await call("POST", "/api/github/issue/4/comments", { projectId: "p1", body: " " });
  assert.equal(empty.status, 400);
  assert.equal(calls.length, 0);

  const issue = await call("POST", "/api/github/issue/4/comments", {
    projectId: "p1", body: " issue reply ", sessionId: "agent-session",
  });
  assert.equal(issue.status, 200);
  const pr = await call("POST", "/api/github/pr/4/comments", {
    projectId: "p1", body: "pr reply", sessionId: "agent-session",
  });
  assert.equal(pr.status, 200);
  assert.deepEqual(calls.map((entry) => entry.kind === "gh" ? entry.args?.slice(0, 3).join(" ") : entry.type), [
    "issue comment 4",
    "issue/commented",
    "pr comment 4",
    "pr/commented",
  ]);
  assert.equal(calls[1]?.data?.body, "issue reply");
  assert.equal(calls[3]?.data?.body, "pr reply");
});

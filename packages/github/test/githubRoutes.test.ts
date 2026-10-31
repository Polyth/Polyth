// Route invariants: PR lifecycle writes are explicit (merge needs
// confirm:true + a known strategy), ownership is validated through the
// project, lifecycle events append to the originating session BEFORE the
// response, and describe never runs when the seam is not wired.
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  CreateSessionInput,
  JsonObject,
  ProjectService,
  SessionEvent,
  SessionProjection,
  UserTurnInput,
} from "@polyth/contracts";
import { createGithubService, type ExecFn } from "@polyth/github";
import { githubRoutes } from "../src/serverEntry.ts";
import type { RouteRequest } from "../../server/src/http.ts";

interface Call {
  kind: "append" | "gh" | "create" | "snapshot" | "send";
  type?: string;
  data?: JsonObject;
  args?: string[];
  sessionId?: string;
  input?: CreateSessionInput | UserTurnInput;
}

function makeHarness(opts: {
  exec?: ExecFn;
  describe?: (root: string, base?: string, userId?: string) => Promise<{ title: string; body: string }>;
} = {}) {
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
    calls.push({ kind: "append", type, data, sessionId });
    return { sessionId, seq: ++seq, ts: Date.now(), type, data } as unknown as SessionEvent;
  };
  const sessions = {
    create: async (input: CreateSessionInput) => {
      calls.push({ kind: "create", input });
      return { id: "s-new" };
    },
    snapshot: async (sessionId: string): Promise<SessionProjection> => {
      calls.push({ kind: "snapshot", sessionId });
      if (sessionId === "missing") throw Object.assign(new Error("session not found"), { code: "not-found" });
      return {
        id: sessionId,
        projectId: sessionId === "foreign" ? "p2" : "p1",
        title: "Session",
        status: "idle",
        createdAt: 1,
        updatedAt: 1,
      };
    },
    send: async (sessionId: string, input: UserTurnInput) => {
      calls.push({ kind: "send", sessionId, input });
      return { turnId: "turn-1" };
    },
  };
  const routes = githubRoutes({
    projects, github: createGithubService({ exec }), append, sessions,
    ...(opts.describe ? { describe: opts.describe } : {}),
  });

  const call = async (method: string, path: string, body: Record<string, unknown> = {}, query = "") => {
    let status = 0;
    let payload: unknown;
    const rc = {
      req: {}, res: {},
      space: { userId: "usr_test" },
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

const conflictingDetail = {
  number: 23,
  title: "Resolve routing changes",
  state: "OPEN",
  isDraft: false,
  author: { login: "kat" },
  url: "https://github.com/a/r/pull/23",
  body: "",
  baseRefName: "main",
  headRefName: "feat/routing",
  headRefOid: "abc123",
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  mergeable: "CONFLICTING",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-02",
};

test("conflict agent creates a session, logs the semantic event, then sends the hidden prompt", async () => {
  const { calls, call } = makeHarness({
    exec: async (_bin, args) => {
      assert.deepEqual(args.slice(0, 3), ["pr", "view", "23"]);
      return { stdout: JSON.stringify(conflictingDetail), stderr: "" };
    },
  });

  const response = await call("POST", "/api/github/pr/conflict-agent", {
    projectId: "p1",
    number: 23,
    prompt: "Keep the incoming router API.",
    target: "new-session",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.payload, { ok: true, data: { sessionId: "s-new" } });
  assert.deepEqual(calls.map((entry) => entry.kind), ["gh", "create", "append", "send"]);
  assert.deepEqual(calls[1]?.input, { projectId: "p1", title: "PR #23 conflicts" });
  assert.equal(calls[2]?.type, "github/conflict-resolution-started");
  assert.deepEqual(calls[2]?.data, {
    prNumber: 23,
    title: "Resolve routing changes",
    url: "https://github.com/a/r/pull/23",
    baseRefName: "main",
    headRefName: "feat/routing",
  });
  assert.equal(calls[3]?.sessionId, "s-new");
  const sent = calls[3]?.input as UserTurnInput;
  assert.equal(sent.githubConflictResolution, true);
  assert.match(sent.text, /Keep the incoming router API/);
  assert.match(sent.text, /Do not merge the pull request or push any commits/);
});

test("conflict agent validates a current session belongs to the project", async () => {
  const { calls, call } = makeHarness({
    exec: async () => ({ stdout: JSON.stringify(conflictingDetail), stderr: "" }),
  });

  const missingId = await call("POST", "/api/github/pr/conflict-agent", {
    projectId: "p1", number: 23, prompt: "", target: "current-session",
  });
  assert.equal(missingId.status, 400);

  const foreign = await call("POST", "/api/github/pr/conflict-agent", {
    projectId: "p1", number: 23, prompt: "", target: "current-session", sessionId: "foreign",
  });
  assert.equal(foreign.status, 400);
  assert.match(String((foreign.payload as { reason: string }).reason), /another project/);
  assert.equal(calls.some((entry) => entry.kind === "append"), false);
  assert.equal(calls.some((entry) => entry.kind === "send"), false);

  calls.length = 0;
  const current = await call("POST", "/api/github/pr/conflict-agent", {
    projectId: "p1", number: 23, prompt: "", target: "current-session", sessionId: "s-current",
  });
  assert.equal(current.status, 200);
  assert.deepEqual(current.payload, { ok: true, data: { sessionId: "s-current" } });
  assert.deepEqual(calls.map((entry) => entry.kind), ["gh", "snapshot", "append", "send"]);
});

test("conflict agent rejects invalid input and a PR without conflicts before handoff", async () => {
  const { calls, call } = makeHarness({
    exec: async () => ({
      stdout: JSON.stringify({ ...conflictingDetail, mergeable: "MERGEABLE" }),
      stderr: "",
    }),
  });

  const badNumber = await call("POST", "/api/github/pr/conflict-agent", {
    projectId: "p1", number: 0, prompt: "", target: "new-session",
  });
  assert.equal(badNumber.status, 400);
  assert.equal(calls.length, 0);

  const badTarget = await call("POST", "/api/github/pr/conflict-agent", {
    projectId: "p1", number: 23, prompt: "", target: "some-session",
  });
  assert.equal(badTarget.status, 400);
  assert.equal(calls.length, 0);

  const mergeable = await call("POST", "/api/github/pr/conflict-agent", {
    projectId: "p1", number: 23, prompt: "", target: "new-session",
  });
  assert.equal(mergeable.status, 409);
  assert.match(String((mergeable.payload as { reason: string }).reason), /not currently conflicting/);
  assert.deepEqual(calls.map((entry) => entry.kind), ["gh"]);
});

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

  const seen: Array<{ root: string; base?: string; userId?: string }> = [];
  const wired = makeHarness({
    describe: async (root, base, userId) => {
      seen.push({ root, ...(base ? { base } : {}), ...(userId ? { userId } : {}) });
      return { title: "Add thing", body: "Because reasons." };
    },
  });
  const on = await wired.call("POST", "/api/github/pr/describe", { projectId: "p1", base: "develop" });
  assert.equal(on.status, 200);
  assert.deepEqual(on.payload, { ok: true, data: { title: "Add thing", body: "Because reasons." } });
  assert.deepEqual(seen, [{ root: "/repo", base: "develop", userId: "usr_test" }]);

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

// ---- whose GitHub account a request uses (Spaces §14.4) -------------------------

test("a person's GitHub token reaches only the gh children of their own request", async () => {
  const { withGithubAuth } = await import("../src/index.ts");
  const seen: Array<Record<string, string> | undefined> = [];
  const github = createGithubService({ exec: async (_bin, _args, opts) => { seen.push(opts.env); return { stdout: "[]", stderr: "" }; } });
  await withGithubAuth({ token: "ghp_alice", host: "github.com" }, () => github.prs("/repo"));
  assert.equal(seen[0]?.GH_TOKEN, "ghp_alice");
  assert.ok(seen[0]?.GH_CONFIG_DIR, "the host's gh logins are hidden from the child");
  await withGithubAuth({ token: "ghe_tok", host: "ghe.corp.example" }, () => github.prs("/repo"));
  assert.equal(seen[1]?.GH_ENTERPRISE_TOKEN, "ghe_tok");
  assert.equal(seen[1]?.GH_HOST, "ghe.corp.example");
  assert.equal(seen[1]?.GH_TOKEN, undefined);
  await github.prs("/repo");
  assert.equal(seen[2], undefined, "outside a request context gh keeps the installation's logins");
  await assert.rejects(withGithubAuth({ token: "a b", host: "github.com" }, async () => undefined), { code: "auth-required" });
});

async function peopleFixture() {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fakePeople } = await import("../../git/test/fakePeople.ts");
  const { createPersonHostingAccounts } = await import("@polyth/git/person-accounts");
  const root = mkdtempSync(join(tmpdir(), "polyth-gh-routes-people-"));
  const host = fakePeople(root, { s1: ["alice", "bob", "owner"] });
  const people = createPersonHostingAccounts(host, "github");
  const request = (userId: string, method = "GET", path = "/api/github/accounts", body: Record<string, unknown> = {}, owner = false) => {
    let payload: unknown;
    const rc = {
      req: {}, res: {}, principal: { kind: "ui-session" },
      space: { spaceId: "s1", spaceSlug: "s1", userId, role: "member", deployment: "local-trusted", storageDir: "/x", instanceOwner: owner },
      url: new URL(`http://x${path}`), path, method, body: async () => body,
      json: (_status: number, data: unknown) => { payload = data; },
    } as unknown as RouteRequest;
    return { rc, payload: () => payload };
  };
  return { host, people, request, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("each person connects, toggles and removes only their own GitHub accounts; tokens never come back", async () => {
  const { githubAccountRoutes } = await import("../src/serverEntry.ts");
  const f = await peopleFixture();
  try {
    const verified: string[] = [];
    const routes = githubAccountRoutes({
      people: f.people,
      verify: async (origin, token) => { verified.push(`${origin}:${token}`); return { login: "alice-gh" }; },
      installation: () => false,
    });
    const connect = f.request("alice", "POST", "/api/github/accounts", { token: "ghp_alice_secret" });
    assert.equal(await routes(connect.rc as never), true);
    const created = (connect.payload() as { data: { id: string; login: string; enabled: boolean } }).data;
    assert.deepEqual([created.login, created.enabled], ["alice-gh", true]);
    assert.deepEqual(verified, ["https://github.com:ghp_alice_secret"]);
    assert.ok(!JSON.stringify(connect.payload()).includes("ghp_alice_secret"));

    const bobList = f.request("bob");
    await routes(bobList.rc as never);
    assert.deepEqual((bobList.payload() as { data: unknown[] }).data, [], "Bob never sees Alice's accounts");
    await assert.rejects(routes(f.request("bob", "DELETE", `/api/github/accounts/${created.id}`).rc as never), { code: "not-found" });
    await assert.rejects(routes(f.request("bob", "PUT", `/api/github/accounts/${created.id}/enabled`, { enabled: true }).rc as never), { code: "not-found" });

    const off = f.request("alice", "PUT", `/api/github/accounts/${created.id}/enabled`, { enabled: false });
    await routes(off.rc as never);
    assert.equal((off.payload() as { data: Array<{ enabled: boolean }> }).data[0]!.enabled, false);
    assert.deepEqual(f.people.enabledIn("alice", "s1"), []);
    const removed = f.request("alice", "DELETE", `/api/github/accounts/${created.id}`);
    await routes(removed.rc as never);
    assert.deepEqual((removed.payload() as { data: unknown[] }).data, []);
    assert.equal(f.host.vault("alice", "github").getOpaque(`account:${created.id}`), null, "the token is deleted with the account");
  } finally {
    f.cleanup();
  }
});

test("GitHub requests use the person's own token, the host's gh only for the owner, else refuse", async () => {
  const { githubRequestAuth } = await import("../src/serverEntry.ts");
  const f = await peopleFixture();
  try {
    const mine = f.people.connect("alice", { origin: "https://github.com", login: "alice-gh" }, "ghp_alice", "s1");
    const isMember = f.host.isMember;
    const auth = (userId: string, owner = false, hosts = ["github.com"]) =>
      githubRequestAuth({ people: f.people, request: f.request(userId, "GET", "/api/github/prs", {}, owner).rc, hosts, isMember });
    assert.deepEqual(auth("alice"), { kind: "personal", accountId: mine.id, auth: { token: "ghp_alice", host: "github.com" } });
    assert.deepEqual(auth("bob"), { kind: "refused", reason: "Connect your GitHub account in Profile → Accounts and turn it on for this Space." });
    assert.deepEqual(auth("owner", true), { kind: "installation" });
    // Alice's account does not apply to another host's repository.
    assert.equal(auth("alice", false, ["ghe.corp.example"]).kind, "refused");
    assert.deepEqual(auth("mallory", true), { kind: "refused", reason: "You are no longer a member of this Space." });
    assert.ok(mine.id.startsWith("p-"));
  } finally {
    f.cleanup();
  }
});

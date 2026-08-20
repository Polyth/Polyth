import { test } from "node:test";
import assert from "node:assert/strict";
import { createGithubService, type ExecFn } from "@polyth/github";

const enoent = (): never => {
  throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
};

test("fails soft when gh is missing", async () => {
  const svc = createGithubService({ exec: async () => enoent() });
  const status = await svc.status("/tmp");
  assert.equal(status.installed, false);
  assert.equal(status.repo, null);
  assert.match(status.reason ?? "", /not installed/);

  const issues = await svc.issues("/tmp");
  assert.equal(issues.ok, false);
  if (!issues.ok) assert.match(issues.reason, /not installed/);
});

test("fails soft when unauthenticated or outside a GitHub repo", async () => {
  const exec: ExecFn = async (_bin, args) => {
    if (args[0] === "--version") return { stdout: "gh version 2.x", stderr: "" };
    if (args[0] === "auth") throw Object.assign(new Error("exit 1"), { stderr: "You are not logged in to any GitHub hosts. Run gh auth login." });
    throw Object.assign(new Error("exit 1"), { stderr: "no git remotes found" });
  };
  const svc = createGithubService({ exec });
  const status = await svc.status("/repo");
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.repo, null);
  assert.match(status.reason ?? "", /not connected to a GitHub repository/);
});

test("parses repo, issues, and PR lists from gh JSON output", async () => {
  const exec: ExecFn = async (_bin, args) => {
    if (args[0] === "--version" || args[0] === "auth") return { stdout: "ok", stderr: "" };
    if (args[0] === "repo") {
      return {
        stdout: JSON.stringify({
          name: "polyth", owner: { login: "acme" }, url: "https://github.com/acme/polyth",
          description: null, defaultBranchRef: { name: "master" }, isPrivate: true,
        }),
        stderr: "",
      };
    }
    if (args[0] === "issue") {
      return {
        stdout: JSON.stringify([
          { number: 7, title: "Bug", state: "OPEN", author: { login: "kat" }, updatedAt: "2026-08-01T00:00:00Z", url: "u" },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "pr") {
      return {
        stdout: JSON.stringify([
          { number: 12, title: "Feat", state: "OPEN", author: null, updatedAt: "2026-08-02T00:00:00Z", url: "u2", isDraft: true, headRefName: "feat/x" },
        ]),
        stderr: "",
      };
    }
    return enoent();
  };
  const svc = createGithubService({ exec });

  const status = await svc.status("/repo");
  assert.equal(status.authenticated, true);
  assert.equal(status.repo?.owner, "acme");
  assert.equal(status.repo?.defaultBranch, "master");
  assert.equal(status.repo?.description, "");

  const issues = await svc.issues("/repo");
  assert.ok(issues.ok);
  if (issues.ok) assert.deepEqual(issues.data[0], { number: 7, title: "Bug", state: "OPEN", author: "kat", updatedAt: "2026-08-01T00:00:00Z", url: "u" });

  const prs = await svc.prs("/repo");
  assert.ok(prs.ok);
  if (prs.ok) {
    assert.equal(prs.data[0]?.isDraft, true);
    assert.equal(prs.data[0]?.author, "");
    assert.equal(prs.data[0]?.headRefName, "feat/x");
  }
});

test("limit is passed through to gh", async () => {
  const calls: Array<{ bin: string; args: string[]; cwd?: string }> = [];
  const exec: ExecFn = async (bin, args, opts) => {
    calls.push({ bin, args, cwd: opts.cwd });
    return { stdout: "[]", stderr: "" };
  };
  const svc = createGithubService({ exec });
  await svc.issues("/repo", 5);
  await svc.prs("/other");

  assert.deepEqual(calls, [
    {
      bin: "gh",
      args: ["issue", "list", "--limit", "5", "--json", "number,title,state,author,updatedAt,url"],
      cwd: "/repo",
    },
    {
      bin: "gh",
      args: ["pr", "list", "--limit", "30", "--json", "number,title,state,author,updatedAt,url,isDraft,headRefName"],
      cwd: "/other",
    },
  ]);
});

test("malformed gh JSON and generic command failures stay soft", async () => {
  const malformed = createGithubService({
    exec: async () => ({ stdout: "{not-json", stderr: "" }),
  });
  const issues = await malformed.issues("/repo");
  assert.equal(issues.ok, false);
  if (!issues.ok) assert.match(issues.reason, /JSON|property name|Unexpected token/i);

  const failed = createGithubService({
    exec: async () => {
      throw Object.assign(new Error("exit 1"), { stderr: "first line\nextra detail" });
    },
  });
  const repo = await failed.repo("/repo");
  assert.deepEqual(repo, { ok: false, reason: "first line" });
});

test("status can report auth failure while still resolving a public repo", async () => {
  const calls: string[][] = [];
  const exec: ExecFn = async (_bin, args) => {
    calls.push(args);
    if (args[0] === "--version") return { stdout: "gh version 2.x", stderr: "" };
    if (args[0] === "auth") throw new Error("not signed in");
    return {
      stdout: JSON.stringify({
        name: "public",
        owner: { login: "acme" },
        url: "https://github.com/acme/public",
        description: "demo",
        defaultBranchRef: null,
        isPrivate: false,
      }),
      stderr: "",
    };
  };

  const status = await createGithubService({ exec }).status("/repo");
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.repo?.name, "public");
  assert.equal(status.repo?.defaultBranch, "");
  assert.equal(status.reason, undefined);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [
    ["--version"],
    ["auth", "status"],
    ["repo", "view"],
  ]);
});

test("missing gh short-circuits status after the version probe", async () => {
  let calls = 0;
  const status = await createGithubService({
    exec: async () => {
      calls += 1;
      return enoent();
    },
  }).status("/repo");

  assert.equal(calls, 1);
  assert.deepEqual(
    { installed: status.installed, authenticated: status.authenticated, repo: status.repo },
    { installed: false, authenticated: false, repo: null },
  );
});

// ---- WP11: PR detail surfaces + guarded writes -----------------------------

test("prDetail/prFiles/prChecks parse gh JSON and fail soft", async () => {
  const exec: ExecFn = async (_bin, args) => {
    const fields = args[args.indexOf("--json") + 1] ?? "";
    if (fields.startsWith("number,")) {
      return {
        stdout: JSON.stringify({
          number: 4, title: "T", state: "OPEN", isDraft: false, author: { login: "kat" },
          url: "u", body: null, baseRefName: "main", headRefName: "feat", headRefOid: "abc123",
          additions: 10, deletions: 2, changedFiles: 3, mergeable: "MERGEABLE",
          createdAt: "c", updatedAt: "d",
        }),
        stderr: "",
      };
    }
    if (fields === "files") {
      return { stdout: JSON.stringify({ files: [{ path: "a.ts", additions: 5, deletions: 1 }] }), stderr: "" };
    }
    if (fields === "statusCheckRollup") {
      return {
        stdout: JSON.stringify({
          statusCheckRollup: [
            { name: "build", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "http://b" },
            { context: "legacy", state: "PENDING" },
          ],
        }),
        stderr: "",
      };
    }
    throw Object.assign(new Error("exit 1"), { stderr: "unexpected" });
  };
  const svc = createGithubService({ exec });

  const detail = await svc.prDetail("/repo", 4);
  assert.ok(detail.ok);
  if (detail.ok) {
    assert.equal(detail.data.headRefOid, "abc123");
    assert.equal(detail.data.body, "");
    assert.equal(detail.data.author, "kat");
  }

  const files = await svc.prFiles("/repo", 4);
  assert.ok(files.ok);
  if (files.ok) assert.deepEqual(files.data, [{ path: "a.ts", additions: 5, deletions: 1 }]);

  const checks = await svc.prChecks("/repo", 4);
  assert.ok(checks.ok);
  if (checks.ok) {
    assert.equal(checks.data[0]?.status, "failure");
    assert.equal(checks.data[1]?.status, "queued");
  }

  const broken = createGithubService({ exec: async () => enoent() });
  const soft = await broken.prDetail("/repo", 4);
  assert.equal(soft.ok, false);
});

test("prComments merges issue comments and reviews sorted by time", async () => {
  const exec: ExecFn = async () => ({
    stdout: JSON.stringify({
      comments: [{ id: "c1", author: { login: "a" }, body: "hi", createdAt: "2026-01-02", url: "u1" }],
      reviews: [
        { id: "r1", author: { login: "b" }, body: "lgtm", submittedAt: "2026-01-01", state: "APPROVED" },
        { id: "r2", author: null, body: "", state: "" },
      ],
    }),
    stderr: "",
  });
  const r = await createGithubService({ exec }).prComments("/repo", 9);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.data.length, 2); // empty review dropped
    assert.equal(r.data[0]?.id, "r1");
    assert.equal(r.data[0]?.reviewState, "APPROVED");
    assert.equal(r.data[1]?.kind, "issue");
  }
});

test("submitReview posts JSON via stdin and is idempotent per content digest", async () => {
  let posts = 0;
  const exec: ExecFn = async (_bin, args, opts) => {
    assert.equal(args[0], "api");
    assert.match(args[1] ?? "", /pulls\/7\/reviews$/);
    posts += 1;
    const body = JSON.parse(opts.input ?? "{}") as { event: string };
    assert.equal(body.event, "COMMENT");
    return { stdout: JSON.stringify({ id: 555, html_url: "http://r" }), stderr: "" };
  };
  const svc = createGithubService({ exec });
  const input = { number: 7, event: "COMMENT" as const, body: "note", comments: [{ path: "a.ts", line: 3, body: "x" }] };
  const first = await svc.submitReview("/repo", input);
  const retry = await svc.submitReview("/repo", input);
  assert.equal(posts, 1);
  assert.deepEqual(first, retry);
  assert.ok(first.ok);
  if (first.ok) assert.equal(first.data.id, "555");

  // different payload posts again
  await svc.submitReview("/repo", { ...input, body: "other" });
  assert.equal(posts, 2);
});

// ---- F7: PR lifecycle (create / update / merge) ------------------------------

test("prCreate passes the body via stdin and parses the PR number from the URL", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const exec: ExecFn = async (_bin, args, opts) => {
    calls.push({ args, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    return { stdout: "https://github.com/acme/polyth/pull/42\n", stderr: "" };
  };
  const svc = createGithubService({ exec });
  const r = await svc.prCreate("/repo", { title: "Add thing", body: "does **stuff**", base: "main", draft: true });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.data, { number: 42, url: "https://github.com/acme/polyth/pull/42" });
  assert.deepEqual(calls[0]?.args, [
    "pr", "create", "--title", "Add thing", "--body-file", "-",
    "--base", "main", "--draft",
  ]);
  assert.equal(calls[0]?.input, "does **stuff**");
});

test("prCreate rejects empty titles and flag-like refs before any gh call", async () => {
  let calls = 0;
  const svc = createGithubService({ exec: async () => { calls += 1; return { stdout: "", stderr: "" }; } });
  const noTitle = await svc.prCreate("/repo", { title: "  ", body: "" });
  assert.equal(noTitle.ok, false);
  const badBase = await svc.prCreate("/repo", { title: "T", body: "", base: "--delete-branch" });
  assert.equal(badBase.ok, false);
  const badHead = await svc.prCreate("/repo", { title: "T", body: "", head: "-evil" });
  assert.equal(badHead.ok, false);
  assert.equal(calls, 0);

  const noUrl = createGithubService({ exec: async () => ({ stdout: "something went sideways", stderr: "" }) });
  const r = await noUrl.prCreate("/repo", { title: "T", body: "" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /did not return a pull request URL/);
});

test("prUpdate requires at least one field and sends the body via stdin", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const exec: ExecFn = async (_bin, args, opts) => {
    calls.push({ args, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    return { stdout: "", stderr: "" };
  };
  const svc = createGithubService({ exec });

  const nothing = await svc.prUpdate("/repo", 5, {});
  assert.equal(nothing.ok, false);
  if (!nothing.ok) assert.match(nothing.reason, /nothing to update/);
  assert.equal(calls.length, 0);

  const r = await svc.prUpdate("/repo", 5, { title: "New title", body: "new body" });
  assert.ok(r.ok);
  assert.deepEqual(calls[0]?.args, ["pr", "edit", "5", "--title", "New title", "--body-file", "-"]);
  assert.equal(calls[0]?.input, "new body");

  const badBase = await svc.prUpdate("/repo", 5, { base: "-x" });
  assert.equal(badBase.ok, false);
});

test("prMerge maps strategies to gh flags and never deletes the branch", async () => {
  const calls: string[][] = [];
  const exec: ExecFn = async (_bin, args) => { calls.push(args); return { stdout: "", stderr: "" }; };
  const svc = createGithubService({ exec });

  for (const [strategy, flag] of [["squash", "--squash"], ["merge", "--merge"], ["rebase", "--rebase"]] as const) {
    const r = await svc.prMerge("/repo", 7, strategy);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.data.strategy, strategy);
    assert.deepEqual(calls.at(-1), ["pr", "merge", "7", flag]);
  }
  assert.ok(calls.every((args) => !args.includes("--delete-branch")));

  const bad = await svc.prMerge("/repo", 7, "fast-forward" as never);
  assert.equal(bad.ok, false);
  assert.equal(calls.length, 3);

  const failing = createGithubService({
    exec: async () => { throw Object.assign(new Error("exit 1"), { stderr: "Pull request is not mergeable" }); },
  });
  const soft = await failing.prMerge("/repo", 7, "squash");
  assert.equal(soft.ok, false);
  if (!soft.ok) assert.match(soft.reason, /not mergeable/);
});

test("addLabels enforces the risk/confidence policy before any gh call", async () => {
  let calls = 0;
  const svc = createGithubService({ exec: async () => { calls += 1; return { stdout: "", stderr: "" }; } });

  const bad = await svc.addLabels("/repo", 3, ["risk:9"]);
  assert.equal(bad.ok, false);
  const injection = await svc.addLabels("/repo", 3, ["risk:3; rm -rf /"]);
  assert.equal(injection.ok, false);
  const empty = await svc.addLabels("/repo", 3, []);
  assert.equal(empty.ok, false);
  assert.equal(calls, 0);

  const good = await svc.addLabels("/repo", 3, ["risk:3", "confidence:4"]);
  assert.ok(good.ok);
  assert.equal(calls, 1);
});

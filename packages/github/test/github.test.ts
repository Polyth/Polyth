import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConflictResolutionPrompt, createGithubService, type ExecFn } from "@polyth/github";

const enoent = (): never => {
  throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
};

test("buildConflictResolutionPrompt includes PR context, custom instructions, and safety boundaries", () => {
  const prompt = buildConflictResolutionPrompt({
    number: 42,
    title: "Rework session routing",
    url: "https://github.com/acme/polyth/pull/42",
    baseRefName: "main",
    headRefName: "feat/session-routing",
  }, "Prefer the incoming database migration when both sides changed the schema.");

  assert.match(prompt, /pull request #42/i);
  assert.match(prompt, /Rework session routing/);
  assert.match(prompt, /https:\/\/github\.com\/acme\/polyth\/pull\/42/);
  assert.match(prompt, /Base branch: main/);
  assert.match(prompt, /Head branch: feat\/session-routing/);
  assert.match(prompt, /Prefer the incoming database migration/);
  assert.match(prompt, /Run the relevant tests or checks/);
  assert.match(prompt, /Commit the completed conflict resolution locally/);
  assert.match(prompt, /Do not merge the pull request or push any commits without explicit user approval/);
});

test("fails soft when gh is missing", async () => {
  const svc = createGithubService({ exec: async () => enoent() });
  const status = await svc.status("/tmp");
  assert.equal(status.installed, false);
  assert.equal(status.user, null);
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
  assert.equal(status.user, null);
  assert.equal(status.repo, null);
  assert.match(status.reason ?? "", /not connected to a GitHub repository/);
});

test("parses repo, issues, and PR lists from gh JSON output", async () => {
  const exec: ExecFn = async (_bin, args) => {
    if (args[0] === "--version" || args[0] === "auth") return { stdout: "ok", stderr: "" };
    if (args[0] === "api") return { stdout: JSON.stringify({ login: "kat", avatar_url: "https://avatars.githubusercontent.com/u/1" }), stderr: "" };
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
  assert.deepEqual(status.user, { login: "kat", avatarUrl: "https://avatars.githubusercontent.com/u/1" });
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

test("currentPrSummary reads the current branch PR diff totals", async () => {
  const calls: string[][] = [];
  const svc = createGithubService({
    exec: async (_bin, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          number: 31,
          title: "Widget summaries",
          url: "https://github.com/acme/polyth/pull/31",
          changedFiles: 8,
          additions: 144,
          deletions: 23,
        }),
        stderr: "",
      };
    },
  });

  const result = await svc.currentPrSummary("/repo");
  assert.deepEqual(calls, [[
    "pr", "view", "--json", "number,title,url,changedFiles,additions,deletions",
  ]]);
  assert.deepEqual(result, {
    ok: true,
    data: {
      number: 31,
      title: "Widget summaries",
      url: "https://github.com/acme/polyth/pull/31",
      changedFiles: 8,
      additions: 144,
      deletions: 23,
    },
  });
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

test("prDetail works with gh versions that do not support headRefOid", async () => {
  const calls: string[][] = [];
  const exec: ExecFn = async (_bin, args) => {
    calls.push(args);
    if (args[0] === "pr") {
      return {
        stdout: JSON.stringify({
          number: 4, title: "T", state: "OPEN", isDraft: false, author: { login: "kat" },
          url: "u", body: "body", baseRefName: "main", headRefName: "feat",
          additions: 10, deletions: 2, changedFiles: 3, mergeable: "MERGEABLE",
          createdAt: "c", updatedAt: "d",
        }),
        stderr: "",
      };
    }
    assert.deepEqual(args, ["api", "repos/{owner}/{repo}/pulls/4"]);
    return { stdout: JSON.stringify({ head: { sha: "abc123" } }), stderr: "" };
  };

  const result = await createGithubService({ exec }).prDetail("/repo", 4);
  assert.ok(result.ok);
  if (result.ok) assert.equal(result.data.headRefOid, "abc123");
  assert.deepEqual(calls, [
    [
      "pr", "view", "4", "--json",
      "number,title,state,isDraft,author,url,body,baseRefName,headRefName,additions,deletions,changedFiles,mergeable,createdAt,updatedAt",
    ],
    ["api", "repos/{owner}/{repo}/pulls/4"],
  ]);
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

test("issue detail and comments preserve Markdown and author metadata", async () => {
  const calls: string[][] = [];
  const exec: ExecFn = async (_bin, args) => {
    calls.push(args);
    const fields = args[args.indexOf("--json") + 1];
    if (fields === "comments") {
      return {
        stdout: JSON.stringify({
          comments: [
            { id: "IC_1", author: { login: "sam" }, body: "Looks **good**", createdAt: "2026-08-03", url: "c1" },
            { author: null, body: "Follow-up", createdAt: "2026-08-04", url: "c2" },
          ],
        }),
        stderr: "",
      };
    }
    return {
      stdout: JSON.stringify({
        number: 17, title: "Broken button", state: "OPEN", author: { login: "kat" },
        updatedAt: "2026-08-02", createdAt: "2026-08-01", url: "issue-url",
        body: "## Reproduction\n\nClick it.",
      }),
      stderr: "",
    };
  };
  const svc = createGithubService({ exec });

  const detail = await svc.getIssue("/repo", 17);
  assert.deepEqual(detail, {
    ok: true,
    data: {
      number: 17, title: "Broken button", state: "OPEN", author: "kat",
      updatedAt: "2026-08-02", createdAt: "2026-08-01", url: "issue-url",
      body: "## Reproduction\n\nClick it.",
    },
  });
  const comments = await svc.getIssueComments("/repo", 17);
  assert.ok(comments.ok);
  if (comments.ok) {
    assert.equal(comments.data[0]?.id, "IC_1");
    assert.equal(comments.data[0]?.body, "Looks **good**");
    assert.equal(comments.data[1]?.id, "comment-1");
    assert.equal(comments.data[1]?.author, "");
  }
  assert.deepEqual(calls, [
    ["issue", "view", "17", "--json", "number,title,state,author,updatedAt,createdAt,url,body"],
    ["issue", "view", "17", "--json", "comments"],
  ]);
});

test("issue and PR comments use stdin and reject empty bodies", async () => {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const svc = createGithubService({
    exec: async (_bin, args, opts) => {
      calls.push({ args, ...(opts.input !== undefined ? { input: opts.input } : {}) });
      return { stdout: `https://github.com/a/r/${args[0]}/7#comment\n`, stderr: "" };
    },
  });

  assert.equal((await svc.addIssueComment("/repo", 7, "  ")).ok, false);
  assert.equal((await svc.addPrComment("/repo", 7, "\n")).ok, false);
  assert.equal(calls.length, 0);

  const issue = await svc.addIssueComment("/repo", 7, "  issue reply  ");
  const pr = await svc.addPrComment("/repo", 8, "PR reply");
  assert.ok(issue.ok);
  assert.ok(pr.ok);
  assert.deepEqual(calls, [
    { args: ["issue", "comment", "7", "--body-file", "-"], input: "issue reply" },
    { args: ["pr", "comment", "8", "--body-file", "-"], input: "PR reply" },
  ]);
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


test("shared search and state filters reach gh as literal arguments", async () => {
  const calls: string[][] = [];
  const svc = createGithubService({ exec: async (_bin, args) => { calls.push(args); return { stdout: "[]", stderr: "" }; } });
  await svc.issues("/repo", 30, { state: "closed", search: "--label=bug $(no-shell)" });
  await svc.prs("/repo", 30, { state: "merged", search: "fix pipeline" });
  assert.ok(calls[0]?.includes("--state=closed"));
  assert.ok(calls[0]?.includes("--search=--label=bug $(no-shell)"));
  assert.ok(calls[1]?.includes("--state=merged"));
  assert.ok(calls[1]?.includes("--search=fix pipeline"));
});

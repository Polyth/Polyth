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

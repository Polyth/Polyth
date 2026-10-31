import test from "node:test";
import assert from "node:assert/strict";

const values = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => void values.set(key, value),
  removeItem: (key: string) => void values.delete(key),
};

const {
  classifyGithubAttach,
  githubUrlMatchesRepo,
  githubUrlRef,
  parseGithubUrl,
} = await import("../widgets/attachments.ts");

test("GitHub attachment URLs accept only lone PR and issue links", () => {
  const pull = parseGithubUrl("https://github.com/octo/repo/pull/42");
  assert.deepEqual(pull, {
    owner: "octo",
    repo: "repo",
    kind: "pull",
    number: 42,
    url: "https://github.com/octo/repo/pull/42",
  });
  const issue = parseGithubUrl("  https://github.com/octo/repo/issues/7#issuecomment-1 ");
  assert.equal(issue?.kind, "issues");
  assert.equal(issue?.number, 7);
  assert.equal(parseGithubUrl("https://github.com/octo/repo"), null);
  assert.equal(parseGithubUrl("https://gitlab.com/octo/repo/pull/42"), null);
  assert.equal(parseGithubUrl("http://github.com/octo/repo/pull/42"), null);
  assert.equal(parseGithubUrl("check https://github.com/octo/repo/pull/42 out"), null);
});

test("GitHub attachment pills require the active repository", () => {
  const parts = parseGithubUrl("https://github.com/Octo/Repo/pull/9")!;
  assert.ok(githubUrlMatchesRepo(parts, { owner: "octo", name: "repo" }));
  assert.ok(!githubUrlMatchesRepo(parts, { owner: "octo", name: "other" }));
  assert.ok(!githubUrlMatchesRepo(parts, null));
  const pill = githubUrlRef(parts);
  assert.equal(pill.kind, "url");
  assert.equal(pill.name, "PR #9");
  assert.equal(pill.url, "https://github.com/Octo/Repo/pull/9");
  assert.equal(pill.size, 0);
});

test("GitHub attachment classification preserves every failure state", () => {
  const repo = { ok: true as const, repo: { owner: "acme", name: "app" } };
  assert.equal(classifyGithubAttach(null, repo).code, "invalid-url");
  const issue = parseGithubUrl("https://github.com/acme/app/issues/12");
  const pull = parseGithubUrl("https://github.com/acme/app/pull/9");
  assert.ok(issue && pull);
  assert.equal(classifyGithubAttach(issue, repo).code, "ok");
  assert.equal(classifyGithubAttach(pull, repo).code, "ok");

  const other = parseGithubUrl("https://github.com/oss/lib/issues/3");
  const mismatch = classifyGithubAttach(other!, repo);
  assert.equal(mismatch.code, "repo-mismatch");
  assert.match(mismatch.code === "repo-mismatch" ? mismatch.reason : "", /oss\/lib/);

  const noRepo = classifyGithubAttach(issue!, { ok: true, repo: null });
  assert.equal(noRepo.code, "no-repo");
  const failed = classifyGithubAttach(issue!, { ok: false, reason: "socket hang up" });
  assert.equal(failed.code, "request-failed");
  assert.match(failed.code === "request-failed" ? failed.reason : "", /socket hang up/);
  assert.notEqual(failed.code, noRepo.code);
});

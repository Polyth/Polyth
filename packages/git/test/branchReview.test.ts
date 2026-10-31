import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createGitService, type GitBranchDiffList, type GitBranchFileDiff } from "../src/index.ts";
import registerPackage, { GIT_SOURCE_CONTROL_REMOTE_ACCESS } from "../src/sourceControlServerEntry.ts";
import type { ServerPackageHost } from "@polyth/plugins";
import { REMOTE_CAPABILITY, type RouteRequest } from "@polyth/contracts";
import { defaultReviewScope, reviewNoteKey, capReviewExcerpt, markOutdatedNotes, reviewNotesMarkdown } from "../widgets/branchReview.ts";
import { handoffReviewScope, consumeReviewScope } from "../widgets/reviewScopeHandoff.ts";

const scratch = resolve(".scratch/feature-audit/w1/fixtures");
mkdirSync(scratch, { recursive: true });
function fixture(branch = "main") {
  const root = mkdtempSync(join(scratch, "repo-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  run("init", "-b", branch); run("config", "user.name", "Review test"); run("config", "user.email", "review@example.test");
  writeFileSync(join(root, "file.txt"), "one\ntwo\n"); run("add", "."); run("commit", "-m", "base");
  return { root, run, close: () => rmSync(root, { recursive: true, force: true }) };
}
const git = createGitService();

test("branch review includes branch commits, uncommitted and untracked changes without mutation", async () => {
  const f = fixture();
  try {
    f.run("checkout", "-b", "topic"); writeFileSync(join(f.root, "file.txt"), "one\ncommitted\n"); f.run("commit", "-am", "topic");
    writeFileSync(join(f.root, "file.txt"), "one\ncommitted\nworking\n"); writeFileSync(join(f.root, "new.txt"), "new\n");
    const before = f.run("status", "--porcelain=v1");
    const list = await git.branchDiff(f.root) as GitBranchDiffList;
    assert.equal(list.base, "main"); assert.equal(list.ahead, 1); assert.equal(list.files.length, 2);
    const patch = await git.branchDiff(f.root, { path: "file.txt" }) as GitBranchFileDiff;
    assert.match(patch.diff, /\+committed/); assert.match(patch.diff, /\+working/);
    assert.match((await git.branchDiff(f.root, { path: "new.txt" }) as GitBranchFileDiff).diff, /\+new/);
    assert.equal(f.run("status", "--porcelain=v1"), before);
  } finally { f.close(); }
});

test("base resolution prefers an explicit requested base, then isolation target/commit, then origin default", async () => {
  const f = fixture();
  try {
    const sha = f.run("rev-parse", "HEAD"); f.run("checkout", "-b", "topic");
    const refsBefore = f.run("for-each-ref", "--format=%(refname) %(objectname)");
    // An explicit caller base wins over the isolation record without mutating it.
    let list = await git.branchDiff(f.root, { isolation: { targetBranch: "main", baseCommit: sha }, base: "topic" }) as GitBranchDiffList;
    assert.equal(list.base, "topic"); assert.equal(list.baseSource, "requested");
    // With no explicit base the isolation target branch is selected automatically.
    list = await git.branchDiff(f.root, { isolation: { targetBranch: "main", baseCommit: sha } }) as GitBranchDiffList;
    assert.equal(list.base, "main"); assert.equal(list.baseSource, "isolation");
    // An absent isolation target branch falls back to the recorded base commit.
    list = await git.branchDiff(f.root, { isolation: { targetBranch: "gone", baseCommit: sha } }) as GitBranchDiffList;
    assert.equal(list.base, sha);
    // An explicit base still works without isolation.
    list = await git.branchDiff(f.root, { base: "topic" }) as GitBranchDiffList; assert.equal(list.baseSource, "requested");
    // An unknown explicit base is rejected even while an isolation record is present.
    await assert.rejects(git.branchDiff(f.root, { isolation: { targetBranch: "main", baseCommit: sha }, base: "no-such-ref" }), { code: "invalid-input" });
    assert.equal(f.run("for-each-ref", "--format=%(refname) %(objectname)"), refsBefore, "base selection must not mutate refs or the isolation record");
    assert.equal(f.run("rev-parse", "--abbrev-ref", "HEAD"), "topic");
    f.run("update-ref", "refs/remotes/origin/default", sha); f.run("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/default");
    assert.equal((await git.branchDiff(f.root) as GitBranchDiffList).base, "origin/default");
  } finally { f.close(); }
});

test("branch review rejects option and range refs", async () => {
  const f = fixture();
  try { for (const base of ["-x", "--upload-pack=x", "a..b", "a...b", "two words"]) await assert.rejects(git.branchDiff(f.root, { base }), { code: "invalid-input" }); }
  finally { f.close(); }
});

test("branch review applies ignoreWhitespace and refuses traversal and outside symlinks; binary has no content", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "file.txt"), "one  \ntwo\n");
    assert.equal((await git.branchDiff(f.root) as GitBranchDiffList).files.length, 1);
    const ignored = await git.branchDiff(f.root, { ignoreWhitespace: true }) as GitBranchDiffList;
    assert.equal(ignored.files[0]?.additions, 0); assert.equal(ignored.files[0]?.deletions, 0);
    assert.equal((await git.branchDiff(f.root, { path: "file.txt", ignoreWhitespace: true }) as GitBranchFileDiff).diff, "");
    writeFileSync(join(f.root, "binary"), Buffer.from([0, 1, 2]));
    const binary = await git.branchDiff(f.root, { path: "binary" }) as GitBranchFileDiff; assert.equal(binary.binary, true); assert.equal(binary.diff, "");
    symlinkSync(resolve("AGENTS.md"), join(f.root, "outside"));
    await assert.rejects(git.branchDiff(f.root, { path: "outside" }), { code: "invalid-input" });
    await assert.rejects(git.branchDiff(f.root, { path: "../AGENTS.md" }));
  } finally { f.close(); }
});

test("untracked branch review cannot follow a directory swapped during Git execution", { skip: process.platform !== "linux", timeout: 10_000 }, async () => {
  const f = fixture();
  const race = mkdtempSync(join(scratch, "race-"));
  try {
    const original = join(f.root, "nested"), foreign = join(race, "foreign");
    mkdirSync(original); mkdirSync(foreign);
    writeFileSync(join(original, "new.txt"), "owned data\n");
    writeFileSync(join(foreign, "new.txt"), "KNOWN-FOREIGN-CONTENT\nsecond\nthird\n");
    const wrapper = join(race, "git.mjs");
    writeFileSync(wrapper, `#!/usr/bin/env node
import { renameSync, symlinkSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2), original = ${JSON.stringify(original)}, foreign = ${JSON.stringify(foreign)};
const saved = original + "-saved", attack = args.includes("--no-index");
if (attack) { renameSync(original, saved); symlinkSync(foreign, original, "dir"); }
let result;
try { result = spawnSync("git", args, { encoding: "utf8", timeout: 2000 }); }
finally { if (attack) { unlinkSync(original); renameSync(saved, original); } }
process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    const reviewed = createGitService({ bin: wrapper, timeoutMs: 3000 });
    const files = await reviewed.branchDiff(f.root) as GitBranchDiffList;
    assert.equal(files.files.find((file) => file.path === "nested/new.txt")?.additions, 1,
      "statistics are derived from the owned directory");
    const patch = await reviewed.branchDiff(f.root, { path: "nested/new.txt" }) as GitBranchFileDiff;
    assert.match(patch.diff, /\+owned data/);
    assert.doesNotMatch(patch.diff, /KNOWN-FOREIGN-CONTENT/);
    assert.match(patch.diff, /^diff --git a\/nested\/new\.txt b\/nested\/new\.txt/m);
    assert.doesNotMatch(patch.diff, /\/proc\/\d+\/fd\//, "kernel handle paths stay private");
  } finally { f.close(); rmSync(race, { recursive: true, force: true }); }
});

test("branch review reports no base and no merge base explicitly", async () => {
  const f = fixture("custom");
  try {
    await assert.rejects(git.branchDiff(f.root), { code: "no-base" });
    f.run("checkout", "--orphan", "unrelated"); f.run("rm", "-rf", "."); writeFileSync(join(f.root, "other"), "other"); f.run("add", "."); f.run("commit", "-m", "unrelated");
    await assert.rejects(git.branchDiff(f.root, { base: "custom" }), { code: "no-merge-base" });
  } finally { f.close(); }
});

test("note keys isolate project, repository, workspace, base and head; markdown caps excerpts and excludes outdated", () => {
  const identity = { project: "p", repository: "r", workspace: "w", base: "b", head: "h" };
  for (const field of Object.keys(identity) as Array<keyof typeof identity>) assert.notEqual(reviewNoteKey(identity), reviewNoteKey({ ...identity, [field]: `${identity[field]}:` }));
  const excerpt = Array.from({ length: 30 }, (_, i) => String(i)).join("\n"); assert.equal(capReviewExcerpt(excerpt).split("\n").length, 12);
  const notes = [{ id: "1", path: "file", text: "current", line: 1, mergeBase: "b", head: "h", createdAt: 1, excerpt, digest: "a" }, { id: "2", path: "file", text: "stale", line: 1, mergeBase: "b", head: "h", createdAt: 1, excerpt, digest: "b" }];
  const checked = markOutdatedNotes(notes, "file", ["a"]); assert.equal(checked[1]!.outdated, true);
  const markdown = reviewNotesMarkdown(checked); assert.match(markdown, /current/); assert.doesNotMatch(markdown, /stale/); assert.equal(markdown.split("```diff\n")[1]!.split("\n```")[0]!.split("\n").length, 12);
  assert.equal(defaultReviewScope(true), "branch"); assert.equal(defaultReviewScope(false), "working"); assert.equal(defaultReviewScope(true, "working"), "working");
  handoffReviewScope("space-a:p:s", "branch"); assert.equal(consumeReviewScope("space-b:p:s"), undefined); assert.equal(consumeReviewScope("space-a:p:other"), undefined); assert.deepEqual(consumeReviewScope("space-a:p:s"), { scope: "branch" }); assert.equal(consumeReviewScope("space-a:p:s"), undefined);
  handoffReviewScope("space-a:p:s", "conflicts", "src/a.ts"); assert.deepEqual(consumeReviewScope("space-a:p:s"), { scope: "conflicts", path: "src/a.ts" });
});

test("scoped route rejects known-valid foreign Space project/session and wrong-project sessions identically without calling Git", async () => {
  const projects = new Map([["local", { id: "local", name: "local", path: "/local" }], ["foreign", { id: "foreign", name: "foreign", path: "/foreign" }]]);
  const sessions = new Map([["local-session", { id: "local-session", projectId: "local" }], ["foreign-session", { id: "foreign-session", projectId: "foreign" }], ["mismatch", { id: "mismatch", projectId: "other" }]]);
  const services = new Map<unknown, unknown>(); let calls = 0;
  const host = {
    services: { provide: (key: unknown, value: unknown) => services.set((key as { id: string }).id, value), require: (key: unknown) => services.get((key as { id: string }).id) },
    projects: { get: () => { throw new Error("unscoped project lookup"); } }, sessions: { snapshot: () => { throw new Error("unscoped session lookup"); } },
    broadcast: {},
    forSpace: (space: { id: string }) => ({ projects: { get: (id: string) => id === "foreign" && space.id === "local-space" ? null : projects.get(id) }, sessions: { snapshot: (id: string) => { if (id === "foreign-session" && space.id === "local-space") throw new Error("foreign"); return sessions.get(id); } } }),
  } as unknown as ServerPackageHost;
  const pkg = registerPackage(host);
  for (const service of services.values()) if (service && typeof service === "object" && "branchDiff" in service) (service as { branchDiff: unknown }).branchDiff = async () => { calls++; return {}; };
  const invoke = (projectId: string, sessionId?: string, space = "local-space") => pkg.routes!({ path: "/api/git/branch-diff", method: "GET", url: new URL(`http://test/api/git/branch-diff?projectId=${projectId}${sessionId === undefined ? "" : `&sessionId=${sessionId}`}`), space: { id: space }, json: () => {} } as unknown as RouteRequest);
  const errors: Array<{ code: string; message: string; status: number }> = [];
  for (const [project, session] of [["foreign", "foreign-session"], ["local", "foreign-session"], ["local", "absent"], ["local", "mismatch"], ["local", ""]]) {
    try { await invoke(project!, session); assert.fail("must reject"); } catch (error) { const e = error as Error & { code: string; status: number }; errors.push({ code: e.code, message: e.message, status: e.status }); }
  }
  for (const error of errors) assert.deepEqual(error, { code: "not-found", status: 404, message: "workspace not found" });
  assert.equal(calls, 0);
  await invoke("foreign", "foreign-session", "foreign-space"); assert.equal(calls, 1, "foreign IDs are valid in their own Space");
  await invoke("local", "local-session"); assert.equal(calls, 2);
});

test("branch-diff remote policy grants read only", () => {
  assert.deepEqual(GIT_SOURCE_CONTROL_REMOTE_ACCESS.http.find((rule) => rule.path === "/api/git/branch-diff"), { methods: ["GET"], path: "/api/git/branch-diff", capability: REMOTE_CAPABILITY.gitRead, mutation: false });
});

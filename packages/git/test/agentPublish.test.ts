// polyth_git_publish: an agent's push runs as the person the chat acts for, and
// every refusal happens before anything touches Git or an account.
import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, SessionProjection, ToolExecutionContext } from "@polyth/contracts";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSafePush, createGitPublishTool, gitPublishInstruction, riskyGitConfig, type GitPublishToolDeps } from "../src/agentPublish.ts";

const session = (patch: Partial<SessionProjection> = {}): SessionProjection =>
  ({ id: "s1", projectId: "p1", spaceId: "space-1", actor: { userId: "alice" }, ...patch }) as SessionProjection;

const context = (patch: Partial<ToolExecutionContext> = {}): ToolExecutionContext =>
  ({ sessionId: "s1", projectId: "p1", cwd: "/work/repo/sub", spaceId: "space-1", actorUserId: "alice", ...patch });

interface Fakes {
  projection?: SessionProjection | undefined;
  root?: string | null;
  branch?: string | null;
  refuse?: Error;
  remoteProject?: boolean;
}

function setup(fakes: Fakes = {}) {
  const projection = "projection" in fakes ? fakes.projection : session();
  const acting: Array<Parameters<GitPublishToolDeps["actingGit"]>[0]> = [];
  const pushes: Array<[string, string]> = [];
  const cwds: string[] = [];
  let inside = false;
  const tool = createGitPublishTool({
    projection: (id) => id === "s1" ? projection : undefined,
    actingGit: async (input, fn) => {
      acting.push(input);
      if (fakes.refuse) throw fakes.refuse;
      inside = true;
      try { return await fn(); } finally { inside = false; }
    },
    push: async (root, remote, branch) => {
      assert.equal(inside, true, "push runs inside actingGit");
      assert.equal(branch, "branch" in fakes ? fakes.branch : "feature/x");
      pushes.push([root, remote]);
    },
    toplevel: async (cwd) => { cwds.push(cwd); return "root" in fakes ? fakes.root! : "/work/repo"; },
    currentBranch: async () => "branch" in fakes ? fakes.branch! : "feature/x",
    remoteProject: async () => fakes.remoteProject === true,
  });
  const run = (input: JsonObject = {}, ctx: ToolExecutionContext = context()) => tool.execute!(input, ctx);
  return { tool, run, acting, pushes, cwds, projection };
}

test("pushes the checked-out branch as the session's actor", async () => {
  const { run, acting, pushes, cwds, projection } = setup();
  assert.deepEqual(await run({ remote: "upstream" }), { output: "Pushed feature/x to upstream." });
  assert.deepEqual(cwds, ["/work/repo/sub"]);
  assert.equal(acting.length, 1);
  assert.equal(acting[0]!.session, projection);
  assert.deepEqual(acting[0]!.transport, { root: "/work/repo", remote: "upstream" });
  assert.equal("requester" in acting[0]!, false);
  assert.deepEqual(pushes, [["/work/repo", "upstream"]]);
});

test("the remote defaults to origin", async () => {
  const { run, acting, pushes } = setup();
  assert.deepEqual(await run(), { output: "Pushed feature/x to origin." });
  assert.equal(acting[0]!.transport!.remote, "origin");
  assert.deepEqual(pushes, [["/work/repo", "origin"]]);
});

test("a session without its own Space is scoped to the grant's", async () => {
  const { run, acting } = setup({ projection: session({ spaceId: undefined }) });
  await run();
  assert.equal(acting[0]!.session.spaceId, "space-1");
});

const refusals: Array<[string, string, Fakes, Partial<ToolExecutionContext>]> = [
  ["no Space", "forbidden", {}, { spaceId: undefined }],
  ["unknown chat", "not-found", { projection: undefined }, {}],
  ["another project's chat", "not-found", {}, { projectId: "p2" }],
  ["another Space's chat", "not-found", {}, { spaceId: "space-2" }],
  ["a turn that acts for no one", "forbidden", {}, { actorUserId: undefined }],
  ["a turn for someone else", "forbidden", {}, { actorUserId: "bob" }],
  ["a chat with no actor", "forbidden", { projection: session({ actor: undefined }) }, {}],
  ["a repository on another host", "unsupported", { remoteProject: true }, {}],
  ["no checkout", "invalid-input", { root: null }, {}],
  ["a detached HEAD", "conflict", { branch: null }, {}],
];

for (const [name, code, fakes, ctx] of refusals) {
  test(`refuses ${name} and runs nothing`, async () => {
    const { run, acting, pushes } = setup(fakes);
    await assert.rejects(async () => run({}, context(ctx)), { code });
    assert.equal(acting.length, 0);
    assert.equal(pushes.length, 0);
  });
}

test("a missing chat and a foreign chat answer identically", async () => {
  const message = async (fakes: Fakes, ctx: Partial<ToolExecutionContext>) => {
    try { await setup(fakes).run({}, context(ctx)); return ""; } catch (error) { return (error as Error).message; }
  };
  assert.equal(await message({ projection: undefined }, {}), "This chat is not available.");
  assert.equal(await message({}, { spaceId: "space-2" }), "This chat is not available.");
});

test("an actingGit refusal reaches the agent unchanged", async () => {
  const refuse = Object.assign(new Error("Link your account."), { code: "git-account-required", status: 409 });
  const { run, pushes } = setup({ refuse });
  await assert.rejects(async () => run(), (error) => error === refuse);
  assert.equal(pushes.length, 0);
});

// The `publish` word is what makes @polyth/permissions/risk rate it high-risk.
test("is a mutating, credentialed tool whose name says it publishes", () => {
  const { tool } = setup();
  const descriptor = tool.descriptor as Extract<typeof tool.descriptor, { kind: "tool" }>;
  assert.equal(descriptor.kind, "tool");
  assert.match(descriptor.name, /(^|_)publish(_|$)/);
  assert.equal(descriptor.mutating, true);
  assert.equal(descriptor.trust, "credentialed");
  assert.match(gitPublishInstruction.descriptor.text, new RegExp(descriptor.name));
});

// ---- the push itself, against real repositories ---------------------------

const ID = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

function repos() {
  const dir = mkdtempSync(join(tmpdir(), "polyth-agent-publish-"));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(dir, "clone", "--quiet", origin, work);
  git(work, "checkout", "--quiet", "-B", "feature/x");
  writeFileSync(join(work, "README.md"), "one\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "first");
  return { dir, origin, work };
}

test("agentSafePush publishes the branch under its own name and runs no hooks", async () => {
  const { dir, origin, work } = repos();
  const marker = join(dir, "hook-ran");
  mkdirSync(join(work, ".git", "hooks"), { recursive: true });
  const hook = join(work, ".git", "hooks", "pre-push");
  writeFileSync(hook, `#!/bin/sh\nenv > "${marker}"\n`);
  chmodSync(hook, 0o755);
  await agentSafePush(work, "origin", "feature/x");
  assert.equal(git(origin, "rev-parse", "refs/heads/feature/x"), git(work, "rev-parse", "HEAD"));
  assert.equal(existsSync(marker), false, "an agent-written hook never sees the push's environment");
  assert.equal(git(work, "rev-parse", "--abbrev-ref", "feature/x@{upstream}"), "origin/feature/x");
});

test("agentSafePush never forces, whatever the remote's push refspec says", async () => {
  const { dir, origin, work } = repos();
  await agentSafePush(work, "origin", "feature/x");
  const other = join(dir, "other");
  git(dir, "clone", "--quiet", "--branch", "feature/x", origin, other);
  writeFileSync(join(other, "README.md"), "theirs\n");
  git(other, "commit", "--quiet", "-am", "theirs");
  git(other, "push", "--quiet", "origin", "feature/x");
  const theirs = git(origin, "rev-parse", "refs/heads/feature/x");
  git(work, "config", "remote.origin.push", "+refs/heads/*:refs/heads/*");
  writeFileSync(join(work, "README.md"), "mine\n");
  git(work, "commit", "--quiet", "-am", "mine");
  await assert.rejects(agentSafePush(work, "origin", "feature/x"), (error: { code?: string; message: string }) =>
    error.code === "conflict" && /rejected/.test(error.message));
  assert.equal(git(origin, "rev-parse", "refs/heads/feature/x"), theirs, "the remote's commit stays");
});

test("agentSafePush refuses settings that could redirect the transport", async () => {
  const { origin, work } = repos();
  git(work, "config", "http.https://github.com/.proxy", "http://proxy.example.invalid:3128");
  await assert.rejects(agentSafePush(work, "origin", "feature/x"), /redirect this push \(http\.https:\/\/github\.com\/\.proxy\)/);
  git(work, "config", "--unset", "http.https://github.com/.proxy");
  git(work, "config", "url.https://elsewhere.example.invalid/.insteadOf", "https://github.com/");
  await assert.rejects(agentSafePush(work, "origin", "feature/x"), /insteadof/);
  assert.throws(() => git(origin, "rev-parse", "--verify", "--quiet", "refs/heads/feature/x"), "nothing was pushed");
  await assert.rejects(agentSafePush(work, "origin; rm -rf /", "feature/x"), /invalid remote/);
  await assert.rejects(agentSafePush(work, "origin", "../main"), /invalid branch/);
});

test("riskyGitConfig reads every scope but the command line", () => {
  const listing = [
    "global", "http.proxy\nhttp://p.example.invalid",
    "local", "remote.origin.pushurl\nhttps://elsewhere.example.invalid/r.git",
    "local", "remote.origin.url\nhttps://github.com/o/r.git",
    "local", "credential.https://github.com.username\nalice",
    "local", "core.sshcommand\nssh -F /dev/null",
    "command", "http.sslverify\nfalse",
    "",
  ].join("\0");
  assert.deepEqual(riskyGitConfig(listing), ["http.proxy", "remote.origin.pushurl"]);
});

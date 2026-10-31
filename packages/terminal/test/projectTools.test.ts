import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { HarnessProcessAuthority } from "@polyth/harness-runtime/process-authority";
import type { ServerPackageHost } from "@polyth/plugins";
import { checkedToolPath, createProjectToolRunner, discoverToolFiles, quoteToolArgument, resolveProjectToolScope } from "../src/projectTools.ts";

const scratch = resolve(import.meta.dirname, "../../../.scratch/docker-terraform");
async function fixture(t: TestContext) {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "tools-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("project tools reject valid foreign-Space IDs before touching files or execution", async () => {
  const foreign = { id: "foreign-project", path: "/foreign", name: "Foreign" };
  const host = { deployment: "local-trusted", projects: { get: async () => foreign }, forSpace: (space: { spaceId: string }) => {
    assert.equal(space.spaceId, "own-space");
    return { projects: { get: async () => undefined }, sessions: { snapshot: async () => { throw new Error("must not be used"); } } };
  } } as unknown as ServerPackageHost;
  await assert.rejects(resolveProjectToolScope(host, { spaceId: "own-space" } as never, { projectId: foreign.id }), { code: "not-found", message: "Workspace not found." });
});

test("scope honors secondary session checkouts and rejects a foreign session", async (t) => {
  const root = await fixture(t);
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  const project = { id: "own", name: "Own", path: root, primaryRepositoryId: "primary", repositories: [{ id: "primary", alias: "App", path: root }, { id: "secondary", alias: "Infra", path: checkout }] };
  const session = { id: "s1", projectId: "own", workspace: { executionRepositoryId: "secondary", repositories: [{ repositoryId: "secondary", path: checkout, state: "ready" }] } };
  const host = { deployment: "local-trusted", forSpace: () => ({ projects: { get: async () => project }, sessions: { snapshot: async (id: string) => id === "foreign" ? { ...session, projectId: "other" } : session } }) } as unknown as ServerPackageHost;
  const scope = await resolveProjectToolScope(host, {} as never, { projectId: "own", sessionId: "s1" });
  assert.equal(scope.root, checkout);
  assert.equal(scope.repositoryId, "secondary");
  await assert.rejects(resolveProjectToolScope(host, {} as never, { projectId: "own", sessionId: "foreign" }), { code: "not-found" });
  await assert.rejects(resolveProjectToolScope(host, {} as never, { projectId: "own", sessionId: "s1", repositoryId: "primary" }), { code: "not-found" });
  host.deployment = "server-trusted";
  await assert.rejects(resolveProjectToolScope(host, {} as never, { projectId: "own" }), { code: "unsupported" });
});

test("bounded discovery skips dependencies and symlinks; path checks reject escapes", async (t) => {
  const root = await fixture(t);
  const repo = join(root, "repo");
  await mkdir(join(repo, "infra"), { recursive: true });
  await mkdir(join(repo, "node_modules"));
  await writeFile(join(repo, "infra/main.tf"), "");
  await writeFile(join(repo, "node_modules/hidden.tf"), "");
  await writeFile(join(root, "outside.tf"), "");
  await symlink(join(root, "outside.tf"), join(repo, "escape.tf"));
  assert.deepEqual((await discoverToolFiles(repo, (name) => name.endsWith(".tf"))).files, ["infra/main.tf"]);
  for (const path of ["../outside.tf", "/outside.tf", "C:\\outside.tf", "escape.tf"]) await assert.rejects(checkedToolPath(repo, path), { code: "invalid-input" });
  assert.equal(await checkedToolPath(repo, "infra/main.tf"), join(repo, "infra/main.tf"));
  assert.equal(quoteToolArgument("a'$(printf stolen)"), "'a'\\''$(printf stolen)'");
  assert.throws(() => quoteToolArgument("%PATH%", "win32"), { code: "unsupported" });
});

function fakeAuthority(close: () => Promise<void> = async () => {}) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  let spawned = 0;
  const authority = { spawn: () => { spawned++; return child as unknown as ChildProcess; }, close } as unknown as HarnessProcessAuthority;
  return { child, authority, get spawned() { return spawned; } };
}

test("inspection releases its authority and never returns stderr", async () => {
  let closes = 0;
  const fake = fakeAuthority(async () => { closes++; });
  const runner = createProjectToolRunner({ authority: async () => fake.authority });
  runner.enable();
  const result = runner.run("docker", ["--version"], "/repo");
  await new Promise<void>((done) => setImmediate(done));
  fake.child.stdout.write("Docker 1"); fake.child.stderr.write("private-config-value"); fake.child.emit("close", 0);
  assert.deepEqual(await result, { stdout: "Docker 1", exitCode: 0 });
  assert.equal(closes, 1);
  await runner.stop();
  assert.equal(closes, 1);
});

test("timeout retains uncertain ownership until stop obtains release proof", async () => {
  let released = false;
  let closes = 0;
  const fake = fakeAuthority(async () => { closes++; if (!released) throw Object.assign(new Error("not released"), { code: "outcome-unknown" }); });
  const runner = createProjectToolRunner({ authority: async () => fake.authority, timeoutMs: 5 });
  runner.enable();
  let resourceCloses = 0;
  await assert.rejects(runner.run("terraform", ["version"], "/repo", { close: async () => { resourceCloses++; } }), { code: "outcome-unknown" });
  assert.equal(resourceCloses, 0, "an uncertain CLI still owns its pinned file");
  released = true;
  await runner.stop();
  assert.equal(closes, 2);
  assert.equal(resourceCloses, 1, "the pinned file closes only after proven CLI release");
  await assert.rejects(runner.run("terraform", [], "/repo"), { code: "unavailable" });
});

test("disable fences authority creation still in flight", async () => {
  const fake = fakeAuthority();
  let releaseCreation!: (authority: HarnessProcessAuthority) => void;
  const runner = createProjectToolRunner({ authority: () => new Promise((done) => { releaseCreation = done; }) });
  runner.enable();
  const pending = runner.run("docker", [], "/repo");
  await runner.stop();
  runner.enable();
  releaseCreation(fake.authority);
  await assert.rejects(pending, { code: "unavailable" });
  assert.equal(fake.spawned, 0);
  await runner.stop();
});

test("read-only beta refuses CLI execution before creating an authority", async () => {
  const before = process.env.POLYTH_AGENT_BETA;
  let created = false;
  const runner = createProjectToolRunner({ authority: async () => { created = true; return fakeAuthority().authority; } });
  runner.enable();
  process.env.POLYTH_AGENT_BETA = "1";
  try {
    await assert.rejects(runner.run("docker", ["--version"], "/repo"), { code: "unavailable", reason: "read-only-preview" });
    assert.equal(created, false);
  } finally {
    if (before === undefined) delete process.env.POLYTH_AGENT_BETA;
    else process.env.POLYTH_AGENT_BETA = before;
    await runner.stop();
  }
});

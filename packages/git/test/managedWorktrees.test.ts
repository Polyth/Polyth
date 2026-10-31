import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createGitService, type GitService } from "../src/index.ts";
import { createManagedWorktrees, isolateBranchName, isolateWorktreePath, isolateWorktreePaths, readManagedMarker } from "../src/managedWorktrees.ts";

const git = createGitService();
const run = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
function repo(t: { after(fn: () => void): void }) {
  const parent = mkdtempSync(join(tmpdir(), "polyth-managed-test-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "repo");
  mkdirSync(root);
  run(root, "init", "-qb", "main");
  run(root, "config", "user.name", "Test");
  run(root, "config", "user.email", "test@example.com");
  run(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "file"), "base\n");
  run(root, "add", ".");
  run(root, "commit", "-qm", "base");
  return root;
}

for (const failure of ["git-dir", "marker-write", "rev-parse"] as const) {
  test(`managed creation rolls back after ${failure} failure`, async (t) => {
    const root = repo(t);
    const sessionId = randomUUID();
    const fake: GitService = {
      ...git,
      async gitDir(path) {
        if (failure === "git-dir") throw new Error("injected git-dir failure");
        if (failure === "marker-write") return join(root, "does-not-exist");
        return git.gitDir(path);
      },
      async revParse(path, ref) {
        if (failure === "rev-parse" && path !== root) throw new Error("injected rev-parse failure");
        return git.revParse(path, ref);
      },
    };
    await assert.rejects(createManagedWorktrees(fake).create({ root, sessionId, targetPath: root, targetBranch: "main" }));
    assert.equal(existsSync(isolateWorktreePath(root, sessionId)), false);
    assert.equal((await git.worktrees.list(root)).length, 1);
    assert.equal((await git.branches(root)).branches.some((b) => b.name === isolateBranchName(sessionId)), false);
  });
}

test("integration marker failure rolls back exact detached workspace", async (t) => {
  const root = repo(t);
  const fake = { ...git, async gitDir() { return join(root, "missing-admin"); } };
  await assert.rejects(createManagedWorktrees(fake).createIntegrationWorkspace({ root, sessionId: randomUUID(), startPoint: "main" }));
  assert.equal((await git.worktrees.list(root)).length, 1);
});

test("rollback failure preserves resource and logs its exact creation receipt", async (t) => {
  const root = repo(t);
  const sessionId = randomUUID();
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (value) => logs.push(String(value));
  try {
    const fake: GitService = {
      ...git,
      async gitDir() { throw new Error("marker failure"); },
      worktrees: { ...git.worktrees, async remove() { throw new Error("rollback blocked"); } },
    };
    await assert.rejects(createManagedWorktrees(fake).create({ root, sessionId, targetPath: root, targetBranch: "main" }), /marker failure/);
    assert.equal(existsSync(isolateWorktreePath(root, sessionId)), true);
    assert.ok(logs.some((line) => line.includes("creation-rollback-failed") && line.includes(sessionId) && line.includes(isolateBranchName(sessionId))));
  } finally { console.log = oldLog; }
});

test("managed creation never adopts a preexisting branch or directory", async (t) => {
  const root = repo(t);
  const managed = createManagedWorktrees(git);
  const sessionId = randomUUID();
  const branch = isolateBranchName(sessionId);
  run(root, "branch", branch);
  await assert.rejects(managed.create({ root, sessionId, targetPath: root, targetBranch: "main" }), /already exists/);
  assert.equal(run(root, "rev-parse", branch), run(root, "rev-parse", "main"));
  const directorySessionId = randomUUID();
  const path = isolateWorktreePath(root, directorySessionId);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "user-data"), "keep");
  await assert.rejects(managed.create({ root, sessionId: directorySessionId, targetPath: root, targetBranch: "main" }), /path already exists/);
  assert.equal(readFileSync(join(path, "user-data"), "utf8"), "keep");
});

for (const damage of ["other-session", "other-branch", "missing", "corrupt", "null", "unknown-kind", "detached"] as const) {
  test(`ownership inspection and deletion fail closed for ${damage} marker/source`, async (t) => {
    const root = repo(t);
    const managed = createManagedWorktrees(git);
    const sessionId = randomUUID();
    const wt = await managed.create({ root, sessionId, targetPath: root, targetBranch: "main" });
    const markerPath = join(await git.gitDir(wt.path), "polyth-managed.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (damage === "other-session") marker.sessionId = randomUUID();
    if (damage === "other-branch") marker.worktreeBranch = "main";
    if (damage === "unknown-kind") marker.kind = "unknown";
    if (damage === "missing") rmSync(markerPath);
    else if (damage === "corrupt") writeFileSync(markerPath, "{");
    else if (damage === "null") writeFileSync(markerPath, "null");
    else writeFileSync(markerPath, JSON.stringify(marker));
    if (damage === "detached") run(wt.path, "checkout", "--detach");
    const ref = { sessionId, worktreePath: wt.path, worktreeBranch: wt.branch };
    assert.equal((await managed.inspectOwned(root, ref)).status, "unowned");
    assert.equal((await managed.removeOwned(root, ref)).status, "unowned");
    assert.equal(existsSync(wt.path), true);
  });
}

test("origin mismatch and another session's worktree cannot satisfy ownership", async (t) => {
  const root = repo(t);
  const managed = createManagedWorktrees(git);
  const sessionId = randomUUID();
  const wt = await managed.create({ root, sessionId, targetPath: root, targetBranch: "main" });
  const ref = { sessionId, worktreePath: wt.path, worktreeBranch: wt.branch };
  assert.equal((await managed.inspectOwned(root, { ...ref, targetBranch: "wrong" })).status, "unowned");
  assert.equal((await managed.inspectOwned(root, { ...ref, sessionId: randomUUID() })).status, "unowned");
  assert.equal((await managed.inspectOwned(root, { ...ref, targetPath: root, targetBranch: "main", baseCommit: wt.head })).status, "owned");
});

test("absent source is not authority to delete a branch or other worktree", async (t) => {
  const root = repo(t);
  const managed = createManagedWorktrees(git);
  const sessionId = randomUUID();
  const wt = await managed.create({ root, sessionId, targetPath: root, targetBranch: "main" });
  await git.worktrees.remove(root, { path: wt.path });
  const result = await managed.removeOwned(root, { sessionId, worktreePath: wt.path, worktreeBranch: wt.branch });
  assert.equal(result.status, "already-gone");
  assert.equal(run(root, "rev-parse", wt.branch), wt.head);
});

test("integration cleanup requires marker, session, and detached identity and never falls back to rm", async (t) => {
  const root = repo(t);
  const managed = createManagedWorktrees(git);
  const sessionId = randomUUID();
  const path = await managed.createIntegrationWorkspace({ root, sessionId, startPoint: "main" });
  await assert.rejects(managed.discardIntegration(root, path, randomUUID()), /unowned/);
  assert.equal(existsSync(path), true);
  const fake = createManagedWorktrees({ ...git, worktrees: { ...git.worktrees, async remove() { throw new Error("remove blocked"); } } });
  await assert.rejects(fake.discardIntegration(root, path, sessionId), /remove blocked/);
  assert.equal(existsSync(path), true);
  const markerPath = join(await git.gitDir(path), "polyth-managed.json");
  writeFileSync(markerPath, "null");
  assert.equal(await readManagedMarker(git, path), "corrupt");
  await assert.rejects(managed.discardIntegration(root, path, sessionId), /unowned/);
  assert.equal(existsSync(path), true);
});

test("managed creation rejects nested origins", async (t) => {
  const root = repo(t);
  await assert.rejects(createManagedWorktrees(git).create({ root, sessionId: randomUUID(), targetPath: root, targetBranch: "polyth/isolate/abc" }), /nested/);
});

test("managed branch rewritten to unrelated history loses source authority", async (t) => {
  const root = repo(t);
  const sessionId = randomUUID();
  const managed = createManagedWorktrees(git);
  const wt = await managed.create({ root, sessionId, targetPath: root, targetBranch: "main" });
  const tree = run(root, "rev-parse", "HEAD^{tree}");
  const unrelated = execFileSync("git", ["commit-tree", tree], { cwd: root, input: "unrelated\n" }).toString().trim();
  run(wt.path, "reset", "--hard", unrelated);
  const ref = { sessionId, worktreePath: wt.path, worktreeBranch: wt.branch };
  assert.equal((await managed.inspectOwned(root, ref)).status, "unowned");
  assert.equal((await managed.removeOwned(root, ref)).status, "unowned");
  assert.equal(run(wt.path, "rev-parse", "HEAD"), unrelated);
});

test("cleanup cannot delete a branch replaced after worktree removal", async (t) => {
  const root = repo(t);
  const sessionId = randomUUID();
  const wt = await createManagedWorktrees(git).create({ root, sessionId, targetPath: root, targetBranch: "main" });
  const tree = run(root, "rev-parse", "HEAD^{tree}");
  const replacement = execFileSync("git", ["commit-tree", tree], { cwd: root, input: "replacement\n" }).toString().trim();
  const managed = createManagedWorktrees({
    ...git,
    worktrees: {
      ...git.worktrees,
      async remove(repoRoot, input) {
        const result = await git.worktrees.remove(repoRoot, input);
        run(root, "update-ref", `refs/heads/${wt.branch}`, replacement);
        return result;
      },
    },
  });
  await assert.rejects(managed.removeOwned(root, { sessionId, worktreePath: wt.path, worktreeBranch: wt.branch }), /branch cleanup failed/);
  assert.equal(run(root, "rev-parse", wt.branch), replacement);
});

test("managed creation rolls back a successfully created worktree after a lost response", async (t) => {
  const root = repo(t);
  const sessionId = randomUUID();
  const fake: GitService = {
    ...git,
    worktrees: {
      ...git.worktrees,
      async create(repoRoot, input) {
        await git.worktrees.create(repoRoot, input);
        throw new Error("creation response lost");
      },
    },
  };
  await assert.rejects(createManagedWorktrees(fake).create({ root, sessionId, targetPath: root, targetBranch: "main" }), /response lost/);
  assert.equal(existsSync(isolateWorktreePath(root, sessionId)), false);
  assert.equal((await git.worktrees.list(root)).length, 1);
  assert.equal(await git.readRef(root, `refs/heads/${isolateBranchName(sessionId)}`), null);
});

test("integration creation rolls back a successfully created detached workspace after a lost response", async (t) => {
  const root = repo(t);
  let path = "";
  const fake: GitService = {
    ...git,
    worktrees: {
      ...git.worktrees,
      async addDetached(repoRoot, createdPath, startPoint) {
        path = createdPath;
        await git.worktrees.addDetached(repoRoot, createdPath, startPoint);
        throw new Error("detached creation response lost");
      },
    },
  };
  await assert.rejects(createManagedWorktrees(fake).createIntegrationWorkspace({ root, sessionId: randomUUID(), startPoint: "main" }), /response lost/);
  assert.ok(path);
  assert.equal(existsSync(path), false);
  assert.equal((await git.worktrees.list(root)).length, 1);
});

test("lost creation response with changed identity preserves the worktree and branch", async (t) => {
  const root = repo(t);
  const sessionId = randomUUID();
  const fake: GitService = {
    ...git,
    worktrees: {
      ...git.worktrees,
      async create(repoRoot, input) {
        const created = await git.worktrees.create(repoRoot, input);
        writeFileSync(join(created.path, "user-file"), "preserve\n");
        run(created.path, "add", "user-file");
        run(created.path, "commit", "-qm", "new owner state");
        throw new Error("response lost after identity changed");
      },
    },
  };
  await assert.rejects(createManagedWorktrees(fake).create({ root, sessionId, targetPath: root, targetBranch: "main" }), /identity changed/);
  assert.equal(readFileSync(join(isolateWorktreePath(root, sessionId), "user-file"), "utf8"), "preserve\n");
  assert.notEqual(await git.readRef(root, `refs/heads/${isolateBranchName(sessionId)}`), await git.revParse(root, "main"));
});

test("failed creation with only a branch preserves the ambiguous ref and records its identity", async (t) => {
  const root = repo(t);
  const sessionId = randomUUID();
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (value) => logs.push(String(value));
  try {
    const fake: GitService = {
      ...git,
      worktrees: {
        ...git.worktrees,
        async create(repoRoot, input) {
          run(repoRoot, "branch", input.branch, input.base!);
          throw new Error("checkout creation failed");
        },
      },
    };
    await assert.rejects(createManagedWorktrees(fake).create({ root, sessionId, targetPath: root, targetBranch: "main" }), /creation failed/);
    assert.equal((await git.worktrees.list(root)).length, 1);
    assert.equal(await git.readRef(root, `refs/heads/${isolateBranchName(sessionId)}`), await git.revParse(root, "main"));
    assert.ok(logs.some((line) => line.includes("creation-rollback-failed") && line.includes(sessionId) && line.includes(isolateBranchName(sessionId))));
  } finally { console.log = oldLog; }
});


for (const aliasedParent of ["repository-parent", "managed-parent"] as const) {
  test(`managed creation rejects ${aliasedParent} symlinks before Git resource creation`, async (t) => {
    const root = repo(t);
    const sessionId = randomUUID();
    let requestedRoot = root;
    if (aliasedParent === "repository-parent") {
      const alias = `${dirname(root)}-alias`;
      symlinkSync(dirname(root), alias, "dir");
      t.after(() => rmSync(alias));
      requestedRoot = join(alias, "repo");
    } else {
      const destination = join(dirname(root), "owned-target");
      mkdirSync(destination);
      symlinkSync(destination, dirname(isolateWorktreePath(root, sessionId)), "dir");
    }
    let creations = 0;
    const fake: GitService = { ...git, worktrees: { ...git.worktrees,
      async create(...args) { creations += 1; return git.worktrees.create(...args); },
    } };
    await assert.rejects(createManagedWorktrees(fake).create({ root: requestedRoot, sessionId, targetPath: requestedRoot, targetBranch: "main" }), /canonical filesystem path/);
    assert.equal(creations, 0);
    assert.equal((await git.worktrees.list(root)).length, 1);
    assert.equal(await git.readRef(root, `refs/heads/${isolateBranchName(sessionId)}`), null);
  });
}

test("integration creation rejects a symlinked repository parent before Git creation", async (t) => {
  const root = repo(t);
  const alias = `${dirname(root)}-alias`;
  symlinkSync(dirname(root), alias, "dir");
  t.after(() => rmSync(alias));
  let creations = 0;
  const fake: GitService = { ...git, worktrees: { ...git.worktrees,
    async addDetached(...args) { creations += 1; return git.worktrees.addDetached(...args); },
  } };
  await assert.rejects(createManagedWorktrees(fake).createIntegrationWorkspace({ root: join(alias, "repo"), sessionId: randomUUID(), startPoint: "main" }), /canonical filesystem path/);
  assert.equal(creations, 0);
  assert.equal((await git.worktrees.list(root)).length, 1);
});

test("a repository under a read-only parent uses the per-user managed folder", {
  skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false,
}, async (t) => {
  const root = repo(t);
  const fallback = mkdtempSync(join(tmpdir(), "polyth-managed-fallback-"));
  const previous = process.env.POLYTH_MANAGED_WORKTREES_DIR;
  process.env.POLYTH_MANAGED_WORKTREES_DIR = fallback;
  t.after(() => {
    if (previous === undefined) delete process.env.POLYTH_MANAGED_WORKTREES_DIR;
    else process.env.POLYTH_MANAGED_WORKTREES_DIR = previous;
    rmSync(fallback, { recursive: true, force: true });
  });
  const managed = createManagedWorktrees(git);
  const sessionId = randomUUID();
  chmodSync(dirname(root), 0o555);
  try {
    const created = await managed.create({ root, sessionId, targetPath: root, targetBranch: "main" });
    const expected = isolateWorktreePaths(root, sessionId)[1]!;
    assert.equal(created.path, expected);
    assert.ok(expected.startsWith(realpathSync(fallback)));
    assert.equal(existsSync(isolateWorktreePath(root, sessionId)), false);
    const integration = await managed.createIntegrationWorkspace({ root, sessionId, startPoint: "main" });
    assert.ok(integration.startsWith(realpathSync(fallback)));

    const ref = { sessionId, worktreePath: created.path, worktreeBranch: created.branch, targetPath: root, targetBranch: "main" };
    assert.equal((await managed.inspectOwned(root, ref)).status, "owned");
    // Another repository's fallback folder never satisfies this session's ownership.
    const foreign = { ...ref, worktreePath: join(dirname(dirname(created.path)), "other-polyth-isolate", basename(created.path)) };
    assert.equal((await managed.inspectOwned(root, foreign)).status, "unowned");

    await managed.discardIntegration(root, integration, sessionId);
    assert.deepEqual(await managed.removeOwned(root, ref), { status: "removed" });
    await managed.pruneEmptyParents(root);
    assert.equal(existsSync(dirname(created.path)), false);
    assert.equal(existsSync(dirname(integration)), false);
    assert.equal((await git.worktrees.list(root)).length, 1);
  } finally {
    chmodSync(dirname(root), 0o755);
  }
});

test("a project registered at a repository subdirectory places its checkouts outside the working tree", async (t) => {
  const root = repo(t);
  const project = join(root, "packages", "app");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "index.ts"), "export {};\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "\n");
  run(root, "add", ".");
  run(root, "commit", "-qm", "app");
  const managed = createManagedWorktrees(git);
  const sessionId = randomUUID();

  const created = await managed.create({ root: project, sessionId, targetPath: project, targetBranch: "main" });
  assert.equal(created.path, isolateWorktreePath(root, sessionId), "sibling of the repository, not of the subdirectory");
  assert.equal(existsSync(join(project, "..", "app-polyth-isolate")), false);
  assert.equal(run(root, "status", "--porcelain"), "", "nothing is nested inside the user's working tree");
  // Inheritance reads the repository root, so the root dependency folder lands at the checkout root.
  assert.equal(existsSync(join(created.path, "node_modules", "dep")), true);
  const integration = await managed.createIntegrationWorkspace({ root: project, sessionId, startPoint: "main" });
  assert.equal(dirname(integration), `${root}-polyth-integrate`);

  const ref = { sessionId, worktreePath: created.path, worktreeBranch: created.branch, targetPath: project, targetBranch: "main" };
  assert.equal((await managed.inspectOwned(project, ref)).status, "owned");
  await managed.discardIntegration(project, integration, sessionId);
  assert.deepEqual(await managed.removeOwned(project, ref), { status: "removed" });
  assert.equal(existsSync(dirname(created.path)), false);
  assert.equal(existsSync(dirname(integration)), false);
  assert.equal((await git.worktrees.list(root)).length, 1);
});

test("a subdirectory project's checkout made before placement moved stays owned and removable", async (t) => {
  const root = repo(t);
  const project = join(root, "packages", "app");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "index.ts"), "export {};\n");
  run(root, "add", ".");
  run(root, "commit", "-qm", "app");
  // The old placement keyed folders by the subdirectory itself; reproduce it
  // with an inventory failure on the first lookup (the anchor falls back).
  let lookups = 0;
  const legacyGit: GitService = {
    ...git,
    worktrees: {
      ...git.worktrees,
      async list(path) {
        lookups += 1;
        if (lookups === 1) throw new Error("injected inventory failure");
        return git.worktrees.list(path);
      },
    },
  };
  const sessionId = randomUUID();
  const created = await createManagedWorktrees(legacyGit).create({ root: project, sessionId, targetPath: project, targetBranch: "main" });
  assert.equal(created.path, join(`${project}-polyth-isolate`, basename(created.path)));

  const managed = createManagedWorktrees(git);
  const ref = { sessionId, worktreePath: created.path, worktreeBranch: created.branch, targetPath: project, targetBranch: "main" };
  assert.equal((await managed.inspectOwned(project, ref)).status, "owned");
  assert.deepEqual(await managed.removeOwned(project, ref), { status: "removed" });
  assert.equal(existsSync(`${project}-polyth-isolate`), false);
  assert.equal(run(root, "status", "--porcelain"), "");
});

const receiptsDir = (root: string) => join(root, ".git", "polyth", "creation-receipts");
const receipts = (root: string): string[] =>
  existsSync(receiptsDir(root)) ? readdirSync(receiptsDir(root)).filter((name) => name.endsWith(".json")) : [];

/** Age every creation receipt past the in-flight floor. */
function ageReceipts(root: string): string[] {
  const directory = receiptsDir(root);
  const names = receipts(root);
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  for (const name of names) utimesSync(join(directory, name), old, old);
  return names;
}

test("two creates for one session never destroy the winner's checkout", async (t) => {
  const root = repo(t);
  const managed = createManagedWorktrees(git);
  for (let round = 0; round < 3; round += 1) {
    const sessionId = randomUUID();
    const input = { root, sessionId, targetPath: root, targetBranch: "main" };
    const results = await Promise.allSettled([managed.create(input), managed.create(input)]);
    const won = results.filter((item) => item.status === "fulfilled");
    assert.equal(won.length, 1, `round ${round}`);
    for (const item of results) {
      if (item.status === "rejected") assert.equal((item.reason as { code?: string }).code, "conflict");
    }
    const path = (won[0] as PromiseFulfilledResult<{ path: string }>).value.path;
    assert.equal(existsSync(path), true, "the winner's checkout survives");
    assert.equal((await managed.inspectOwned(root, { sessionId, worktreePath: path, worktreeBranch: isolateBranchName(sessionId) })).status, "owned");
  }
  assert.deepEqual(receipts(root), []);
});

for (const kind of ["isolate", "integration"] as const) {
  test(`${kind === "isolate" ? "an isolate" : "an integration"} create that died between git worktree add and its token is reclaimed once stale`, async (t) => {
    const root = repo(t);
    const sessionId = randomUUID();
    // The process "dies" right after Git made the checkout: nothing after it runs.
    const never = new Promise<never>(() => undefined);
    const fake: GitService = {
      ...git,
      worktrees: {
        ...git.worktrees,
        async create(repoRoot, input) { await git.worktrees.create(repoRoot, input); return never; },
        async addDetached(repoRoot, path, startPoint) { await git.worktrees.addDetached(repoRoot, path, startPoint); return never; },
      },
    };
    const dead = createManagedWorktrees(fake);
    void (kind === "isolate"
      ? dead.create({ root, sessionId, targetPath: root, targetBranch: "main" })
      : dead.createIntegrationWorkspace({ root, sessionId, startPoint: "main" }));
    while ((await git.worktrees.list(root)).length < 2) await new Promise((done) => setTimeout(done, 10));

    const managed = createManagedWorktrees(git);
    assert.equal(await managed.recoverCreations(root), 0, "a fresh planned create may still be running");
    assert.equal((await git.worktrees.list(root)).length, 2);
    assert.equal(ageReceipts(root).length, 1);
    assert.equal(await managed.recoverCreations(root), 1);
    assert.equal((await git.worktrees.list(root)).length, 1);
    assert.equal(await git.readRef(root, `refs/heads/${isolateBranchName(sessionId)}`), null);
    assert.deepEqual(receipts(root), []);
    assert.equal(existsSync(`${root}-polyth-isolate`) || existsSync(`${root}-polyth-integrate`), false);
    if (kind === "isolate") await managed.create({ root, sessionId, targetPath: root, targetBranch: "main" });
  });
}

test("a stale planned claim does not block the session's next create", async (t) => {
  const root = repo(t);
  const sessionId = randomUUID();
  // The process died after claiming, before Git made anything.
  const fake: GitService = { ...git, worktrees: { ...git.worktrees, create: () => new Promise<never>(() => undefined) } };
  void createManagedWorktrees(fake).create({ root, sessionId, targetPath: root, targetBranch: "main" });
  while (receipts(root).length === 0) await new Promise((done) => setTimeout(done, 10));
  const managed = createManagedWorktrees(git);
  await assert.rejects(managed.create({ root, sessionId, targetPath: root, targetBranch: "main" }), { code: "conflict" });
  ageReceipts(root);
  const created = await managed.create({ root, sessionId, targetPath: root, targetBranch: "main" });
  assert.equal(existsSync(created.path), true);
});

for (const removal of ["folder deleted", "git worktree remove"] as const) {
  test(`a checkout removed outside Polyth (${removal}) releases its untouched branch but keeps unmerged work`, async (t) => {
    const root = repo(t);
    const managed = createManagedWorktrees(git);
    const remove = (path: string) => removal === "folder deleted"
      ? rmSync(path, { recursive: true, force: true })
      : run(root, "worktree", "remove", "--force", path);

    const sessionId = randomUUID();
    const wt = await managed.create({ root, sessionId, targetPath: root, targetBranch: "main" });
    const ref = { sessionId, worktreePath: wt.path, worktreeBranch: wt.branch, targetPath: root, targetBranch: "main", baseCommit: wt.head };
    remove(wt.path);
    assert.deepEqual(await managed.removeOwned(root, ref), { status: "already-gone" });
    assert.equal(await git.readRef(root, `refs/heads/${wt.branch}`), null);
    assert.equal((await git.worktrees.list(root)).length, 1, "Git's stale entry is pruned");
    await managed.create({ root, sessionId, targetPath: root, targetBranch: "main" });

    const busy = randomUUID();
    const work = await managed.create({ root, sessionId: busy, targetPath: root, targetBranch: "main" });
    writeFileSync(join(work.path, "work"), "unmerged\n");
    run(work.path, "add", "work");
    run(work.path, "commit", "-qm", "work");
    const tip = run(work.path, "rev-parse", "HEAD");
    remove(work.path);
    assert.deepEqual(await managed.removeOwned(root, { sessionId: busy, worktreePath: work.path, worktreeBranch: work.branch, targetPath: root, targetBranch: "main", baseCommit: work.head }), { status: "already-gone" });
    assert.equal(run(root, "rev-parse", work.branch), tip, "the branch is the only copy of that work");
  });
}

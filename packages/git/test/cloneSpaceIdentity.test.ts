import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectService, SessionService, SpaceContext } from "@polyth/contracts";
import type { SourceControlProfile, SourceControlProfileState } from "@polyth/contracts/source-control";
import { gitRoutes } from "../src/serverEntry.ts";
import type { GitService } from "../src/index.ts";

const space = (role: SpaceContext["role"] = "owner"): SpaceContext => ({
  spaceId: "s1", spaceSlug: "s1", userId: "u1", role, deployment: "local-trusted", storageDir: "/unused",
});

/** A `git` stand-in that records the clone invocation and creates a real
 * repository at the target, so repository config writes still work. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "polyth-clone-identity-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  const key = join(home, ".ssh", "id_alice");
  writeFileSync(key, "private");
  writeFileSync(`${key}.pub`, "ssh-ed25519 AAAA alice@example");
  const parent = join(root, "projects");
  mkdirSync(parent);
  const log = join(root, "git.log");
  const fakeGit = join(root, "fake-git");
  writeFileSync(fakeGit, [
    "#!/bin/sh",
    // Only the clone is faked; every other call (the identity's
    // `config --local core.sshCommand …`) reaches the real Git, or the last
    // argument would be `git init`ed as a directory in the cwd.
    "if [ \"$1\" = clone ]; then",
    `  printf '%s\\n' "$*" > '${log}'`,
    `  printf '%s\\n' "$GIT_SSH_COMMAND" >> '${log}'`,
    "  for last; do :; done",
    "  exec git init -q \"$last\"",
    "fi",
    "exec git \"$@\"",
    "",
  ].join("\n"));
  chmodSync(fakeGit, 0o755);
  return { root, home, key, parent, log, fakeGit };
}

const profile = (extra: Partial<SourceControlProfile> & Pick<SourceControlProfile, "id">): SourceControlProfile => ({
  label: extra.id, provider: "github", authentication: { mode: "system-git" }, ...extra,
});

function harness(f: ReturnType<typeof fixture>, options: {
  role?: SpaceContext["role"];
  profiles?: SourceControlProfile[];
  add?: (path: string, name?: string) => Promise<unknown>;
} = {}) {
  const added: Array<{ spaceId: string; path: string; name?: string }> = [];
  const state: SourceControlProfileState = {
    profiles: options.profiles ?? [], globalDefaultProfileId: null, repositoryProfileIds: {}, repositorySystemIdentities: {},
  };
  const routes = gitRoutes({
    // The package host's unscoped service refuses to create projects.
    projects: new Proxy({}, {
      get: () => () => { throw Object.assign(new Error("package project creation requires an explicit Space context"), { code: "unavailable" }); },
    }) as ProjectService,
    scopedProjects: (ctx) => ({
      get: async () => undefined,
      add: async (path: string, name?: string) => {
        if (options.add) await options.add(path, name);
        added.push({ spaceId: ctx.spaceId, path, ...(name ? { name } : {}) });
        return { id: "cloned", name: name ?? "repo", path };
      },
    }) as unknown as ProjectService,
    sessions: {} as SessionService,
    git: {} as GitService,
    commitMessage: async () => "",
    profiles: { read: () => ({ state }) },
    sshHome: f.home,
  });
  const clone = async (body: Record<string, unknown>) => {
    let payload: unknown;
    await routes({
      req: {}, res: {}, space: space(options.role), url: new URL("http://x/api/projects/clone"), path: "/api/projects/clone", method: "POST",
      body: async () => ({ parentPath: f.parent, ...body }), json: (_status: number, data: unknown) => { payload = data; },
    } as never);
    return payload as { id: string; path: string };
  };
  return { clone, added };
}

async function withFakeGit<T>(f: ReturnType<typeof fixture>, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.POLYTH_GIT_BIN;
  process.env.POLYTH_GIT_BIN = f.fakeGit;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.POLYTH_GIT_BIN;
    else process.env.POLYTH_GIT_BIN = previous;
  }
}

test("a clone registers its project in the caller's Space, not through the unscoped package service", async () => {
  const f = fixture();
  try {
    const h = harness(f);
    const project = await withFakeGit(f, () => h.clone({ repository: "https://github.com/o/repo.git" }));
    assert.equal(project.id, "cloned");
    assert.deepEqual(h.added, [{ spaceId: "s1", path: join(f.parent, "repo"), name: "repo" }]);
    assert.equal(readFileSync(f.log, "utf8").split("\n")[1], "", "no SSH command without an identity");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a clone whose registration fails leaves no checkout behind, so it can be retried", async () => {
  const f = fixture();
  try {
    let fail = true;
    const h = harness(f, { add: async () => { if (fail) throw Object.assign(new Error("refused"), { code: "conflict" }); } });
    await assert.rejects(withFakeGit(f, () => h.clone({ repository: "https://github.com/o/repo.git" })), { message: "refused" });
    assert.deepEqual(readdirSync(f.parent), []);
    fail = false;
    assert.equal((await withFakeGit(f, () => h.clone({ repository: "https://github.com/o/repo.git" }))).id, "cloned");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("an SSH-key identity clones the HTTPS repository over SSH with its key and keeps the key for push", async () => {
  const f = fixture();
  try {
    const h = harness(f, {
      profiles: [profile({ id: "alice", username: "alice", authentication: { mode: "ssh-key", identityFile: f.key } })],
    });
    const project = await withFakeGit(f, () => h.clone({ repository: "https://github.com/o/repo.git", identity: { profileId: "alice" } }));
    const [args, sshCommand] = readFileSync(f.log, "utf8").split("\n");
    assert.equal(args, `clone -- git@github.com:o/repo.git ${join(f.parent, "repo")}`);
    assert.match(sshCommand!, new RegExp(`^ssh -i ${f.key} -o IdentitiesOnly=yes -o BatchMode=yes `));
    assert.equal(
      execFileSync("git", ["-C", project.path, "config", "--local", "--get", "core.sshCommand"], { encoding: "utf8" }).trim(),
      `ssh -i ${f.key} -o IdentitiesOnly=yes`,
      "fetch, pull and push keep signing in with the identity's key",
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("an identity is refused for members, accounts, keyless or foreign-host profiles before touching the disk", async () => {
  const f = fixture();
  try {
    const profiles = [
      profile({ id: "alice", authentication: { mode: "ssh-key", identityFile: f.key } }),
      profile({ id: "plain" }),
      profile({ id: "lab", provider: "gitlab", authentication: { mode: "ssh-key", identityFile: f.key } }),
    ];
    const repository = "https://github.com/o/repo.git";
    await withFakeGit(f, async () => {
      await assert.rejects(harness(f, { role: "member", profiles }).clone({ repository, identity: { profileId: "alice" } }), { code: "permission-denied" });
      const h = harness(f, { profiles });
      await assert.rejects(h.clone({ repository, identity: { profileId: "alice" }, account: { provider: "github", accountId: "x" } }), { code: "invalid-input" });
      await assert.rejects(h.clone({ repository, identity: { profileId: "plain" } }), { code: "invalid-input" });
      await assert.rejects(h.clone({ repository, identity: { profileId: "lab" } }), { code: "account-not-applicable" });
      await assert.rejects(h.clone({ repository, identity: { profileId: "missing" } }), { code: "not-found" });
      await assert.rejects(h.clone({ repository, identity: {} }), { code: "invalid-input" });
    });
    assert.deepEqual(readdirSync(f.parent), []);
    assert.equal(existsSync(f.log), false, "git never ran");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

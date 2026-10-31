// A project's Git identity: profile fields (signing key, hosting account,
// account/anonymous sign-in), the checkout config Polyth writes for them, and
// whose identity Polyth-made commits carry.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSourceControlProfile, type SourceControlProfileState } from "@polyth/contracts/source-control";
import {
  ANONYMOUS_SSH_COMMAND,
  applyAnonymous,
  applySigningKey,
  applySshKey,
  getAnonymous,
  getSigningKey,
  getSshKey,
  normalizeProfileState,
  validateSigningKey,
} from "../src/sourceControlProfilesStore.ts";
import { resolveGitCommitIdentity, type GitActor } from "../src/actingPerson.ts";
import { gitTransportInvocation, withGitCommitIdentity } from "../src/sourceControlAccounts.ts";
import { projectCommitIdentity } from "../src/serverEntry.ts";
import { parseSourceControlProfileState } from "../widgets/sourceControlProfiles.ts";

const config = (repo: string, key: string): string | null => {
  try { return execFileSync("git", ["-C", repo, "config", "--local", "--get", key], { encoding: "utf8" }).trim(); } catch { return null; }
};

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "git-project-identity-"));
  const home = join(root, "home"), ssh = join(home, ".ssh");
  mkdirSync(ssh, { recursive: true });
  writeFileSync(join(ssh, "id_a"), "k");
  writeFileSync(join(ssh, "id_a.pub"), "ssh-ed25519 AAAA me@host\n");
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  return { root, home, ssh, repo };
};

const account = { provider: "github", accountId: "gh-1", login: "octo", origin: "https://github.com" };

test("profiles keep a signing key, a hosting account and account/anonymous sign-in", () => {
  const { root, home, ssh } = fixture();
  try {
    const pub = join(ssh, "id_a.pub");
    assert.equal(validateSigningKey(pub, home), pub);
    for (const bad of [join(ssh, "id_a"), join(root, "x.pub"), "rel.pub", "-x.pub"]) {
      assert.throws(() => validateSigningKey(bad, home), (e: { code?: string }) => e.code === "invalid-input", bad);
    }
    const state = normalizeProfileState({
      profiles: [
        { id: "a", label: "Work", provider: "github", signingKey: pub, hostingAccount: account, authentication: { mode: "account" } },
        { id: "b", label: "Public", authentication: { mode: "anonymous" } },
        { id: "c", label: "No account", hostingAccount: { provider: "github" }, authentication: { mode: "account" } },
      ],
    }, home);
    assert.equal(state.profiles[0]!.signingKey, pub);
    assert.deepEqual(state.profiles[0]!.hostingAccount, account);
    assert.equal(state.profiles[0]!.authentication.mode, "account");
    assert.equal(state.profiles[1]!.authentication.mode, "anonymous");
    assert.equal(state.profiles[2]!.hostingAccount, undefined, "an incomplete account reference is dropped");
    assert.equal(state.profiles[2]!.authentication.mode, "system-git", "account sign-in without an account is System Git");
    assert.throws(() => normalizeProfileState({ profiles: [{ id: "x", label: "X", signingKey: join(ssh, "id_a"), authentication: {} }] }, home), /public key/);

    // The browser cache parses the same fields.
    const client = parseSourceControlProfileState(JSON.stringify(state));
    assert.deepEqual(client.profiles, state.profiles);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("signing and anonymous config is applied and removed without touching hand-made setup", async () => {
  const { root, home, ssh, repo } = fixture();
  try {
    const pub = join(ssh, "id_a.pub");
    await applySigningKey(repo, pub, home);
    assert.equal(await getSigningKey(repo), pub);
    assert.equal(config(repo, "gpg.format"), "ssh");
    assert.equal(config(repo, "commit.gpgsign"), "true");
    await applySigningKey(repo, undefined, home);
    assert.equal(await getSigningKey(repo), pub, "undefined leaves signing alone");
    await applySigningKey(repo, null, home);
    assert.equal(await getSigningKey(repo), null);
    assert.equal(config(repo, "gpg.format"), null);
    assert.equal(config(repo, "commit.gpgsign"), null);

    // A signing setup the person made by hand is not Polyth's to remove.
    execFileSync("git", ["-C", repo, "config", "user.signingkey", "/mine.pub"]);
    execFileSync("git", ["-C", repo, "config", "commit.gpgsign", "true"]);
    await applySigningKey(repo, null, home);
    assert.equal(config(repo, "user.signingkey"), "/mine.pub");
    assert.equal(await getSigningKey(repo), null);
    execFileSync("git", ["-C", repo, "config", "--unset", "user.signingkey"]);
    execFileSync("git", ["-C", repo, "config", "--unset", "commit.gpgsign"]);

    await applyAnonymous(repo, true);
    assert.equal(await getAnonymous(repo), true);
    assert.equal(config(repo, "core.sshCommand"), ANONYMOUS_SSH_COMMAND);
    assert.equal(config(repo, "credential.helper"), "");
    assert.equal(await getSshKey(repo), null, "anonymous is not an SSH key");
    await applyAnonymous(repo, false);
    assert.equal(await getAnonymous(repo), false);
    assert.equal(config(repo, "core.sshCommand"), null);
    assert.equal(config(repo, "credential.helper"), null);

    // Turning anonymous off never removes a credential helper Polyth did not set.
    execFileSync("git", ["-C", repo, "config", "credential.helper", "store"]);
    await applyAnonymous(repo, false);
    assert.equal(config(repo, "credential.helper"), "store");

    // SSH key and anonymous share core.sshCommand; each releases only its own.
    await applySshKey(repo, join(ssh, "id_a"), home);
    await applyAnonymous(repo, false);
    assert.equal(await getSshKey(repo), join(ssh, "id_a"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the project's identity: its own, else the default, never one for another host", async () => {
  const { root, repo } = fixture();
  try {
    const work = { id: "work", label: "Work", provider: "github" as const, host: "github.com", commitAuthor: { name: "Work", email: "w@acme.dev" }, authentication: { mode: "system-git" as const } };
    const oss = { id: "oss", label: "OSS", provider: "generic" as const, commitAuthor: { name: "Me", email: "me@oss.dev" }, authentication: { mode: "system-git" as const } };
    const state: SourceControlProfileState = { profiles: [work, oss], globalDefaultProfileId: "oss", repositoryProfileIds: { p1: "work", p3: "system-git" }, repositorySystemIdentities: {} };

    assert.equal(projectSourceControlProfile(state, "p1")?.id, "work");
    assert.equal(projectSourceControlProfile(state, "p2")?.id, "oss", "a project without its own identity uses the default");
    assert.equal(projectSourceControlProfile(state, "p3"), null, "System Git chosen explicitly");

    assert.deepEqual(await projectCommitIdentity(state, "p2", repo), oss.commitAuthor);
    assert.deepEqual(await projectCommitIdentity(state, "p1", repo), work.commitAuthor, "no remote: nothing to mismatch");
    assert.equal(await projectCommitIdentity(state, "p3", repo), null);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@gitlab.com:team/app.git"]);
    assert.equal(await projectCommitIdentity(state, "p1", repo), null, "a GitHub identity never authors commits for a GitLab repository");
    assert.deepEqual(await projectCommitIdentity(state, "p2", repo), oss.commitAuthor);
    assert.equal(await projectCommitIdentity(null, "p1", repo), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Polyth-made commits: the owner commits as the project, others unsigned as themselves", () => {
  const profiles = { read: (userId: string | undefined) => userId === "owner" || userId === "member" ? { name: userId, email: `${userId}@example.com`, updatedAt: 1 } : null };
  const project = { name: "Work", email: "w@acme.dev" };
  const actor = (userId: string | undefined, ambient: boolean): GitActor => ({ spaceId: "s", ...(userId ? { userId } : {}), origin: "person-ui", ambient });

  assert.deepEqual(resolveGitCommitIdentity({ actor: actor("owner", true), profiles, projectIdentity: () => project }), project);
  assert.deepEqual(resolveGitCommitIdentity({ actor: actor("owner", true), profiles, projectIdentity: () => null }), { name: "owner", email: "owner@example.com" });
  assert.deepEqual(
    resolveGitCommitIdentity({ actor: actor("member", false), profiles, projectIdentity: () => project }),
    { name: "member", email: "member@example.com", unsigned: true },
    "a member never commits as the owner's project identity, nor signs with its key",
  );
  assert.deepEqual(resolveGitCommitIdentity({ actor: actor(undefined, false), profiles, projectIdentity: () => project, serviceIdentity: () => ({ name: "S", email: "s@x" }) }), project);
  assert.equal(
    resolveGitCommitIdentity({ actor: actor(undefined, false), profiles, projectIdentity: () => null, serviceIdentity: () => ({ name: "S", email: "s@x" }) }),
    null,
    "System Git chosen for the project keeps the checkout's configuration for system work",
  );
  assert.deepEqual(resolveGitCommitIdentity({ actor: actor(undefined, false), profiles, serviceIdentity: () => ({ name: "S", email: "s@x" }) }), { name: "S", email: "s@x" });
});

test("an unsigned commit identity turns off the checkout's signing for that child only", async () => {
  await withGitCommitIdentity({ name: "M", email: "m@example.com", unsigned: true }, async () => {
    const { args } = gitTransportInvocation(["commit", "-m", "x"]);
    assert.ok(args.includes("commit.gpgsign=false"));
    assert.ok(args.includes("tag.gpgsign=false"));
    assert.deepEqual(gitTransportInvocation(["status"]).args, ["status"]);
  });
  await withGitCommitIdentity({ name: "O", email: "o@example.com" }, async () => {
    assert.ok(!gitTransportInvocation(["commit", "-m", "x"]).args.includes("commit.gpgsign=false"));
  });
});

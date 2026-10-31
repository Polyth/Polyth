import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SpaceContext } from "@polyth/contracts";
import { createSpaceStorage } from "@polyth/tenancy";
import { createGitlabAccountStore, type GitlabOpaqueVault } from "../src/auth.ts";
import { createGitlabCredentialProvider } from "../src/serverEntry.ts";

const vault = (): GitlabOpaqueVault => {
  const values = new Map<string, string>();
  return {
    putOpaque: (key, value) => { values.set(key, value); },
    getOpaque: (key) => values.get(key) ?? null,
    deleteOpaque: (key) => { values.delete(key); },
  };
};

async function setup(deployment: SpaceContext["deployment"], role: SpaceContext["role"] = "owner") {
  const root = mkdtempSync(join(tmpdir(), "gitlab-credentials-"));
  const storage = createSpaceStorage(root);
  const space = { spaceId: "spc_a", spaceSlug: "a", userId: "usr", role, deployment, storageDir: root } as SpaceContext;
  const accounts = createGitlabAccountStore(vault());
  const pat = await accounts.connectPat(space, storage, { instanceId: "https://gitlab.example.com", label: "Work", username: "alice" }, "glpat-value", async () => ({ username: "alice" }));
  const local = { ...space, deployment: "local-trusted" } as SpaceContext;
  const glab = await accounts.connectGlab(local, storage, { instanceId: "https://gitlab.com", label: "Me", username: "bob" }, async () => ({ username: "bob" }));
  const projectPath = "/repo";
  const provider = createGitlabCredentialProvider({
    deployment,
    spaceStorage: () => storage,
    forSpace: () => ({ projects: { get: async (id: string) => id === "p1" ? { id, name: "repo", path: projectPath } : undefined } }),
  } as never, {
    accounts,
    exec: async (_bin, args) => ({
      stdout: args[0] === "remote" && args.length === 1 ? "origin\nmirror\n"
        : args.at(-1) === "origin" ? "https://gitlab.example.com/team/repo.git\n"
        : "https://gitlab.example.com/team/mirror.git\n",
      stderr: "",
    }),
  });
  return { provider, space, storage, pat, glab };
}

test("GitLab PAT accounts hand their token to Git; glab defers to the host's helpers", async () => {
  const { provider, space, pat, glab } = await setup("local-trusted");
  const rows = await provider.accounts(space);
  assert.deepEqual(rows.map((row) => [row.login, row.origin, row.transport]), [
    ["alice", "https://gitlab.example.com", "token"],
    ["bob", "https://gitlab.com", "system"],
  ]);
  assert.deepEqual(await provider.credential(space, pat.id), { username: "alice", password: "glpat-value" });
  assert.equal(await provider.credential(space, glab.id), null);
  await assert.rejects(provider.credential(space, "missing"), { code: "not-found" });
});

test("hosted deployments never expose host glab logins", async () => {
  const { provider, space, glab } = await setup("multi-tenant-sandboxed");
  assert.deepEqual((await provider.accounts(space)).map((row) => row.login), ["alice"]);
  await assert.rejects(provider.credential(space, glab.id), { code: "permission-denied" });
});

test("binding a cloned project records the GitLab binding for exactly the cloned remote", async () => {
  const { provider, space, storage, pat } = await setup("local-trusted");
  await provider.bindProject!(space, { projectId: "p1", accountId: pat.id, repository: "https://gitlab.example.com/team/repo.git" });
  const rows = JSON.parse(readFileSync(join(storage.packageDir("gitlab"), "bindings.json"), "utf8")) as Array<Record<string, string>>;
  assert.deepEqual(rows, [{ projectId: "p1", remoteName: "origin", observedUrl: "https://gitlab.example.com/team/repo.git", accountId: pat.id, instanceId: "https://gitlab.example.com" }]);
});

test("members cannot change a project's GitLab binding through a clone", async () => {
  const { provider, storage, pat } = await setup("local-trusted");
  const member = { spaceId: "spc_a", spaceSlug: "a", userId: "usr", role: "member", deployment: "local-trusted", storageDir: storage.root } as SpaceContext;
  await provider.bindProject!(member, { projectId: "p1", accountId: pat.id, repository: "https://gitlab.example.com/team/repo.git" });
  assert.throws(() => readFileSync(join(storage.packageDir("gitlab"), "bindings.json"), "utf8"), { code: "ENOENT" });
});

test("glab logins are the instance owner's; personal accounts belong to their owner alone", async () => {
  const { fakePeople } = await import("../../git/test/fakePeople.ts");
  const { createPersonHostingAccounts } = await import("@polyth/git/person-accounts");
  const { storage, pat, glab } = await setup("local-trusted");
  const peopleRoot = mkdtempSync(join(tmpdir(), "gitlab-credentials-people-"));
  const people = createPersonHostingAccounts(fakePeople(peopleRoot, { spc_a: ["alice", "bob", "owner"] }), "gitlab");
  const mine = people.connect("alice", { origin: "https://gitlab.example.com", login: "alice-lab" }, "glpat-alice", "spc_a");
  const provider = createGitlabCredentialProvider({
    deployment: "local-trusted",
    spaceStorage: () => storage,
    forSpace: () => ({ projects: { get: async () => undefined } }),
  } as never, { accounts: createGitlabAccountStore(vault()), people });
  // The Space store is shared through `storage`; re-read with the original store's rows.
  const as = (userId: string, instanceOwner: boolean) =>
    ({ spaceId: "spc_a", spaceSlug: "a", userId, role: "member", deployment: "local-trusted", storageDir: storage.root, instanceOwner }) as SpaceContext;
  const rows = (await provider.accounts(as("alice", false))).map((row) => [row.accountId, row.owner]);
  assert.deepEqual(rows, [[mine.id, "personal"], [pat.id, "service"]], "a member sees their own and the Space's accounts, not the host's glab");
  await assert.rejects(provider.credential(as("alice", false), glab.id), { code: "permission-denied" });
  assert.deepEqual(await provider.credential(as("alice", false), mine.id), { username: "alice-lab", password: "glpat-alice" });
  await assert.rejects(provider.credential(as("bob", false), mine.id), { code: "not-found" });
  assert.deepEqual((await provider.accounts(as("bob", false))).map((row) => row.accountId), [pat.id]);
  assert.deepEqual((await provider.accounts(as("owner", true))).map((row) => [row.accountId, row.owner]), [[pat.id, "service"], [glab.id, "installation"]]);
  assert.equal(await provider.credential(as("owner", true), glab.id), null);
});

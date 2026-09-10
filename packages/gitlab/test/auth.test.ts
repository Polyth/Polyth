import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SpaceContext } from "@polyth/contracts";
import { createSpaceStorage } from "@polyth/tenancy";
import { createGitlabAccountStore, type GitlabOpaqueVault } from "../src/auth.ts";

const vault = (): GitlabOpaqueVault & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    putOpaque: (key, value) => { values.set(key, value); },
    getOpaque: (key) => values.get(key) ?? null,
    deleteOpaque: (key) => { values.delete(key); },
  };
};

const space = (spaceId: string, root: string): [SpaceContext, ReturnType<typeof createSpaceStorage>] => [
  { spaceId, spaceSlug: spaceId, userId: "usr_test", role: "owner", deployment: "local-trusted", storageDir: root },
  createSpaceStorage(root),
];

test("PAT accounts are Space-scoped and metadata never contains the token", async () => {
  const secret = vault();
  const store = createGitlabAccountStore(secret);
  const [spaceA, storageA] = space("spc_a", mkdtempSync(join(tmpdir(), "gitlab-auth-a-")));
  const [spaceB, storageB] = space("spc_b", mkdtempSync(join(tmpdir(), "gitlab-auth-b-")));
  const account = await store.connectPat(spaceA, storageA, {
    instanceId: "instance-1", label: "Work", username: "alice",
  }, "glpat-secret-value", async (token) => {
    assert.equal(token, "glpat-secret-value");
    return { username: "alice" };
  });

  assert.equal(store.list(storageB).length, 0);
  assert.equal(store.resolve(spaceA, storageA, account.id).kind, "pat");
  assert.throws(() => store.resolve(spaceB, storageB, account.id), /not found/);
  assert.doesNotMatch(readFileSync(join(storageA.packageDir("gitlab"), "accounts.json"), "utf8"), /secret-value/);
  assert.equal([...secret.values.keys()][0], `gitlab:spc_a:account:${account.id}`);
});

test("connect rejects an unexpected identity before storing credentials", async () => {
  const secret = vault();
  const store = createGitlabAccountStore(secret);
  const [ctx, storage] = space("spc_a", mkdtempSync(join(tmpdir(), "gitlab-auth-mismatch-")));
  await assert.rejects(
    () => store.connectPat(ctx, storage, {
      instanceId: "instance-1", label: "Work", username: "alice",
    }, "glpat-secret-value", async () => ({ username: "mallory" })),
    (error: Error & { code?: string }) => error.code === "auth-account-mismatch",
  );
  assert.equal(store.list(storage).length, 0);
  assert.equal(secret.values.size, 0);
});

test("glab accounts store only an expected-user reference", async () => {
  const secret = vault();
  const store = createGitlabAccountStore(secret);
  const [, storage] = space("spc_a", mkdtempSync(join(tmpdir(), "gitlab-auth-glab-")));
  const account = await store.connectGlab({
    spaceId: "spc_a", spaceSlug: "a", userId: "usr_test", role: "owner",
    deployment: "local-trusted", storageDir: storage.root,
  }, storage, {
    instanceId: "instance-1", label: "Browser login", username: "alice",
  }, async () => ({ username: "alice" }));
  assert.equal(account.authKind, "glab");
  assert.equal(secret.values.size, 0);
});

test("ambient glab authentication is rejected outside local-trusted deployments", async () => {
  const store = createGitlabAccountStore(vault());
  const [, storage] = space("spc_a", mkdtempSync(join(tmpdir(), "gitlab-auth-hosted-")));
  await assert.rejects(() => store.connectGlab({
    spaceId: "spc_a", spaceSlug: "a", userId: "usr_test", role: "owner",
    deployment: "server-trusted", storageDir: storage.root,
  }, storage, {
    instanceId: "instance-1", label: "Browser login", username: "alice",
  }, async () => ({ username: "alice" })), /local-trusted/);
});

test("malformed account state fails closed", () => {
  const store = createGitlabAccountStore(vault());
  const [, storage] = space("spc_a", mkdtempSync(join(tmpdir(), "gitlab-auth-malformed-")));
  writeFileSync(join(storage.packageDir("gitlab"), "accounts.json"), JSON.stringify([{ id: "partial" }]));
  assert.throws(() => store.list(storage), (error: Error & { code?: string }) => error.code === "invalid-state");
});

test("credential persistence failures roll back without exposing provider errors", async () => {
  const secret = vault();
  let failPut = true;
  const originalPut = secret.putOpaque;
  secret.putOpaque = (key, value) => {
    originalPut(key, value);
    if (failPut) { failPut = false; throw new Error(`failed while writing ${value}`); }
  };
  const store = createGitlabAccountStore(secret);
  const [ctx, storage] = space("spc_a", mkdtempSync(join(tmpdir(), "gitlab-auth-put-failure-")));
  await assert.rejects(
    () => store.connectPat(ctx, storage, {
      instanceId: "instance-1", label: "Work", username: "alice",
    }, "glpat-do-not-echo", async () => ({ username: "alice" })),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "credential-store-failed");
      assert.doesNotMatch(error.message, /do-not-echo/);
      return true;
    },
  );
  assert.equal(store.list(storage).length, 0);
  assert.equal(secret.values.size, 0);
});

test("failed credential removal restores the account credential", async () => {
  const secret = vault();
  const store = createGitlabAccountStore(secret);
  const [ctx, storage] = space("spc_a", mkdtempSync(join(tmpdir(), "gitlab-auth-delete-failure-")));
  const account = await store.connectPat(ctx, storage, {
    instanceId: "instance-1", label: "Work", username: "alice",
  }, "glpat-still-present", async () => ({ username: "alice" }));
  let failDelete = true;
  const originalDelete = secret.deleteOpaque;
  secret.deleteOpaque = key => {
    originalDelete(key);
    if (failDelete) { failDelete = false; throw new Error("delete backend failed with glpat-still-present"); }
  };
  assert.throws(
    () => store.remove(ctx, storage, account.id),
    (error: Error & { code?: string }) => error.code === "credential-store-failed" && !error.message.includes("glpat-still-present"),
  );
  assert.equal(store.list(storage).length, 1);
  const resolved = store.resolve(ctx, storage, account.id);
  assert.equal(resolved.kind, "pat");
  if (resolved.kind === "pat") assert.equal(resolved.token, "glpat-still-present");
});

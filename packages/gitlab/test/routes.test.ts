import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { RouteRequest, SpaceContext, SpaceStorage } from "@polyth/contracts";
import { createSpaceStorage } from "@polyth/tenancy";
import { gitlabRoutes, createMutationReceipts } from "../src/serverEntry.ts";
import type { GitlabAccountStore } from "../src/auth.ts";
import type { GitlabApiClient } from "../src/client.ts";

const ctx = (spaceId: string, root: string): SpaceContext => ({ spaceId, spaceSlug: spaceId, userId: "usr_test", role: "owner", deployment: "local-trusted", storageDir: root });
const account = { id: "acct_1", instanceId: "https://gitlab.example", username: "alice", label: "Work", authKind: "pat" as const };
function harness() {
  const ownerRoot = mkdtempSync(join(tmpdir(), "gitlab-routes-"));
  const owner = ctx("spc_owner", ownerRoot);
  const storage = createSpaceStorage(ownerRoot);
  const calls = { client: 0, git: 0, writes: 0 };
  const projects = { get: async (id: string) => id === "proj_1" ? { id, path: "/repo", name: "repo" } : undefined };
  const sessions = { snapshot: async (id: string) => ({ id, projectId: id === "sess_foreign" ? "proj_foreign" : "proj_1" }), create: async () => ({ id: "new" }), send: async () => ({}) };
  const accounts = {
    get: (scopedStorage: SpaceStorage, id: string) => scopedStorage.root === storage.root && id === account.id ? account : undefined,
    list: (scopedStorage: SpaceStorage) => scopedStorage.root === storage.root ? [account] : [],
    resolve: () => ({ kind: "pat", token: "secret" }),
    remove: () => {},
  } as unknown as GitlabAccountStore;
  const host = {
    deployment: "local-trusted",
    spaceStorage: (space: SpaceContext) => space.spaceId === owner.spaceId ? storage : createSpaceStorage(mkdtempSync(join(tmpdir(), "gitlab-other-space-"))),
    forSpace: (_space: SpaceContext) => ({ projects, sessions }),
    events: { append: async () => ({}) },
  } as unknown as Parameters<typeof gitlabRoutes>[0];
  const exec = async (_bin: "git", args: string[]) => { calls.git++; return args[1] === "remote" ? { stdout: "origin\n", stderr: "" } : { stdout: "git@gitlab.example:acme/app.git\n", stderr: "" }; };
  const route = gitlabRoutes(host, { accounts, exec, client: (() => { calls.client++; return { request: async <T>() => undefined as T }; }) as unknown as (accountId: string) => GitlabApiClient });
  const request = async (space: SpaceContext, method: string, path: string, body: Record<string, unknown> = {}) => {
    let response: { status: number; payload: unknown } = { status: 0, payload: undefined };
    const parsed = new URL(`https://polyth.test${path}`);
    const handled = await route({ req: {}, res: {}, path: parsed.pathname, method, space, url: parsed, body: async () => body, json: (status: number, payload: unknown) => { response = { status, payload }; } } as unknown as RouteRequest);
    return { handled, ...response };
  };
  return { owner, storage, calls, route, request };
}

test("foreign project is denied before Git inspection or provider client use", async () => {
  const h = harness();
  const result = await h.request(ctx("spc_foreign", mkdtempSync(join(tmpdir(), "gitlab-foreign-"))), "GET", "/api/gitlab/issues?projectId=foreign");
  assert.equal(result.status, 404); assert.equal(h.calls.git, 0); assert.equal(h.calls.client, 0);
});

test("foreign session is denied before Git inspection or writes", async () => {
  const h = harness();
  const result = await h.request(h.owner, "POST", "/api/gitlab/issues", { projectId: "proj_1", sessionId: "sess_foreign" });
  assert.equal(result.status, 404); assert.equal(h.calls.git, 0); assert.equal(h.calls.client, 0);
});

test("accounts list is read from the supplied Space storage", async () => {
  const h = harness();
  const result = await h.request(h.owner, "GET", "/api/gitlab/accounts");
  assert.equal(result.status, 200); assert.deepEqual((result.payload as any).data, [account]);
});

test("foreign Space account IDs are invisible to account routes", async () => {
  const h = harness();
  const result = await h.request(ctx("spc_foreign", mkdtempSync(join(tmpdir(), "gitlab-foreign-account-"))), "GET", "/api/gitlab/accounts");
  assert.equal(result.status, 200); assert.deepEqual((result.payload as any).data, []);
});

test("viewer cannot connect accounts or reach account verification", async () => {
  const h = harness();
  const viewer = { ...h.owner, role: "viewer" as const };
  const result = await h.request(viewer, "POST", "/api/gitlab/accounts", {
    authKind: "pat", instance: "https://gitlab.example", username: "alice", token: "secret",
  });
  assert.equal(result.status, 403);
  assert.equal((result.payload as any).code, "permission-denied");
  assert.equal(h.calls.git, 0); assert.equal(h.calls.client, 0);
});

test("viewer cannot start provider mutations", async () => {
  const h = harness();
  const viewer = { ...h.owner, role: "viewer" as const };
  const result = await h.request(viewer, "POST", "/api/gitlab/issues/3/comments", {
    projectId: "proj_1", requestId: "request-1234567890", body: "comment",
  });
  assert.equal(result.status, 403);
  assert.equal((result.payload as any).code, "permission-denied");
  assert.equal(h.calls.git, 0); assert.equal(h.calls.client, 0);
});

test("context detection returns current remotes without contacting the provider", async () => {
  const h = harness();
  const result = await h.request(h.owner, "GET", "/api/gitlab/context?projectId=proj_1");
  assert.equal(result.status, 200);
  const data = (result.payload as { data: { remotes: Array<{ fullPath: string }> } }).data;
  assert.equal(data.remotes[0]?.fullPath, "acme/app");
  assert.equal(h.calls.client, 0); assert.equal(h.calls.git, 2);
});

test("binding rejects a stale observed remote before persisting state", async () => {
  const h = harness();
  const result = await h.request(h.owner, "POST", "/api/gitlab/binding", { projectId: "proj_1", accountId: account.id, remoteName: "origin", observedUrl: "https://gitlab.example/acme/old.git" });
  assert.equal(result.status, 400); assert.equal((result.payload as any).code, "stale-state");
});

test("mutation receipts execute concurrent identical requests once", async () => {
  const receipts = createMutationReceipts(); const storage = createSpaceStorage(mkdtempSync(join(tmpdir(), "gitlab-receipts-"))); let count = 0;
  const run = () => receipts(storage, "request-1234567890", { op: "comment", n: 1 }, async () => { count++; await new Promise(resolve => setTimeout(resolve, 5)); return { digest: "", status: 200, payload: { ok: true } }; });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(count, 1); assert.deepEqual(a.payload, b.payload);
});

test("mutation receipts reject changed payloads and preserve unknown after restart", async () => {
  const storage = createSpaceStorage(mkdtempSync(join(tmpdir(), "gitlab-receipts-restart-"))); const receipts = createMutationReceipts();
  const first = await receipts(storage, "request-1234567890", { op: "one" }, async () => { throw new Error("connection lost"); });
  assert.equal(first.status, 409); assert.equal((first.payload as any).outcome, "unknown");
  await assert.rejects(() => receipts(storage, "request-1234567890", { op: "two" }, async () => ({ digest: "", status: 200, payload: { ok: true } })), (error: Error & { code?: string }) => error.code === "request-conflict");
  const receipts2 = createMutationReceipts(); const result = await receipts2(storage, "request-1234567890", { op: "one" }, async () => ({ digest: "", status: 200, payload: { ok: true } }));
  assert.equal(result.status, 409); assert.equal((result.payload as any).outcome, "unknown");
});

test("invalid receipt request IDs are rejected before execution", async () => {
  const receipts = createMutationReceipts(); const storage = createSpaceStorage(mkdtempSync(join(tmpdir(), "gitlab-receipts-id-"))); let ran = false;
  await assert.rejects(() => receipts(storage, "short", {}, async () => { ran = true; return { digest: "", status: 200, payload: {} }; }), (error: Error & { code?: string }) => error.code === "invalid-input");
  assert.equal(ran, false);
});

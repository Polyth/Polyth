import test from "node:test";
import assert from "node:assert/strict";
import type { SpaceContext, SpaceRole } from "@polyth/contracts";
import { createBundleService, type BundleViewer } from "../src/bundles.ts";
import { createContextSourceRegistry } from "../src/index.ts";
import { handoffRoutes } from "../src/serverEntry.ts";
import type { RouteRequest } from "../../server/src/http.ts";

const space = (spaceId: string, userId: string, role: SpaceRole = "member"): SpaceContext => ({
  spaceId,
  spaceSlug: spaceId,
  userId,
  role,
  deployment: "local-trusted",
  storageDir: `/tmp/${spaceId}`,
});

/** Sessions each person can open, per Space. */
function fixture(openable: Record<string, string[]>) {
  const registry = createContextSourceRegistry();
  const bundles = createBundleService({ registry, warnTokenThreshold: 80_000 });
  const host = {
    forSpace: (ctx: SpaceContext) => ({
      projects: { get: async (id: string) => (id === "proj" ? { id } : null) },
      sessions: {
        snapshot: async (sessionId: string) => {
          if (openable[ctx.userId]?.includes(sessionId)) return { id: sessionId, projectId: "proj", status: "idle" };
          throw Object.assign(new Error("session not found"), { code: "not-found" });
        },
      },
    }),
    spaceStorage: () => ({ path: (p: string) => p, packageDir: () => "/tmp/pkg" }),
    events: { append: async () => ({}) },
  };
  const routes = handoffRoutes({ host: host as never, registry, bundles, warnTokenThreshold: 80_000 });
  const call = async (ctx: SpaceContext, method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const url = new URL(path, "http://x");
    await routes({
      path: url.pathname,
      method,
      url,
      space: ctx,
      body: async () => body,
      json: (code: number, value: unknown) => { status = code; payload = value; },
    } as unknown as RouteRequest);
    return { status, payload: payload as Record<string, unknown> };
  };
  return { bundles, call };
}

const create = (call: ReturnType<typeof fixture>["call"], ctx: SpaceContext, sessionId: string) =>
  call(ctx, "POST", "/api/handoff/bundles", { projectId: "proj", sessionId, presetId: "custom", label: "Mine", sources: [] });

test("a bundle is private to its creator unless the caller can open its session", async () => {
  const { call } = fixture({ alice: ["s-alice"], bob: ["s-bob"], carol: ["s-alice"] });
  const alice = space("spc_work", "alice");
  const made = await create(call, alice, "s-alice");
  assert.equal(made.status, 200);
  const id = String(made.payload.id);

  const own = await call(alice, "GET", "/api/handoff/bundles?projectId=proj");
  assert.equal((own.payload.bundles as unknown[]).length, 1);
  assert.equal("createdBy" in (own.payload.bundles as object[])[0]!, false, "creator id is not exposed");

  const bob = space("spc_work", "bob");
  assert.deepEqual((await call(bob, "GET", "/api/handoff/bundles?projectId=proj")).payload.bundles, []);
  assert.equal((await call(bob, "GET", `/api/handoff/bundles/${id}?projectId=proj`)).status, 404);
  assert.equal((await call(bob, "GET", `/api/handoff/bundles/${id}/check?projectId=proj&sessionId=s-bob`)).status, 404);

  // Carol can open Alice's source session, so she can read what she could read anyway.
  const carol = space("spc_work", "carol");
  assert.equal(((await call(carol, "GET", "/api/handoff/bundles?projectId=proj")).payload.bundles as unknown[]).length, 1);
  assert.equal((await call(carol, "GET", `/api/handoff/bundles/${id}?projectId=proj`)).status, 200);
});

test("another Space never sees the bundle, even for its creator", async () => {
  const { call } = fixture({ alice: ["s-alice"] });
  const made = await create(call, space("spc_work", "alice"), "s-alice");
  const id = String(made.payload.id);
  const elsewhere = space("spc_home", "alice");
  assert.deepEqual((await call(elsewhere, "GET", "/api/handoff/bundles?projectId=proj")).payload.bundles, []);
  assert.equal((await call(elsewhere, "GET", `/api/handoff/bundles/${id}?projectId=proj`)).status, 404);
});

test("a bundle with no recorded creator is visible to Space admins only", async () => {
  const { bundles } = fixture({});
  const viewer = (userId: string, role: SpaceRole): BundleViewer => ({ userId, role, canOpenSession: async () => true });
  const legacy = await bundles.createBundle({
    storage: { path: (p: string) => p } as never,
    collectCtx: { space: space("spc_legacy", "x"), projectId: "proj", sessionId: "s" },
    projectId: "proj",
    sessionId: "s",
    presetId: "custom",
    label: "Legacy",
    instruction: "",
    sources: [],
    createdBy: undefined as never,
  });
  const storage = { path: (p: string) => p } as never;
  // Even a member who can open the source session does not get a legacy bundle.
  assert.equal(await bundles.getBundle(storage, "proj", legacy.id, "spc_legacy", viewer("bob", "member")), null);
  assert.equal((await bundles.listBundles(storage, "proj", "spc_legacy", viewer("bob", "member"))).length, 0);
  assert.ok(await bundles.getBundle(storage, "proj", legacy.id, "spc_legacy", viewer("dana", "admin")));
  assert.equal((await bundles.listBundles(storage, "proj", "spc_legacy", viewer("erin", "owner"))).length, 1);
});

test("one person's bundle count cap does not evict another person's bundles", async () => {
  const { call } = fixture({ alice: ["s"], bob: ["s"] });
  const bob = space("spc_cap", "bob");
  const first = await create(call, bob, "s");
  for (let i = 0; i < 14; i++) await create(call, space("spc_cap", "alice"), "s");
  const read = await call(bob, "GET", `/api/handoff/bundles/${String(first.payload.id)}?projectId=proj`);
  assert.equal(read.status, 200);
});

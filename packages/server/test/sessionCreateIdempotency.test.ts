// Keyed HTTP session creation: a phone that lost the create response resends the
// same clientOperationId and must get the SAME session back, never a duplicate.
// The key is account+Space scoped and the session id is server-derived.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createStore } from "@polyth/session";
import type { AgentRuntime, SpaceContext } from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createProjectService } from "../src/projects.ts";
import { createSessionService } from "../src/sessions.ts";
import { createSpaceGateway } from "../src/spaces.ts";
import { createHttpServer } from "../src/http.ts";
import { sessionIdForCreateOperation } from "../src/sessionCreateIdempotency.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-create-idempotency-"));

interface Harness {
  base: string;
  home: SpaceContext;
  work: SpaceContext;
  homeProject: string;
  workProject: string;
  creates: () => number;
  /** The next `times` runtime acquisitions throw before reaching the runtime. */
  failAcquire(times: number, code?: string): void;
  /** Hold every runtime create until released. */
  hold(): () => void;
  failRuntime(fail: boolean): void;
  operations(sessionId: string): Promise<Array<{ mutationKind: string; state: string; code?: string; message?: string }>>;
  /** The Space-scoped service an in-process route (e.g. isolation) creates through. */
  sessionsFor(ctx: SpaceContext): import("@polyth/contracts").SessionService;
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const dataDir = tmp();
  const store = createStore(join(dataDir, "sessions.db"));
  const registry = createProjectService(dataDir);
  let createCount = 0;
  let gate: Promise<void> | undefined;
  let runtimeFails = false;
  let acquireFailures = 0;
  let acquireCode = "runtime-unavailable";
  const runtime = {
    capabilities: async () => ({ streaming: true, permissions: false, questions: false, compaction: false, subagents: false }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c: { sessionId: string }) => {
      createCount += 1;
      await gate;
      return `be_${c.sessionId}`;
    },
    resetSession: async () => "fresh",
    sessions: async () => [],
    history: async () => [],
    startTurn: async () => {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent: () => ({ dispose() {} }),
    dispose: async () => {},
  } as unknown as AgentRuntime;
  let sessions: ReturnType<typeof createSessionService>;
  const { gateway } = await createSpaceGateway({ dataDir, registry, store, sessions: () => sessions });
  sessions = createSessionService({
    store,
    projects: registry,
    permissions: { evaluate: () => "ask", addRule: () => {}, rules: () => [] } as unknown as PermissionService,
    runtimeAcquireRetryMs: [5, 5, 5],
    runtimes: {
      forProject: async () => {
        if (acquireFailures > 0) {
          acquireFailures -= 1;
          throw Object.assign(new Error(`runtime acquire refused (${acquireCode})`), { code: acquireCode });
        }
        if (runtimeFails) throw Object.assign(new Error("runtime down"), { code: "runtime-unavailable" });
        return runtime;
      },
    },
    broadcast: { event: () => {}, projection: () => {} },
    queue: store,
    org: store,
  });
  const owner = gateway.store.users()[0]!;
  const home = gateway.resolver.forUser(owner.id, gateway.store.defaultSpaceFor(owner.id)!.id);
  const work = gateway.resolver.forUser(owner.id, gateway.store.createSpace({ name: "Work", ownerId: owner.id }).id);
  const homeProject = (await gateway.services(home).projects.add(tmp(), "home")).id;
  const workProject = (await gateway.services(work).projects.add(tmp(), "work")).id;
  const server = createHttpServer({ spaces: gateway, runtimes: {} as never, capabilities: () => [], webDist: tmp(), version: "test" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    home, work, homeProject, workProject,
    creates: () => createCount,
    failAcquire(times, code) { acquireFailures = times; if (code) acquireCode = code; },
    hold() {
      let release!: () => void;
      gate = new Promise((resolve) => { release = resolve; });
      return () => { gate = undefined; release(); };
    },
    failRuntime(fail) { runtimeFails = fail; },
    operations: (sessionId) => store.operations(sessionId),
    sessionsFor: (ctx) => gateway.services(ctx).sessions,
    async close() { server.close(); await once(server, "close"); },
  };
}

const create = (h: Harness, body: Record<string, unknown>, space?: SpaceContext) => fetch(`${h.base}/api/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(space ? { "x-polyth-space": space.spaceId } : {}) },
  body: JSON.stringify(body),
});
const probe = async (h: Harness, key: string, space?: SpaceContext) => (await fetch(
  `${h.base}/api/sessions/create-operations/${key}`,
  space ? { headers: { "x-polyth-space": space.spaceId } } : {},
)).json() as Promise<{ state: string; sessionId?: string }>;

test("a resent create with the same key returns the first session instead of a duplicate", async () => {
  const h = await harness();
  try {
    const key = randomUUID();
    assert.deepEqual(await probe(h, key), { state: "absent" });
    const first = await create(h, { projectId: h.homeProject, clientOperationId: key });
    assert.equal(first.status, 200);
    const { id } = await first.json() as { id: string };
    assert.equal(id, sessionIdForCreateOperation(key, h.home), "the session id is server-derived from the key");
    const again = await create(h, { projectId: h.homeProject, clientOperationId: key.toUpperCase() });
    assert.deepEqual(await again.json(), { id });
    assert.equal(h.creates(), 1, "the runtime created exactly one native session");
    assert.deepEqual(await probe(h, key), { state: "created", sessionId: id });
    const listed = await (await fetch(`${h.base}/api/sessions?projectId=${h.homeProject}`)).json() as Array<{ id: string }>;
    assert.deepEqual(listed.map((row) => row.id), [id]);
  } finally { await h.close(); }
});

test("a resend that overtakes the in-flight original waits for it and returns the same session", async () => {
  const h = await harness();
  try {
    const key = randomUUID();
    const release = h.hold();
    const original = create(h, { projectId: h.homeProject, clientOperationId: key });
    while (h.creates() === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const resend = create(h, { projectId: h.homeProject, clientOperationId: key });
    release();
    const [a, b] = await Promise.all([original, resend]);
    assert.deepEqual(await b.json(), await a.json());
    assert.equal(h.creates(), 1);
  } finally { await h.close(); }
});

test("the key is Space-scoped: the same token in another Space neither aliases nor reveals it", async () => {
  const h = await harness();
  try {
    const key = randomUUID();
    const home = await (await create(h, { projectId: h.homeProject, clientOperationId: key })).json() as { id: string };
    assert.deepEqual(await probe(h, key, h.work), { state: "absent" });
    const work = await (await create(h, { projectId: h.workProject, clientOperationId: key }, h.work)).json() as { id: string };
    assert.notEqual(work.id, home.id);
    assert.equal(h.creates(), 2);
    assert.notEqual(
      sessionIdForCreateOperation(key, { userId: "a", spaceId: h.home.spaceId }),
      sessionIdForCreateOperation(key, { userId: "b", spaceId: h.home.spaceId }),
      "another account's identical token derives a different session",
    );
  } finally { await h.close(); }
});

test("a resend after a settled failure reports the rejection, not a new session", async () => {
  const h = await harness();
  try {
    const key = randomUUID();
    h.failRuntime(true);
    const failed = await create(h, { projectId: h.homeProject, clientOperationId: key });
    assert.equal(failed.status, 503);
    h.failRuntime(false);
    assert.equal((await probe(h, key)).state, "failed");
    const resend = await create(h, { projectId: h.homeProject, clientOperationId: key });
    assert.equal(resend.status, 409);
    const body = await resend.json() as { mutationOutcome: string; sessionId: string };
    assert.equal(body.mutationOutcome, "rejected");
    assert.equal(body.sessionId, sessionIdForCreateOperation(key, h.home));
    assert.equal(h.creates(), 0);
  } finally { await h.close(); }
});

test("keyless create stays as before and malformed keys are refused before any effect", async () => {
  const h = await harness();
  try {
    const a = await (await create(h, { projectId: h.homeProject })).json() as { id: string };
    const b = await (await create(h, { projectId: h.homeProject })).json() as { id: string };
    assert.notEqual(a.id, b.id);
    const bad = await create(h, { projectId: h.homeProject, clientOperationId: "not-a-uuid" });
    assert.equal(bad.status, 400);
    assert.equal(h.creates(), 2);
  } finally { await h.close(); }
});

test("the probe also reports a create made under the same derived id by another route (isolation)", async () => {
  const h = await harness();
  try {
    const key = randomUUID();
    const id = sessionIdForCreateOperation(key, h.home);
    // packages/git's keyed isolated create derives the same id and creates through the canonical service.
    await h.sessionsFor(h.home).create({ id, projectId: h.homeProject });
    assert.deepEqual(await probe(h, key), { state: "created", sessionId: id });
    assert.deepEqual(await probe(h, key, h.work), { state: "absent" });
  } finally { await h.close(); }
});

test("a create waits out a transient configuration fence instead of failing the first attempt", async () => {
  const h = await harness();
  try {
    const key = randomUUID();
    // A configuration replacement fences runtime creation for a moment; the
    // user's first create must ride it out, not settle as a rejected session.
    h.failAcquire(1, "restart-deferred");
    const first = await create(h, { projectId: h.homeProject, clientOperationId: key });
    assert.equal(first.status, 200);
    const { id } = await first.json() as { id: string };
    assert.equal(id, sessionIdForCreateOperation(key, h.home));
    assert.equal(h.creates(), 1, "the retried acquire created exactly one native session");
    assert.deepEqual(await probe(h, key), { state: "created", sessionId: id });
    const createOps = (await h.operations(id)).filter((op) => op.mutationKind === "session-create");
    assert.equal(createOps.every((op) => op.state !== "rejected"), true);
    // The retry is transparent to the key: a resend still returns the same row.
    assert.deepEqual(await (await create(h, { projectId: h.homeProject, clientOperationId: key })).json(), { id });
    assert.equal(h.creates(), 1);
  } finally { await h.close(); }
});

test("a transient runtime-unavailable during acquire also recovers on the first attempt", async () => {
  const h = await harness();
  try {
    const key = randomUUID();
    h.failAcquire(2, "runtime-unavailable");
    const res = await create(h, { projectId: h.homeProject, clientOperationId: key });
    assert.equal(res.status, 200);
    assert.equal(h.creates(), 1);
  } finally { await h.close(); }
});

test("a settled create failure preserves the real runtime reason in its ledger", async () => {
  const h = await harness();
  try {
    const key = randomUUID();
    // A terminal refusal is never retried; its cause must reach the ledger
    // instead of the old generic "runtime-unavailable".
    h.failAcquire(1, "unsupported");
    const failed = await create(h, { projectId: h.homeProject, clientOperationId: key });
    assert.equal(failed.status, 501);
    const body = await failed.json() as { error: string; message: string };
    assert.equal(body.error, "unsupported");
    assert.match(body.message, /runtime acquire refused \(unsupported\)/);
    assert.equal(h.creates(), 0);
    const id = sessionIdForCreateOperation(key, h.home);
    const createOps = (await h.operations(id)).filter((op) => op.mutationKind === "session-create");
    const settled = createOps.find((op) => op.state === "rejected");
    assert.equal(settled?.code, "unsupported", "the ledger keeps the real refusal code");
    assert.match(settled?.message ?? "", /runtime acquire refused \(unsupported\)/);
  } finally { await h.close(); }
});

// Cross-Space isolation. The subject is the boundary itself, so nothing here
// is stubbed out: a real event store, a real project registry, a real session
// service, the real scoped facades, and the real HTTP gateway.
//
// The most important case is ONE user with TWO Spaces. Code that authorizes by
// `userId` passes every "two different users" test and still leaks here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createStore } from "@polyth/session";
import type {
  AgentRuntime,
  RuntimeEvent,
  SessionProjection,
  SpaceContext,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createProjectService } from "../src/projects.ts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import { createSpaceGateway, type SpaceGateway } from "../src/spaces.ts";
import { createHttpServer } from "../src/http.ts";
import { orgRoutes } from "../src/routes/org.ts";
import { createWsGateway } from "../src/ws.ts";
import { createServer } from "node:http";
import { WebSocket } from "ws";

const tmp = () => mkdtempSync(join(tmpdir(), "polyth-space-isolation-"));

function fakeRuntime(): AgentRuntime {
  const listeners = new Set<(sessionId: string, ev: RuntimeEvent) => void>();
  return {
    capabilities: async () => ({
      streaming: true, permissions: false, questions: false, compaction: false, subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    resetSession: async () => "fresh",
    sessions: async () => [],
    history: async () => [],
    startTurn: async () => {},
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) { listeners.add(cb); return { dispose: () => listeners.delete(cb) }; },
    dispose: async () => {},
  } as unknown as AgentRuntime;
}

interface Harness {
  dataDir: string;
  gateway: SpaceGateway;
  home: SpaceContext;
  work: SpaceContext;
  broadcast: Broadcaster;
  /** Register a project + one session inside `ctx` and return both ids. */
  seed(ctx: SpaceContext, name: string): Promise<{ projectId: string; sessionId: string }>;
}

async function harness(): Promise<Harness> {
  const dataDir = tmp();
  const store = createStore(join(dataDir, "sessions.db"));
  const registry = createProjectService(dataDir);
  const runtime = fakeRuntime();
  const broadcastEvents: SessionProjection[] = [];
  const broadcast: Broadcaster = {
    event: () => {},
    projection: (p) => { broadcastEvents.push(p); },
  };
  let sessions: ReturnType<typeof createSessionService>;
  const { gateway } = await createSpaceGateway({
    dataDir,
    registry,
    store,
    sessions: () => sessions,
  });
  sessions = createSessionService({
    store,
    projects: registry,
    permissions: { evaluate: () => "ask", addRule: () => {}, rules: () => [] } as unknown as PermissionService,
    runtimes: { forProject: async () => runtime },
    broadcast,
    queue: store,
    org: store,
  });

  const owner = gateway.store.users()[0]!;
  const homeSpace = gateway.store.defaultSpaceFor(owner.id)!;
  const workSpace = gateway.store.createSpace({ name: "Work", ownerId: owner.id });
  const home = gateway.resolver.forUser(owner.id, homeSpace.id);
  const work = gateway.resolver.forUser(owner.id, workSpace.id);

  return {
    dataDir,
    gateway,
    home,
    work,
    broadcast,
    async seed(ctx, name) {
      const scoped = gateway.services(ctx);
      const dir = mkdtempSync(join(tmpdir(), `polyth-${name}-`));
      const project = await scoped.projects.add(dir, name);
      const ref = await scoped.sessions.create({ projectId: project.id, title: `${name} session` });
      return { projectId: project.id, sessionId: ref.id };
    },
  };
}

// ---- one user, two Spaces ------------------------------------------------------

test("one user's two Spaces cannot see each other's projects or sessions", async () => {
  const h = await harness();
  const inHome = await h.seed(h.home, "home");
  const inWork = await h.seed(h.work, "work");

  const homeServices = h.gateway.services(h.home);
  const workServices = h.gateway.services(h.work);

  // Listing is disjoint.
  assert.deepEqual((await homeServices.projects.list()).map((p) => p.id), [inHome.projectId]);
  assert.deepEqual((await workServices.projects.list()).map((p) => p.id), [inWork.projectId]);
  assert.deepEqual((await homeServices.sessions.list()).map((s) => s.id), [inHome.sessionId]);
  assert.deepEqual((await workServices.sessions.list()).map((s) => s.id), [inWork.sessionId]);

  // A KNOWN-GOOD id from the other Space reads as missing, not forbidden.
  assert.equal(await homeServices.projects.get(inWork.projectId), undefined);
  await assert.rejects(
    () => homeServices.sessions.snapshot(inWork.sessionId),
    (error: { code?: string }) => error.code === "not-found",
  );
  await assert.rejects(
    () => homeServices.sessions.events(inWork.sessionId),
    (error: { code?: string }) => error.code === "not-found",
  );
  await assert.rejects(
    () => homeServices.sessions.list(inWork.projectId),
    (error: { code?: string }) => error.code === "not-found",
  );
});

test("mutations across Spaces are refused, including deletes that would silently succeed", async () => {
  const h = await harness();
  const inHome = await h.seed(h.home, "home");
  const inWork = await h.seed(h.work, "work");
  const homeServices = h.gateway.services(h.home);
  const workServices = h.gateway.services(h.work);

  for (const attempt of [
    () => homeServices.sessions.archive(inWork.sessionId),
    () => homeServices.sessions.abort(inWork.sessionId),
    () => homeServices.sessions.rename!(inWork.sessionId, "stolen"),
    () => homeServices.sessions.send(inWork.sessionId, { text: "hi" }),
    () => homeServices.sessions.delete!(inWork.sessionId),
    () => homeServices.sessions.saveDraft!(inWork.sessionId, "leak"),
    () => homeServices.sessions.markRead!(inWork.sessionId, 1),
    () => homeServices.projects.update!(inWork.projectId, { name: "stolen" }),
    () => homeServices.projects.remove(inWork.projectId),
  ]) {
    await assert.rejects(attempt, (error: { code?: string }) => error.code === "not-found");
  }

  // Everything in Work is intact and still owned by Work.
  const survivor = await workServices.sessions.snapshot(inWork.sessionId);
  assert.equal(survivor.spaceId, h.work.spaceId);
  assert.equal(survivor.title, "work session");
  assert.equal((await workServices.projects.get(inWork.projectId))!.name, "work");
});

test("a session created in a Space is stamped with it, and a fork stays inside it", async () => {
  const h = await harness();
  const inHome = await h.seed(h.home, "home");
  const homeServices = h.gateway.services(h.home);

  const projection = await homeServices.sessions.snapshot(inHome.sessionId);
  assert.equal(projection.spaceId, h.home.spaceId);

  // Ownership is derived from the project, never from a caller-supplied field:
  // asking to create in another Space's project is refused outright.
  const inWork = await h.seed(h.work, "work");
  await assert.rejects(
    () => homeServices.sessions.create({ projectId: inWork.projectId }),
    (error: { code?: string }) => error.code === "not-found",
  );
});

// ---- two users -----------------------------------------------------------------

test("a second user sees only their own Spaces", async () => {
  const h = await harness();
  const stranger = h.gateway.store.createUser("Stranger");
  const theirs = h.gateway.store.createSpace({ name: "Theirs", ownerId: stranger.id });

  const owner = h.gateway.store.users().find((u) => u.id !== stranger.id)!;
  assert.deepEqual(h.gateway.store.spacesFor(stranger.id).map((s) => s.id), [theirs.id]);
  assert.equal(h.gateway.store.spacesFor(owner.id).some((s) => s.id === theirs.id), false);

  // Neither can mint a context in the other's Space.
  assert.throws(
    () => h.gateway.resolver.forUser(owner.id, theirs.id),
    (error: { code?: string }) => error.code === "not-found",
  );
  assert.throws(
    () => h.gateway.resolver.forUser(stranger.id, h.home.spaceId),
    (error: { code?: string }) => error.code === "not-found",
  );
});

test("an internal control caller is bound explicitly, and gets nothing when hosted", async () => {
  // Trusted: the filesystem-protected control socket acts as the operator and
  // lands in the default Space, exactly like the loopback UI.
  const trusted = await harness();
  const ctx = trusted.gateway.resolveInternal();
  assert.equal(ctx.userId, trusted.home.userId);
  assert.equal(ctx.spaceId, trusted.home.spaceId);
  // It can also be pointed at a specific Space it owns...
  assert.equal(trusted.gateway.resolveInternal(trusted.work.spaceId).spaceId, trusted.work.spaceId);
  // ...but never at one that does not exist.
  assert.throws(
    () => trusted.gateway.resolveInternal("spc_invented"),
    (error: { code?: string }) => error.code === "not-found",
  );

  // Hosted: there is no ambient operator to act as, so a control-plane caller
  // must be handed a context by whatever invoked it.
  const dataDir = tmp();
  const { gateway } = await createSpaceGateway({
    dataDir,
    registry: createProjectService(dataDir),
    store: createStore(join(dataDir, "sessions.db")),
    sessions: () => ({} as never),
    deployment: "multi-tenant-sandboxed",
  });
  assert.throws(
    () => gateway.resolveInternal(),
    (error: { code?: string }) => error.code === "unauthorized",
  );
});

// ---- search --------------------------------------------------------------------

test("workspace search and labels never cross a Space boundary", async () => {
  const h = await harness();
  const dataDir = h.dataDir;
  const store = createStore(join(dataDir, "sessions.db"));
  await h.seed(h.home, "alpha");
  await h.seed(h.work, "beta");

  const call = async (ctx: SpaceContext, path: string, method = "GET", body: Record<string, unknown> = {}) => {
    let payload: unknown;
    const url = new URL(`http://x${path}`);
    await orgRoutes({ spaces: h.gateway.services, store })({
      req: {}, res: {}, space: ctx, url, path: url.pathname, method,
      body: async () => body,
      json: (_code: number, value: unknown) => { payload = value; },
    } as never);
    return payload;
  };

  const homeHits = await call(h.home, "/api/search/workspaces?q=a") as { items: Array<{ title: string }> };
  assert.ok(homeHits.items.some((i) => i.title === "alpha"));
  assert.equal(homeHits.items.some((i) => i.title === "beta"), false);

  const workHits = await call(h.work, "/api/search/workspaces?q=a") as { items: Array<{ title: string }> };
  assert.ok(workHits.items.some((i) => i.title === "beta"));
  assert.equal(workHits.items.some((i) => i.title === "alpha"), false);

  // Labels are Space-owned: a name created in Home is invisible in Work, and
  // its id cannot be updated or deleted from there.
  const created = await call(h.home, "/api/labels", "POST", { name: "Secret", color: "#112233" }) as { id: string; revision: number };
  assert.deepEqual((await call(h.home, "/api/labels") as Array<{ name: string }>).map((l) => l.name), ["Secret"]);
  assert.deepEqual(await call(h.work, "/api/labels"), []);
  await assert.rejects(
    () => call(h.work, `/api/labels/${created.id}`, "PATCH", { name: "Taken", revision: created.revision }),
    (error: { code?: string }) => error.code === "not-found",
  );
  assert.deepEqual(await call(h.work, `/api/labels/${created.id}`, "DELETE"), { error: "not-found" });
  assert.deepEqual((await call(h.home, "/api/labels") as Array<{ name: string }>).map((l) => l.name), ["Secret"]);
});

// ---- HTTP gateway --------------------------------------------------------------

test("the HTTP gateway scopes by the active Space and refuses an unauthorized switch", async () => {
  const h = await harness();
  const inHome = await h.seed(h.home, "home");
  const inWork = await h.seed(h.work, "work");

  const server = createHttpServer({
    spaces: h.gateway,
    runtimes: {} as never,
    capabilities: () => [],
    webDist: tmp(),
    version: "test",
  });
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  try {
    // Default Space (Home): only Home's project and session.
    const homeProjects = await (await fetch(`${base}/api/projects`)).json() as Array<{ id: string }>;
    assert.deepEqual(homeProjects.map((p) => p.id), [inHome.projectId]);

    // Explicit Space header switches the whole view.
    const workProjects = await (await fetch(`${base}/api/projects`, {
      headers: { "x-polyth-space": h.work.spaceId },
    })).json() as Array<{ id: string }>;
    assert.deepEqual(workProjects.map((p) => p.id), [inWork.projectId]);

    // A real session id from the other Space is a 404 over HTTP too.
    assert.equal((await fetch(`${base}/api/sessions/${inWork.sessionId}`)).status, 404);
    assert.equal(
      (await fetch(`${base}/api/sessions/${inHome.sessionId}`, {
        headers: { "x-polyth-space": h.work.spaceId },
      })).status,
      404,
    );

    // A Space the caller does not belong to is refused, and refused the same
    // way an invented id is.
    const stranger = h.gateway.store.createSpace({
      name: "Stranger",
      ownerId: h.gateway.store.createUser("Stranger").id,
    });
    assert.equal((await fetch(`${base}/api/projects`, { headers: { "x-polyth-space": stranger.id } })).status, 404);
    assert.equal((await fetch(`${base}/api/projects`, { headers: { "x-polyth-space": "spc_invented" } })).status, 404);
  } finally {
    server.close();
  }
});

// ---- event fan-out --------------------------------------------------------------

function connect(port: number, headers: Record<string, string>): Promise<{
  ws: WebSocket;
  messages: Record<string, unknown>[];
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const messages: Record<string, unknown>[] = [];
  ws.on("message", (raw) => { messages.push(JSON.parse(String(raw)) as Record<string, unknown>); });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, messages }));
    ws.on("error", reject);
  });
}

/** Wait for a condition instead of a fixed sleep: the assertions below are
 *  about WHAT a socket receives, and a timing-based wait turns a real
 *  regression into a flake (and vice versa). */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Give the fan-out a chance to deliver something it must NOT deliver. */
const quietPeriod = () => new Promise((resolve) => setTimeout(resolve, 120));

test("a socket bound to one Space receives neither projections nor events from another", async () => {
  const h = await harness();
  const inHome = await h.seed(h.home, "home");
  const inWork = await h.seed(h.work, "work");

  const gateway = createWsGateway(
    // The unscoped service is what boot passes; per-socket scoping is the
    // gateway's job, which is exactly what this test exercises.
    h.gateway.services(h.home).sessions,
    undefined,
    undefined,
    h.gateway,
  );
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  gateway.attach(server, {
    identity: () => ({ authenticated: true, principal: { kind: "local-user", trustedLoopback: true } }),
  });
  server.listen(0);
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;

  const cookieFor = (ctx: SpaceContext) => `${h.gateway.cookieName}=${ctx.spaceId}`;
  const homeClient = await connect(port, { cookie: cookieFor(h.home) });
  const workClient = await connect(port, { cookie: cookieFor(h.work) });

  try {
    homeClient.ws.send(JSON.stringify({ type: "subscribe", sessionId: null }));
    workClient.ws.send(JSON.stringify({ type: "subscribe", sessionId: null }));

    const idsIn = (client: { messages: Record<string, unknown>[] }): string[] =>
      client.messages
        .filter((m) => m.type === "projections" || m.type === "projection")
        .flatMap((m) => (m.type === "projections"
          ? (m.sessions as SessionProjection[])
          : [m.session as SessionProjection]))
        .map((p) => p.id);

    await until(() => idsIn(homeClient).length > 0 && idsIn(workClient).length > 0, "the initial snapshots");

    // The initial snapshot is already tenant-scoped.
    assert.deepEqual(idsIn(homeClient), [inHome.sessionId]);
    assert.deepEqual(idsIn(workClient), [inWork.sessionId]);

    // Live fan-out is too: broadcasting Work's projection reaches only Work.
    const workProjection = await h.gateway.services(h.work).sessions.snapshot(inWork.sessionId);
    const homeProjection = await h.gateway.services(h.home).sessions.snapshot(inHome.sessionId);
    gateway.projection(workProjection);
    gateway.projection(homeProjection);
    await until(() => idsIn(homeClient).length === 2 && idsIn(workClient).length === 2, "the live projections");
    assert.deepEqual(idsIn(homeClient), [inHome.sessionId, inHome.sessionId]);
    assert.deepEqual(idsIn(workClient), [inWork.sessionId, inWork.sessionId]);

    // Session events carry no owner of their own, so fan-out consults the
    // store; a Work event must not reach the Home socket.
    gateway.event({
      id: "e1", sessionId: inWork.sessionId, seq: 99, time: Date.now(),
      type: "assistant/message", data: { text: "work secret" }, v: 1,
    } as never);
    await until(() => workClient.messages.some((m) => m.type === "event"), "Work's own event");
    await quietPeriod();
    const homeEvents = homeClient.messages.filter((m) => m.type === "event");
    const workEvents = workClient.messages.filter((m) => m.type === "event");
    assert.equal(homeEvents.length, 0);
    assert.equal(workEvents.length, 1);

    // Notifications are addressed by session too.
    gateway.notification({
      id: "n1", key: "k", kind: "completed", sessionId: inWork.sessionId,
      projectId: inWork.projectId, title: "done", body: "", ts: Date.now(), read: false,
    });
    await until(
      () => workClient.messages.some((m) => m.type === "notification/added"),
      "Work's own notification",
    );
    await quietPeriod();
    assert.equal(homeClient.messages.filter((m) => m.type === "notification/added").length, 0);
    assert.equal(workClient.messages.filter((m) => m.type === "notification/added").length, 1);
  } finally {
    homeClient.ws.close();
    workClient.ws.close();
    server.close();
  }
});

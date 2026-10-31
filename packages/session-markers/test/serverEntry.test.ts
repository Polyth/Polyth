import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type {
  AgentCapabilityContribution,
  JsonObject,
  RouteRequest,
  SessionProjection,
  SpaceContext,
} from "@polyth/contracts";
import type { ServerPackageHost } from "@polyth/plugins";
import registerPackage, { SESSION_MARKERS_REMOTE_ACCESS } from "../src/serverEntry.ts";
import { SESSION_MARKERS_TOOL_NAME } from "../src/agentTool.ts";
import type { MarkersSnapshot } from "../src/markers.ts";

const ctx = (spaceId: string, userId: string, role: SpaceContext["role"] = "member") =>
  ({ spaceId, userId, role, spaceSlug: spaceId, storageDir: "" }) as unknown as SpaceContext;

const projection = (id: string, spaceId: string, title: string, extra: Partial<SessionProjection> = {}): SessionProjection =>
  ({ id, projectId: `${spaceId}-project`, spaceId, title, status: "idle", createdAt: 1, updatedAt: 1, ...extra }) as SessionProjection;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "session-markers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projections = new Map<string, SessionProjection>([
    ["shared", projection("shared", "space", "Fix login", { updatedAt: 3 })],
    ["second", projection("second", "space", "Write docs", { updatedAt: 2 })],
    ["alice-private", projection("alice-private", "space", "Alice only")],
    ["foreign", projection("foreign", "other", "Someone else's")],
  ]);
  // alice may open every chat of "space"; bob not alice's private one.
  const canOpen = (space: SpaceContext, id: string) => {
    const row = projections.get(id);
    if (!row || row.spaceId !== space.spaceId) return false;
    return !(id === "alice-private" && space.userId !== "alice");
  };
  const registered: AgentCapabilityContribution[] = [];
  const disposed: string[] = [];
  const registry = {
    register: (_owner: string, contribution: AgentCapabilityContribution) => {
      registered.push(contribution);
      return { dispose: () => { disposed.push(contribution.descriptor.id); } };
    },
  };
  const host = {
    spaceStorage: (space: SpaceContext) => ({
      root: join(root, space.spaceId),
      packageDir: (id: string) => {
        const dir = join(root, space.spaceId, "packages", id);
        mkdirSync(dir, { recursive: true });
        return dir;
      },
      path: (relative: string) => join(root, space.spaceId, relative),
    }),
    forSpace: (space: SpaceContext) => ({
      sessions: {
        snapshot: async (id: string) => {
          if (!canOpen(space, id)) throw Object.assign(new Error("session not found"), { code: "not-found" });
          return { ...projections.get(id)! };
        },
      },
      projects: { get: async (id: string) => ({ id, name: `Project ${id}` }) },
    }),
    store: { projection: async (id: string) => projections.get(id) },
    personSpaceContext: (userId: string, spaceId: string) => userId === "stranger" ? undefined : ctx(spaceId, userId),
    systemSpaceContext: (spaceId: string) => ctx(spaceId, "system"),
    services: { get: () => registry },
  } as unknown as ServerPackageHost;
  const pkg = registerPackage(host);
  const call = async (space: SpaceContext, method: string, path: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown;
    const handled = await pkg.routes!({
      method,
      path,
      url: new URL(`http://localhost${path}`),
      space,
      body: async () => body,
      json: (code: number, value: unknown) => { status = code; payload = value; },
    } as unknown as RouteRequest);
    return { handled, status, body: payload as MarkersSnapshot & { error?: string; marker?: { id: string } } };
  };
  const storedFile = (spaceId: string) => join(root, spaceId, "packages/session-markers/markers.json");
  return { pkg, call, projections, registered, disposed, storedFile };
}

const alice = ctx("space", "alice");
const bob = ctx("space", "bob");

test("a person marks chats and reads them back with titles, newest first", async (t) => {
  const { call } = fixture(t);
  const empty = await call(alice, "GET", "/api/session-markers");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.definitions.map((marker) => marker.id), ["needs-review", "reply-later", "important"]);
  assert.deepEqual(empty.body.sessions, []);

  const marked = await call(alice, "POST", "/api/session-markers/apply", {
    sessionIds: ["second", "shared"],
    add: [{ marker: "needs-review", note: "check auth" }],
  });
  assert.equal(marked.status, 200);
  assert.deepEqual(marked.body.sessions.map((session) => [session.sessionId, session.title, session.markers[0]?.note]), [
    ["shared", "Fix login", "check auth"],
    ["second", "Write docs", "check auth"],
  ]);
  assert.deepEqual(marked.body.sessions[0]?.markers[0]?.by, { kind: "person", userId: "alice" });
  assert.equal((await call(alice, "GET", "/api/session-markers/unknown")).handled, false);
});

test("a foreign or hidden chat is refused like an absent one and nothing is written", async (t) => {
  const { call, storedFile } = fixture(t);
  for (const sessionId of ["foreign", "missing"]) {
    const refused = await call(alice, "POST", "/api/session-markers/apply", { sessionIds: ["shared", sessionId], add: ["important"] });
    assert.equal(refused.status, 404);
    assert.equal(refused.body.error, "not-found");
  }
  assert.equal(existsSync(storedFile("space")), false, "a refused batch writes nothing");
  const hidden = await call(bob, "POST", "/api/session-markers/apply", { sessionIds: ["alice-private"], add: ["important"] });
  assert.equal(hidden.status, 404);

  await call(alice, "POST", "/api/session-markers/apply", { sessionIds: ["alice-private", "shared"], add: ["important"] });
  const bobView = await call(bob, "GET", "/api/session-markers");
  assert.deepEqual(bobView.body.sessions.map((session) => session.sessionId), ["shared"], "bob never learns about alice's private chat");
  const aliceView = await call(alice, "GET", "/api/session-markers");
  assert.equal(aliceView.body.sessions.length, 2, "the hidden marker is kept for its owner");
  const otherSpace = await call(ctx("other", "alice"), "GET", "/api/session-markers");
  assert.deepEqual(otherSpace.body.sessions, [], "Spaces never share markers");
});

test("viewers can read but not change markers", async (t) => {
  const { call } = fixture(t);
  const viewer = ctx("space", "vera", "viewer");
  assert.equal((await call(viewer, "GET", "/api/session-markers")).status, 200);
  const refused = await call(viewer, "POST", "/api/session-markers/apply", { sessionIds: ["shared"], add: ["important"] });
  assert.equal(refused.status, 403);
  assert.equal((await call(viewer, "POST", "/api/session-markers/definitions", { label: "Mine" })).status, 403);
});

test("markers of a deleted chat are dropped", async (t) => {
  const { call, projections } = fixture(t);
  await call(alice, "POST", "/api/session-markers/apply", { sessionIds: ["shared", "second"], add: ["reply-later"] });
  projections.delete("second");
  const view = await call(alice, "GET", "/api/session-markers");
  assert.deepEqual(view.body.sessions.map((session) => session.sessionId), ["shared"]);
  projections.set("second", projection("second", "space", "Write docs"));
  assert.deepEqual((await call(alice, "GET", "/api/session-markers")).body.sessions.map((session) => session.sessionId), ["shared"]);
});

test("custom markers are created, restyled and deleted through the definitions routes", async (t) => {
  const { call } = fixture(t);
  const created = await call(alice, "POST", "/api/session-markers/definitions", { label: "Waiting for client", color: "green", icon: "clock" });
  assert.equal(created.status, 200);
  assert.equal(created.body.marker?.id, "waiting-for-client");
  await call(alice, "POST", "/api/session-markers/apply", { sessionIds: ["shared"], add: ["waiting for client"] });
  const updated = await call(alice, "POST", "/api/session-markers/definitions/update", { id: "waiting-for-client", label: "Client", color: "red" });
  assert.equal(updated.body.definitions.find((marker) => marker.id === "waiting-for-client")?.label, "Client");
  assert.equal((await call(alice, "POST", "/api/session-markers/definitions/update", { id: "important", label: "x" })).status, 400);
  assert.equal((await call(alice, "POST", "/api/session-markers/definitions", { label: "x", color: "pink" })).status, 400);
  const deleted = await call(alice, "POST", "/api/session-markers/definitions/delete", { id: "waiting-for-client" });
  assert.deepEqual(deleted.body.sessions, []);
  assert.equal((await call(alice, "POST", "/api/session-markers/definitions/delete", { id: "waiting-for-client" })).status, 404);
});

test("paired devices reach the routes only through session capabilities", () => {
  const rules = SESSION_MARKERS_REMOTE_ACCESS.http;
  assert.deepEqual(rules.find((rule) => rule.methods.includes("GET")), {
    methods: ["GET"], path: "/api/session-markers", capability: "core.sessions.read", mutation: false,
  });
  for (const rule of rules.filter((candidate) => candidate.methods.includes("POST"))) {
    assert.equal(rule.capability, "core.sessions.control");
    assert.equal(rule.mutation, true);
  }
});

const toolCtx = (sessionId: string, actorUserId?: string) => ({
  sessionId, projectId: "space-project", cwd: "/", spaceId: "space", ...(actorUserId ? { actorUserId } : {}),
});

test("agents find marked chats by marker name and mark chats themselves", async (t) => {
  const { pkg, call, registered, disposed } = fixture(t);
  await pkg.onEnable!();
  await pkg.onEnable!();
  const described = registered.map((contribution) => contribution.descriptor as { name?: string; instructions?: string });
  assert.deepEqual(described.map((descriptor) => descriptor.name), ["polyth-session-markers", SESSION_MARKERS_TOOL_NAME]);
  assert.match(described[0]!.instructions ?? "", /needs-review/);
  const tool = registered[1]!;
  const run = (input: JsonObject, sessionId = "shared", actor: string | undefined = "alice") => tool.execute!(input, toolCtx(sessionId, actor));

  await call(alice, "POST", "/api/session-markers/apply", { sessionIds: ["second", "alice-private"], add: [{ marker: "needs-review", note: "docs typo" }] });
  const listed = await run({ action: "list", marker: "Needs review" });
  assert.match(listed.output, /^2 chats marked “Needs review” \(needs-review\):/);
  assert.match(listed.output, /second · “Write docs” · project Project space-project/);
  assert.match(listed.output, /note: docs typo/);
  const bobList = await run({ action: "list", marker: "needs review" }, "shared", "bob");
  assert.doesNotMatch(bobList.output, /alice-private/, "the tool sees only what the turn's person can open");
  assert.match((await run({ action: "list", marker: "nonsense" })).output, /No marker named “nonsense”/);

  const added = await run({ action: "add", marker: "Waiting on CI", note: "pipeline 42" });
  assert.match(added.output, /Added “Waiting on CI” \(waiting-on-ci\) to this chat/);
  const got = await run({ action: "get" });
  assert.match(got.output, /waiting-on-ci \(Waiting on CI\) — marked .* by this chat's agent — note: pipeline 42/);
  assert.match((await run({ action: "markers" })).output, /waiting-on-ci \(Waiting on CI\) · custom/);

  await run({ action: "remove", marker: "needs-review", sessionIds: ["second"] });
  assert.doesNotMatch((await run({ action: "list", marker: "needs-review" }, "shared", "bob")).output, /second/);
  await assert.rejects(run({ action: "add", marker: "important", sessionId: "foreign" }), { code: "not-found" });
  await assert.rejects(run({ action: "explode" }), { code: "invalid-input" });
  await assert.rejects(run({ action: "list" }, "shared", "stranger"), { code: "forbidden" });

  await pkg.onDisable!();
  assert.deepEqual(disposed, ["session-markers.tool", "session-markers.skill"]);
});

test("a turn with no acting person may only mark its own chat", async (t) => {
  const { pkg, registered } = fixture(t);
  await pkg.onEnable!();
  const tool = registered.find((contribution) => contribution.descriptor.kind === "tool")!;
  const own = await tool.execute!({ action: "add", marker: "needs-review" }, toolCtx("shared"));
  assert.match(own.output, /to this chat/);
  await assert.rejects(tool.execute!({ action: "add", marker: "needs-review", sessionId: "second" }, toolCtx("shared")), { code: "forbidden" });
  const listed = await tool.execute!({ action: "list" }, toolCtx("shared"));
  assert.match(listed.output, /^1 chat with markers:/);
});

test("stored markers survive a restart of the package", async (t) => {
  const { call, storedFile } = fixture(t);
  await call(alice, "POST", "/api/session-markers/apply", { sessionIds: ["shared"], add: ["important"] });
  const stored = JSON.parse(readFileSync(storedFile("space"), "utf8")) as { version: number; sessions: Record<string, unknown> };
  assert.equal(stored.version, 1);
  assert.deepEqual(Object.keys(stored.sessions), ["shared"]);
});

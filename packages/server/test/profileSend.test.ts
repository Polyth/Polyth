// UX-COMPOSER-DISC server gates: the send request distinguishes an omitted
// (inherited) profile from explicit null (None) and a selected id; the
// projection persists the selection or clear; and one user/message carries
// the actually resolved configuration before the runtime starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type {
  AgentProfile, AgentRuntime, CanonicalTurnRequest, Project, ProjectService, RuntimeEvent,
} from "@polyth/contracts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import type { PermissionService } from "@polyth/permissions";

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

function fakeRuntime(harnessId?: string) {
  const listeners = new Set<Emit>();
  const started: CanonicalTurnRequest[] = [];
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const l of listeners) l(sessionId, ev);
  };
  const rt: AgentRuntime = {
    ...(harnessId ? { harnessId } : {}),
    capabilities: async () => ({ streaming: true, permissions: true, questions: true, compaction: false, subagents: false }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => {
      started.push(req);
      emit(req.sessionId, { type: "turn/started", turnId: `t${started.length}` });
    },
    abort: async (sessionId) => emit(sessionId, { type: "turn/stopped", reason: "aborted" }),
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return { rt, emit, started };
}

const PROFILE: AgentProfile = {
  id: "prof-1", name: "Fast planner", providerID: "acme", modelID: "quick",
  agent: "planner", features: {}, revision: 1, createdAt: 1, updatedAt: 1,
} as unknown as AgentProfile;

function makeService(fake: ReturnType<typeof fakeRuntime>) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-profile-send-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = {
    evaluate: () => "allow",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: { forProject: async () => fake.rt },
    profiles: { profileGet: async (id) => (id === PROFILE.id ? PROFILE : undefined) },
  });
  return { sessions, store };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

const idle = (id: string, fake: ReturnType<typeof fakeRuntime>) =>
  fake.emit(id, { type: "turn/stopped", reason: "completed" });

test("selected profile: resolved config in one user/message before startTurn; projection records the id", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  await sessions.send(id, { text: "go", agentProfileId: "prof-1" });
  await flush();

  // the resolved bundle reached the runtime
  assert.equal(fake.started.length, 1);
  assert.deepEqual(fake.started[0]!.model, { providerID: "acme", modelID: "quick" });
  assert.equal(fake.started[0]!.agent, "planner");

  // exactly one durable user/message with profile id + resolved configuration,
  // appended before the turn started
  const evs = await store.events(id);
  const userMsgs = evs.filter((e) => e.type === "user/message");
  assert.equal(userMsgs.length, 1);
  const data = userMsgs[0]!.data as {
    agentProfileId?: string; resolvedModel?: { providerID: string; modelID: string }; resolvedAgent?: string;
  };
  assert.equal(data.agentProfileId, "prof-1");
  assert.deepEqual(data.resolvedModel, { providerID: "acme", modelID: "quick" });
  assert.equal(data.resolvedAgent, "planner");
  const types = evs.map((e) => e.type);
  assert.ok(types.indexOf("user/message") < types.indexOf("turn/started"));

  // projection persists the selection
  const proj = await store.projection(id);
  assert.equal(proj?.agentProfileId, "prof-1");
  await store.close();
});

test("omitted profile inherits the stored one; explicit null clears it — never conflated", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  // 1) select
  await sessions.send(id, { text: "one", agentProfileId: "prof-1" });
  await flush();
  idle(id, fake);
  await flush();
  assert.equal((await store.projection(id))?.agentProfileId, "prof-1");

  // 2) omitted field: the stored profile still applies (inherited)
  await sessions.send(id, { text: "two" });
  await flush();
  assert.deepEqual(fake.started[1]!.model, { providerID: "acme", modelID: "quick" });
  assert.equal(fake.started[1]!.agent, "planner");
  assert.equal((await store.projection(id))?.agentProfileId, "prof-1", "inherit does not rewrite the projection");
  // the durable record names the actually applied profile
  const two = (await store.events(id)).filter((e) => e.type === "user/message")[1]!;
  assert.equal((two.data as { agentProfileId?: string }).agentProfileId, "prof-1");
  idle(id, fake);
  await flush();

  // 3) explicit null: the stored profile selection is cleared. The session's
  // persisted resolved model/agent continue to apply (the projection keeps
  // them "as it already does"), but no profile is claimed anywhere.
  await sessions.send(id, { text: "three", agentProfileId: null });
  await flush();
  assert.equal((await store.projection(id))?.agentProfileId, undefined, "explicit None clears the projection");
  const three = (await store.events(id)).filter((e) => e.type === "user/message")[2]!;
  const threeData = three.data as Record<string, unknown>;
  assert.equal(threeData.agentProfileId, null, "the clear is durable");
  assert.ok(!("resolvedModel" in threeData), "no bundle is claimed on a cleared send");
  idle(id, fake);
  await flush();

  // 4) after the clear, an omitted field inherits nothing: no profile id in
  // the durable record and none reappearing on the projection
  await sessions.send(id, { text: "four" });
  await flush();
  assert.equal((await store.projection(id))?.agentProfileId, undefined);
  const four = (await store.events(id)).filter((e) => e.type === "user/message")[3]!;
  assert.ok(!("agentProfileId" in (four.data as Record<string, unknown>)), "omitted stays omitted");
  await store.close();
});

test("explicit per-send model/agent still win over the profile bundle", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, {
    text: "go", agentProfileId: "prof-1",
    model: { providerID: "other", modelID: "big" }, agent: "reviewer",
  });
  await flush();
  assert.deepEqual(fake.started[0]!.model, { providerID: "other", modelID: "big" });
  assert.equal(fake.started[0]!.agent, "reviewer");
  idle(id, fake);
  await flush();
  await sessions.send(id, { text: "inherit" });
  await flush();
  assert.deepEqual(fake.started[1]!.model, { providerID: "acme", modelID: "quick" });
  assert.deepEqual((await store.projection(id))?.model, { providerID: "other", modelID: "big" });
  await store.close();
});

test("an explicitly requested unknown profile fails without recording anything", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await assert.rejects(
    () => sessions.send(id, { text: "go", agentProfileId: "ghost" }),
    (e: Error & { code?: string }) => e.code === "not-found",
  );
  assert.equal(fake.started.length, 0);
  assert.equal((await store.projection(id))?.agentProfileId, undefined, "unknown id never persisted");
  assert.equal((await store.events(id)).filter((e) => e.type === "user/message").length, 0);
  await store.close();
});

test("a legacy unqualified profile cannot execute under a non-OpenCode harness", async () => {
  const fake = fakeRuntime("codex");
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await assert.rejects(
    () => sessions.send(id, { text: "go", agentProfileId: "prof-1" }),
    (error: Error & { code?: string }) => error.code === "profile-harness-mismatch",
  );
  assert.equal(fake.started.length, 0);
  assert.equal((await store.events(id)).some((event) => event.type === "user/message"), false);
  await store.close();
});

test("a stored profile deleted later degrades without failing or substituting", async () => {
  const fake = fakeRuntime();
  const dir = mkdtempSync(join(tmpdir(), "polyth-profile-del-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  let deleted = false;
  const sessions = createSessionService({
    store,
    projects: {
      list: async () => [project], get: async () => project,
      add: async () => project, create: async () => project, remove: async () => {},
    },
    permissions: { evaluate: () => "allow", addRule: () => {}, rules: () => [] } as unknown as PermissionService,
    broadcast: { event: () => {}, projection: () => {} },
    queue: store,
    runtimes: { forProject: async () => fake.rt },
    profiles: { profileGet: async (id) => (!deleted && id === PROFILE.id ? PROFILE : undefined) },
  });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "one", agentProfileId: "prof-1" });
  await flush();
  idle(id, fake);
  await flush();

  deleted = true;
  // inherited-but-deleted: the send continues on the persisted resolved
  // model/agent (projection), and no unknown bundle is invented
  await sessions.send(id, { text: "two" });
  await flush();
  assert.equal(fake.started.length, 2);
  // model/agent persisted on the projection from the first resolved send
  assert.deepEqual(fake.started[1]!.model, { providerID: "acme", modelID: "quick" });
  const second = (await store.events(id)).filter((e) => e.type === "user/message")[1]!;
  assert.ok(!("agentProfileId" in (second.data as Record<string, unknown>)),
    "a deleted profile is never claimed in the durable record");
  await store.close();
});

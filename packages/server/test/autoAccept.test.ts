// F18 auto-accept: policy-approved requests append BOTH events at once
// (requested + resolved{auto:true}) and never notify; deny rules still win;
// subagents inherit the nearest parent's policy with child opt-out; enabling
// reconciles already-pending requests; composer-shell confirmations stay manual.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type { AgentRuntime, Project, ProjectService, RuntimeEvent } from "@polyth/contracts";
import { createAutoAcceptStore, type PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

function fakeRuntime() {
  const listeners = new Set<Emit>();
  const permissionReplies: Array<{ requestId: string; reply: string }> = [];
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const l of listeners) l(sessionId, ev);
  };
  const rt: AgentRuntime = {
    harnessId: "opencode",
    capabilities: async () => ({ streaming: true, permissions: true, questions: true, compaction: false, subagents: true }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => `be_${c.sessionId}`,
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => { emit(req.sessionId, { type: "turn/started", turnId: "t1" }); },
    abort: async () => {},
    replyPermission: async (_s, requestId, reply) => { permissionReplies.push({ requestId, reply }); },
    replyQuestion: async () => {},
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return { rt, emit, permissionReplies };
}

const flush = () => new Promise((r) => setTimeout(r, 25));

function harness(opts: { permission?: "allow" | "deny" | "ask"; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "polyth-aa-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: dir, name: "p", spaceId: "space-a", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  let permission = opts.permission ?? "ask";
  const permissions = {
    evaluate: () => permission,
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const attention: Array<{ sessionId: string; kind: string }> = [];
  const stopped: Array<{ sessionId: string; reason: string }> = [];
  const statuses: string[] = [];
  const broadcasts: string[] = [];
  const broadcast: Broadcaster = {
    event: (event) => broadcasts.push(event.type),
    projection: (projection) => statuses.push(projection.status),
  };
  const fake = fakeRuntime();
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    runtimes: { forProject: async () => fake.rt },
    autoAccept: createAutoAcceptStore(join(dir, "auto-accept.json")),
    notify: {
      attention: (sessionId, kind) => attention.push({ sessionId, kind }),
      turnStopped: (sessionId, reason) => stopped.push({ sessionId, reason }),
    },
    shell: { run: async () => ({ output: "ok", exitCode: 0, timedOut: false, truncated: false }) },
  });
  return {
    sessions, store, fake, attention, stopped, statuses, broadcasts,
    setPermission: (value: "allow" | "deny" | "ask") => { permission = value; },
  };
}

test("project-scoped agent tool pauses in the active canonical session until approved", async () => {
  const { sessions, store, fake, attention } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "do the requested package action" });
  await flush();

  const decision = sessions.requestAgentToolPermission({
    spaceId: "space-a",
    projectId: "p1",
    cwd: (await store.projection(id))?.runtimeBinding?.location.directory ?? "",
    harnessId: "opencode",
    toolId: "example-feature.write",
    toolName: "write",
    owner: "example-feature",
  });
  await flush();

  const requested = (await store.events(id)).find((event) =>
    event.type === "permission/requested"
    && (event.data as { permission?: string }).permission === "package-tool");
  assert.ok(requested);
  assert.equal((await store.projection(id))?.status, "waiting");
  assert.deepEqual(attention, [{ sessionId: id, kind: "permission" }]);
  await sessions.replyPermission(
    id,
    (requested.data as { requestId: string }).requestId,
    "once",
  );
  assert.equal(await decision, "allow");
  assert.deepEqual(fake.permissionReplies, [], "package-tool approval is owned by Polyth, not forwarded to the harness");
  assert.ok((await store.events(id)).some((event) =>
    event.type === "permission/resolved"
    && (event.data as { requestId?: string }).requestId === (requested.data as { requestId: string }).requestId));
});

test("a deny rule added while agent-tool approval is pending still wins", async () => {
  const { sessions, store, setPermission } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.send(id, { text: "do the requested package action" });
  await flush();
  const projection = await store.projection(id);
  const decision = sessions.requestAgentToolPermission({
    spaceId: "space-a",
    projectId: "p1",
    cwd: projection?.runtimeBinding?.location.directory ?? "",
    harnessId: "opencode",
    toolId: "example-feature.write",
    toolName: "write",
    owner: "example-feature",
  });
  await flush();
  const requested = (await store.events(id)).find((event) =>
    event.type === "permission/requested"
    && (event.data as { permission?: string }).permission === "package-tool");
  assert.ok(requested);

  setPermission("deny");
  await sessions.replyPermission(id, (requested.data as { requestId: string }).requestId, "once");
  assert.equal(await decision, "deny");
});

test("agent tool authorization fails closed for idle, foreign-Space, and ambiguous sessions", async () => {
  const { sessions, store } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "Idle" });
  const projection = await store.projection(id);
  const request = (spaceId: string, harnessId = "opencode") => sessions.requestAgentToolPermission({
    spaceId,
    projectId: "p1",
    cwd: projection?.runtimeBinding?.location.directory ?? "",
    harnessId,
    toolId: "example-feature.write",
    toolName: "write",
    owner: "example-feature",
  });
  assert.equal(await request("space-a"), "permission-required");

  await sessions.send(id, { text: "first active turn" });
  await flush();
  assert.equal(await request("space-b"), "permission-required");
  assert.equal(await request("space-a", "claude"), "permission-required");

  const { id: second } = await sessions.create({ projectId: "p1", title: "Also active" });
  await sessions.send(second, { text: "second active turn" });
  await flush();
  assert.equal(await sessions.requestAgentToolPermission({
    spaceId: "space-a",
    projectId: "p1",
    cwd: projection?.runtimeBinding?.location.directory ?? "",
    harnessId: "opencode",
    toolId: "example-feature.write",
    toolName: "write",
    owner: "example-feature",
  }), "permission-required");
  assert.equal((await store.events(id)).some((event) => event.type === "permission/requested"), false);
  assert.equal((await store.events(second)).some((event) => event.type === "permission/requested"), false);
});

test("auto-accept on: request resolves with auto:true, runtime replied, no notify", async () => {
  const { sessions, store, fake, attention, broadcasts } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  const r = await sessions.autoAcceptSet!(id, "on");
  assert.deepEqual(r, { setting: "on", effective: true });
  assert.equal((await store.projection(id))?.autoAccept, true);
  assert.equal((await store.projection(id))?.autoAcceptSetting, "on");

  fake.emit(id, { type: "permission/requested", requestId: "per_1", permission: "edit", patterns: ["src/*"] });
  await flush();

  const evs = await store.events(id);
  const req = evs.find((e) => e.type === "permission/requested");
  const res = evs.find((e) => e.type === "permission/resolved");
  assert.ok(req, "requested stays in the log — it must remain truthful");
  assert.ok(res);
  const durableIntent = evs.filter((event) => event.seq > req!.seq && event.seq < res!.seq);
  assert.deepEqual(
    durableIntent.map((event) => event.type),
    [
      "permission/response-intended",
      "mutation/prepared",
      "mutation/claimed",
      "mutation/confirmed",
    ],
  );
  assert.equal(durableIntent.every((event) => event.ignorable === true), true);
  assert.deepEqual(durableIntent[0]?.data, {
    requestId: "per_1",
    reply: "once",
    auto: true,
  });
  assert.deepEqual(res!.data, { requestId: "per_1", reply: "once", auto: true });
  assert.deepEqual(fake.permissionReplies, [{ requestId: "per_1", reply: "once" }]);
  assert.notEqual((await store.projection(id))?.status, "waiting");
  assert.equal(attention.length, 0); // auto-accepted cards never notify
  assert.equal(
    broadcasts.includes("permission/requested"),
    false,
    "an automatically resolved request is never published as a permission window",
  );
});

test("deny rules beat auto-accept", async () => {
  const { sessions, store, fake } = harness({ permission: "deny" });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await sessions.autoAcceptSet!(id, "on");

  fake.emit(id, { type: "permission/requested", requestId: "per_1", permission: "edit", patterns: ["/etc/*"] });
  await flush();

  const res = (await store.events(id)).find((e) => e.type === "permission/resolved");
  assert.deepEqual(res!.data, { requestId: "per_1", reply: "reject" });
  assert.deepEqual(fake.permissionReplies, [{ requestId: "per_1", reply: "reject" }]);
});

test("subagent inherits the nearest parent's policy; child opt-out wins", async () => {
  const { sessions, store, fake, attention } = harness();
  const { id: parent } = await sessions.create({ projectId: "p1", title: "Parent" });
  await sessions.autoAcceptSet!(parent, "on");

  // child created AFTER enabling: projection flag inherited at birth
  const { id: child } = await sessions.create({ projectId: "p1", title: "Child", parentId: parent });
  assert.equal((await store.projection(child))?.autoAccept, true);
  assert.deepEqual(await sessions.autoAcceptGet!(child), { setting: "inherit", effective: true });

  fake.emit(child, { type: "permission/requested", requestId: "per_c", permission: "bash", patterns: ["npm test"] });
  await flush();
  const res = (await store.events(child)).find((e) => e.type === "permission/resolved");
  assert.deepEqual(res!.data, { requestId: "per_c", reply: "once", auto: true });

  // explicit child opt-out: next request waits like normal
  await sessions.autoAcceptSet!(child, "off");
  assert.equal((await store.projection(child))?.autoAccept, false);
  assert.equal((await store.projection(parent))?.autoAccept, true); // parent untouched
  fake.emit(child, { type: "permission/requested", requestId: "per_c2", permission: "bash", patterns: ["rm -rf"] });
  await flush();
  assert.equal((await store.projection(child))?.status, "waiting");
  assert.deepEqual(attention, [{ sessionId: child, kind: "permission" }]);
});

test("enabling reconciles pending requests and leaves idle when no turn is active", async () => {
  const { sessions, store, fake, attention } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  fake.emit(id, { type: "permission/requested", requestId: "per_1", permission: "edit", patterns: ["a"] });
  fake.emit(id, { type: "permission/requested", requestId: "per_2", permission: "edit", patterns: ["b"] });
  await flush();
  assert.equal((await store.projection(id))?.status, "waiting");
  assert.equal(attention.length, 2); // real pending cards did notify

  await sessions.autoAcceptSet!(id, "on");
  await flush();

  const evs = await store.events(id);
  const resolved = evs.filter((e) => e.type === "permission/resolved");
  assert.equal(resolved.length, 2);
  for (const r of resolved) assert.equal((r.data as { auto?: boolean }).auto, true);
  assert.deepEqual(
    fake.permissionReplies.map((p) => p.requestId).sort(),
    ["per_1", "per_2"],
  );
  assert.equal(
    (await store.projection(id))?.status,
    "idle",
    "no active turn → resolving the last open request returns idle",
  );

  // disabling flips the flag back and new requests wait again
  await sessions.autoAcceptSet!(id, "off");
  assert.equal((await store.projection(id))?.autoAccept, false);

  fake.emit(id, { type: "permission/requested", requestId: "per_3", permission: "edit", patterns: ["c"] });
  await flush();
  assert.equal((await store.projection(id))?.status, "waiting");
  assert.equal(
    (await store.events(id)).some((event) =>
      event.type === "permission/requested"
      && (event.data as { requestId?: string }).requestId === "per_3"),
    true,
  );
  assert.equal(
    (await store.events(id)).some((event) =>
      event.type === "permission/resolved"
      && (event.data as { requestId?: string }).requestId === "per_3"),
    false,
    "turning Auto-Approve off restores prompting for future requests immediately",
  );
});

test("enabling drains a stale queued request even when projection status is not waiting", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await store.append(id, "permission/requested", {
    requestId: "per_stale",
    permission: "bash",
    patterns: ["npm test"],
  }, { ignorable: true });
  await store.upsertProjection({ ...(await store.projection(id))!, status: "idle" });

  await sessions.autoAcceptSet!(id, "on");
  await flush();

  assert.deepEqual(fake.permissionReplies, [{ requestId: "per_stale", reply: "once" }]);
  assert.ok((await store.events(id)).some((event) =>
    event.type === "permission/resolved"
    && (event.data as { requestId?: string; auto?: boolean }).requestId === "per_stale"
    && (event.data as { auto?: boolean }).auto === true));
});

test("setting survives a server reload and resumed job uses it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-aa-restart-"));
  const first = harness({ dir });
  const { id } = await first.sessions.create({ projectId: "p1", title: "T" });
  await first.sessions.autoAcceptSet!(id, "on");
  await first.store.close();

  const resumed = harness({ dir });
  assert.deepEqual(await resumed.sessions.autoAcceptGet!(id), { setting: "on", effective: true });
  assert.equal((await resumed.store.projection(id))?.autoAcceptSetting, "on");
  await resumed.sessions.send(id, { text: "continue" });
  resumed.fake.emit(id, {
    type: "permission/requested",
    requestId: "per_resumed",
    permission: "bash",
    patterns: ["git status"],
  });
  await flush();

  assert.deepEqual(resumed.fake.permissionReplies, [{ requestId: "per_resumed", reply: "once" }]);
  assert.equal(resumed.broadcasts.includes("permission/requested"), false);
  await resumed.store.close();
});

test("legacy JSON setting migrates once into canonical session persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-aa-migrate-"));
  const original = harness({ dir });
  const { id } = await original.sessions.create({ projectId: "p1", title: "T" });
  await original.store.close();
  createAutoAcceptStore(join(dir, "auto-accept.json")).set(id, "on");

  const migrated = harness({ dir });
  await waitFor(async () => (await migrated.store.projection(id))?.autoAcceptSetting === "on");

  assert.deepEqual(await migrated.sessions.autoAcceptGet!(id), { setting: "on", effective: true });
  assert.doesNotMatch(readFileSync(join(dir, "auto-accept.json"), "utf8"), new RegExp(id));
  await migrated.store.close();
});

test("enabling reconciles pending requests back to working while a turn is active", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/started", turnId: "t1" });
  fake.emit(id, { type: "permission/requested", requestId: "per_w", permission: "edit", patterns: ["a"] });
  await flush();
  assert.equal((await store.projection(id))?.status, "waiting");

  await sessions.autoAcceptSet!(id, "on");
  await flush();
  assert.equal((await store.projection(id))?.status, "working");
});

test("composer-shell confirmations are never auto-reconciled", async () => {
  const { sessions, store } = harness({ permission: "ask" });
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  const r = await sessions.runShell!(id, "echo hi");
  assert.equal(r.status, "pending"); // user's own command awaits confirmation

  await sessions.autoAcceptSet!(id, "on");
  await flush();

  const evs = await store.events(id);
  const resolved = evs.filter((e) => e.type === "permission/resolved");
  assert.equal(resolved.length, 0, "shell confirmation must stay manual");
  assert.equal((await store.projection(id))?.status, "waiting");
});

test("turn lifecycle reaches the notify seam once per terminal turn", async () => {
  const { sessions, fake, stopped } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  fake.emit(id, { type: "turn/stopped", reason: "error", error: "boom" });
  await flush();
  assert.deepEqual(stopped, [
    { sessionId: id, reason: "completed" },
  ], "a later terminal stop for the same turn is deduplicated");
});

test("error stop + open permission → waiting → resolve → failed; queue stays", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await store.enqueue(id, "queued after fail", "follow-up");
  fake.emit(id, { type: "turn/started", turnId: "t-err" });
  fake.emit(id, {
    type: "permission/requested",
    requestId: "per_err",
    permission: "bash",
    patterns: ["ls"],
  });
  await flush();
  assert.equal((await store.projection(id))?.status, "waiting");

  fake.emit(id, { type: "turn/stopped", reason: "error", error: "boom" });
  await flush();
  assert.equal((await store.projection(id))?.status, "waiting");
  const interrupt = await store.enqueue(id, "late interrupt", "interrupt");
  const queued = await store.queueList(id);
  await store.queueReorder(id, [interrupt.id, ...queued.filter((item) => item.id !== interrupt.id).map((item) => item.id)]);

  await sessions.replyPermission(id, "per_err", "once");
  await flush();
  assert.equal((await store.projection(id))?.status, "failed");
  assert.equal((await store.queueList(id)).length, 2);
  await store.close();
});

test("queued interrupt turns a runtime error into a durable abort", async () => {
  const { sessions, store, fake, statuses } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/started", turnId: "t-abort" });
  fake.emit(id, { type: "permission/requested", requestId: "per_abort", permission: "bash", patterns: ["ls"] });
  await store.enqueue(id, "interrupt now", "interrupt");
  await flush();

  fake.emit(id, { type: "turn/stopped", reason: "error", error: "Aborted" });
  await flush();
  assert.equal((await store.events(id)).findLast((event) => event.type === "turn/stopped")?.data.reason, "aborted");
  assert.equal((await store.projection(id))?.status, "waiting");

  await sessions.replyPermission(id, "per_abort", "once");
  await waitFor(async () => (await store.queueList(id)).length === 0);
  assert.equal((await store.projection(id))?.status, "working");
  assert.equal(statuses.includes("idle"), true);
  assert.equal(statuses.includes("failed"), false);
  await store.close();
});

const waitFor = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
};

test("WS23: permission pending → waiting; resolve → working", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/started", turnId: "t1" });
  fake.emit(id, {
    type: "permission/requested",
    requestId: "per_1",
    permission: "edit",
    patterns: ["a.ts"],
  });
  await waitFor(async () => (await store.projection(id))?.status === "waiting");

  await sessions.replyPermission(id, "per_1", "once");
  await waitFor(async () => (await store.projection(id))?.status === "working");
  await store.close();
});

test("WS23: question pending → waiting; resolve → working", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/started", turnId: "t1" });
  fake.emit(id, {
    type: "question/asked",
    requestId: "q_1",
    questions: [{ id: "continue", prompt: "Continue?" }],
  });
  await waitFor(async () => (await store.projection(id))?.status === "waiting");

  await sessions.replyQuestion(id, "q_1", { continue: "yes" });
  await waitFor(async () => (await store.projection(id))?.status === "working");
  await store.close();
});

test("WS23: turn/stopped with an open permission stays waiting then idles", async () => {
  const { sessions, store, fake } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  fake.emit(id, { type: "turn/started", turnId: "t1" });
  fake.emit(id, {
    type: "permission/requested",
    requestId: "per_open",
    permission: "bash",
    patterns: ["rm"],
  });
  await waitFor(async () => (await store.projection(id))?.status === "waiting");

  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await waitFor(async () =>
    (await store.events(id)).some((e) => e.type === "turn/stopped"));
  assert.equal((await store.projection(id))?.status, "waiting");

  await sessions.replyPermission(id, "per_open", "reject");
  await waitFor(async () => (await store.projection(id))?.status === "idle");
  await flush();
  await store.close();
});

test("child auto-accept never creates a duplicate parent permission path", async () => {
  const { sessions, store, fake } = harness();
  const { id: parent } = await sessions.create({ projectId: "p1", title: "Parent" });
  await sessions.autoAcceptSet!(parent, "on");
  const { id: child } = await sessions.create({
    projectId: "p1",
    title: "Child",
    parentId: parent,
  });

  fake.emit(child, {
    type: "permission/requested",
    requestId: "per_mirror",
    permission: "bash",
    patterns: ["npm test"],
  });
  await waitFor(async () =>
    (await store.events(child)).some((e) => e.type === "permission/resolved"));

  assert.notEqual((await store.projection(child))?.status, "waiting");
  assert.equal((await store.events(parent)).some((e) =>
    (e.type === "permission/requested" || e.type === "permission/resolved")
    && (e.data as { requestId?: string }).requestId === "per_mirror"), false);
  assert.notEqual((await store.projection(parent))?.status, "waiting");
  await store.close();
});

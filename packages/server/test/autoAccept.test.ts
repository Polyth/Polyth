// F18 auto-accept: policy-approved requests append BOTH events at once
// (requested + resolved{auto:true}) and never notify; deny rules still win;
// subagents inherit the nearest parent's policy with child opt-out; enabling
// reconciles already-pending requests; composer-shell confirmations stay manual.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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

function harness(opts: { permission?: "allow" | "deny" | "ask" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-aa-"));
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
    evaluate: () => opts.permission ?? "ask",
    addRule: () => {},
    rules: () => [],
  } as unknown as PermissionService;
  const attention: Array<{ sessionId: string; kind: string }> = [];
  const stopped: Array<{ sessionId: string; reason: string }> = [];
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
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
  return { sessions, store, fake, attention, stopped };
}

test("auto-accept on: request resolves with auto:true, runtime replied, no notify", async () => {
  const { sessions, store, fake, attention } = harness();
  const { id } = await sessions.create({ projectId: "p1", title: "T" });

  const r = await sessions.autoAcceptSet!(id, "on");
  assert.deepEqual(r, { setting: "on", effective: true });
  assert.equal((await store.projection(id))?.autoAccept, true);

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
  assert.deepEqual(res!.data, { requestId: "per_1", reply: "once", auto: true });
  assert.deepEqual(fake.permissionReplies, [{ requestId: "per_1", reply: "once" }]);
  assert.notEqual((await store.projection(id))?.status, "waiting");
  assert.equal(attention.length, 0); // auto-accepted cards never notify
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

  await sessions.replyPermission(id, "per_err", "once");
  await flush();
  assert.equal((await store.projection(id))?.status, "failed");
  await flush();
  assert.equal((await store.projection(id))?.status, "failed");
  assert.equal((await store.queueList(id)).length, 1);
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
  await store.close();
});

test("WS23: child auto-accept closes parent mirror waiting status", async () => {
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
  assert.ok((await store.events(parent)).some((e) =>
    e.type === "permission/resolved"
    && (e.data as { requestId?: string }).requestId === "per_mirror"));
  assert.notEqual((await store.projection(parent))?.status, "waiting");
  await store.close();
});


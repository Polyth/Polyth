// Per-message Fork publication, truthful Revert/Fork guards,
// and all-or-nothing failure behavior at the session-service seam.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore, deriveMessages, planRuntimeEpochRecovery, runtimeEpochRecoveryPending } from "@polyth/session";
import type {
  AgentRuntime, ForkDraft, ModelMessage, Project, ProjectService, RuntimeBranchRequest, RuntimeEvent,
  SessionPersistence,
} from "@polyth/contracts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import type { PermissionService } from "@polyth/permissions";

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

function fakeRuntime(opts: { branchError?: string; fork?: boolean } = {}) {
  const listeners = new Set<Emit>();
  const startedTexts: string[] = [];
  const branchRequests: Array<{ sourceSessionId: string; targetSessionId: string; history: ModelMessage[] }> = [];
  const discarded: string[] = [];
  const ensured: string[] = [];
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const l of listeners) l(sessionId, ev);
  };
  const rt: AgentRuntime = {
    // A harness without native fork (Claude Code, Codex, Pi…) reports its id.
    ...(opts.fork === false ? { harnessId: "claude" } : {}),
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false, steering: false,
      attachments: { modalities: { file: "native" } },
      ...(opts.fork !== undefined ? { fork: opts.fork } : {}),
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c) => { ensured.push(c.sessionId); return `be_${c.sessionId}`; },
    branchSession: async (request: RuntimeBranchRequest) => {
      if (opts.branchError) {
        throw Object.assign(new Error(opts.branchError), {
          code: opts.branchError === "history-mismatch" ? "history-mismatch" : "internal",
        });
      }
      branchRequests.push({
        sourceSessionId: request.sourceSessionId,
        targetSessionId: request.target.sessionId,
        history: request.history,
      });
      return `branch_${branchRequests.length}`;
    },
    discardSession: async (sessionId: string) => { discarded.push(sessionId); },
    sessions: async () => [],
    history: async () => [],
    startTurn: async (req) => {
      startedTexts.push(req.text);
      emit(req.sessionId, { type: "turn/started", turnId: `t${startedTexts.length}` });
    },
    abort: async (sessionId) => { emit(sessionId, { type: "turn/stopped", reason: "aborted" }); },
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(cb) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    dispose: async () => {},
  };
  return { rt, emit, startedTexts, branchRequests, discarded, ensured };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

function makeService(fake: ReturnType<typeof fakeRuntime>, wrapStore?: (store: SessionPersistence) => SessionPersistence) {
  const dir = mkdtempSync(join(tmpdir(), "polyth-msgactions-"));
  const raw = createStore(join(dir, "s.db"));
  const store = wrapStore ? wrapStore(raw) : raw;
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
    store, projects, permissions, broadcast, queue: raw,
    runtimes: { forProject: async () => fake.rt },
  });
  return { sessions, store: raw };
}

/** Two completed turns; returns the second prompt's seq. */
async function seedTwoTurns(fake: ReturnType<typeof fakeRuntime>, sessions: ReturnType<typeof makeService>["sessions"], id: string) {
  await sessions.send(id, { text: "first" });
  await flush();
  fake.emit(id, { type: "assistant/message", partId: "a1", text: "one" });
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
  await sessions.send(id, {
    text: "second",
    attachments: [{ id: "att1", name: "README.md", mime: "text/markdown", size: 5, kind: "file", path: "README.md" }],
  });
  await flush();
  fake.emit(id, { type: "assistant/message", partId: "a2", text: "two" });
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();
}

const assertForkOperationTail = (
  before: Awaited<ReturnType<ReturnType<typeof createStore>["events"]>>,
  after: Awaited<ReturnType<ReturnType<typeof createStore>["events"]>>,
  terminal: "mutation/confirmed" | "mutation/rejected",
): void => {
  assert.deepEqual(after.slice(0, before.length), before);
  const tail = after.slice(before.length);
  assert.deepEqual(tail.map((event) => event.type), [
    "session/fork-intended",
    "mutation/prepared",
    "mutation/claimed",
    terminal,
  ]);
  assert.equal(tail.every((event) => event.ignorable === true), true);
  const operationIds = tail.slice(1).map((event) =>
    (event.data as { operationId?: string }).operationId);
  assert.equal(operationIds.every((id) => id === operationIds[0]), true);
  assert.equal((tail[1]!.data as { mutationKind?: string }).mutationKind, "session-fork");
};

test("per-message fork excludes the prompt, seeds the draft, and branches exact history", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);
  const sourceEvents = await store.events(id);
  const second = sourceEvents.filter((e) => e.type === "user/message")[1]!;

  const sanitized = {
    id: "att1", name: "README.md", mime: "text/markdown", size: 5, kind: "file", path: "README.md",
    // Raw file URLs are session-scoped so they resolve in the right worktree.
    url: `/api/files/raw?projectId=p1&path=README.md&sessionId=${id}`,
  };
  const result = await sessions.fork(id, second.seq);
  assert.notEqual(result.id, id);
  assert.equal(result.fromSessionId, id);
  assert.equal(result.sourceAtSeq, second.seq);
  assert.deepEqual(result.draft, { text: "second", attachments: [sanitized] } as ForkDraft);

  // backend prefix = deriveMessages(child prefix): the target input is absent
  assert.equal(fake.branchRequests.length, 1);
  assert.equal(fake.branchRequests[0]!.sourceSessionId, id);
  assert.equal(fake.branchRequests[0]!.targetSessionId, result.id);
  assert.deepEqual(fake.branchRequests[0]!.history, [
    { role: "user", parts: [{ type: "text", text: "first" }] },
    { role: "assistant", parts: [{ type: "text", text: "one" }] },
  ]);

  const childEvents = await store.events(result.id);
  const marker = childEvents[childEvents.length - 1]!;
  assert.equal(marker.type, "session/forked");
  assert.equal(marker.ignorable, true);
  assert.deepEqual(marker.data, {
    fromSessionId: id,
    sourceAtSeq: second.seq,
    copiedThroughSeq: second.seq - 1,
    draft: { text: "second", attachments: [sanitized] },
  });
  // no copied second prompt anywhere in the child
  assert.equal(childEvents.some((e) => e.type === "user/message" && (e.data as { text?: string }).text === "second"), false);
  // copied events keep exact source times and record provenance
  const copied = childEvents.slice(0, -1);
  const prefix = sourceEvents.filter((e) => e.seq < second.seq);
  assert.deepEqual(copied.map((e) => [e.type, e.time]), prefix.map((e) => [e.type, e.time]));
  assert.deepEqual(copied.map((e) => e.sourceEventSeqs), prefix.map((e) => [e.seq]));
  assert.equal(new Set(copied.map((e) => e.id)).size, copied.length);
  assert.equal(copied.some((e) => prefix.some((s) => s.id === e.id)), false);

  const childProj = await store.projection(result.id);
  assert.equal(childProj?.parentId, id);
  assert.equal(childProj?.backendSessionId, "branch_1");
  assert.equal(childProj?.status, "idle");

  // The source history is unchanged; the durable fork intent and operation
  // outcome are appended as ignorable audit facts.
  assertForkOperationTail(sourceEvents, await store.events(id), "mutation/confirmed");
  assert.deepEqual(deriveMessages(childEvents), [
    { role: "user", parts: [{ type: "text", text: "first" }] },
    { role: "assistant", parts: [{ type: "text", text: "one" }] },
  ]);
  await store.close();
});

test("whole-session fork copies the complete effective history and creates no draft", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);

  const result = await sessions.fork(id);
  assert.equal(result.fromSessionId, id);
  assert.equal(result.sourceAtSeq, undefined);
  assert.equal(result.draft, undefined);
  assert.deepEqual(fake.branchRequests[0]!.history, deriveMessages(await store.events(id)));
  const childEvents = await store.events(result.id);
  const marker = childEvents[childEvents.length - 1]!;
  assert.equal(marker.type, "session/forked");
  assert.equal((marker.data as { draft?: unknown }).draft, undefined);
  assert.deepEqual(deriveMessages(childEvents), deriveMessages(await store.events(id)));
  await store.close();
});

test("fork of the first prompt has an empty prefix and a fresh backend", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);
  const first = (await store.events(id)).find((e) => e.type === "user/message")!;

  const result = await sessions.fork(id, first.seq);
  // empty model prefix: no branch call, a fresh backend session instead
  assert.equal(fake.branchRequests.length, 0);
  assert.deepEqual(fake.ensured.filter((s) => s === result.id), [result.id]);
  assert.equal((await store.projection(result.id))?.backendSessionId, `be_${result.id}`);
  assert.deepEqual(deriveMessages(await store.events(result.id)), []);
  assert.equal(result.draft?.text, "first");
  await store.close();
});

/** A continuity fork: the exact canonical prefix, then the continuity marker
 *  and the lineage marker; no native session until the child is used. */
const assertContinuityChild = async (
  store: ReturnType<typeof makeService>["store"],
  sourceId: string,
  childId: string,
  second: { seq: number },
): Promise<void> => {
  const sourceEvents = await store.events(sourceId);
  const childEvents = await store.events(childId);
  const prefix = sourceEvents.filter((e) => e.seq < second.seq);
  assert.deepEqual(childEvents.slice(0, prefix.length).map((e) => [e.type, e.time]), prefix.map((e) => [e.type, e.time]));
  assert.deepEqual(childEvents.slice(prefix.length).map((e) => e.type), ["session/snapshot-imported", "session/forked"]);
  assert.deepEqual(childEvents[prefix.length]!.data, { mode: "fork", fromSessionId: sourceId, copiedThroughSeq: second.seq - 1 });
  assert.equal(childEvents.slice(prefix.length).every((e) => e.ignorable === true), true);
  const childProj = await store.projection(childId);
  assert.equal(childProj?.parentId, sourceId);
  assert.equal(childProj?.status, "idle");
  assert.equal(childProj?.backendSessionId, undefined);
  assert.equal(childProj?.runtimeBinding, undefined);
  assert.equal(childProj?.runtimeLeg, undefined);
  assert.deepEqual(deriveMessages(childEvents), [
    { role: "user", parts: [{ type: "text", text: "first" }] },
    { role: "assistant", parts: [{ type: "text", text: "one" }] },
  ]);
};

test("a runtime without native fork gets a continuity fork whose first prompt carries the prefix", async () => {
  const fake = fakeRuntime({ fork: false });
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);
  const before = await store.events(id);
  const second = before.filter((e) => e.type === "user/message")[1]!;

  const result = await sessions.fork(id, second.seq);
  assert.equal(result.fromSessionId, id);
  assert.equal(result.sourceAtSeq, second.seq);
  assert.equal(result.draft?.text, "second");
  // Nothing native was asked for, and the source log is untouched.
  assert.equal(fake.branchRequests.length, 0);
  assert.deepEqual(fake.ensured.filter((s) => s === result.id), []);
  assert.deepEqual(await store.events(id), before);
  await assertContinuityChild(store, id, result.id, second);

  // The child's first use creates its native session as a continuity leg,
  // and that leg's first prompt carries exactly the forked dialogue.
  await sessions.send(result.id, { text: "second, edited" });
  await flush();
  assert.ok(fake.ensured.includes(result.id));
  const materialized = await store.projection(result.id);
  assert.equal(materialized?.backendSessionId, `be_${result.id}`);
  assert.equal(materialized?.runtimeLeg?.bootstrap, "continuity");
  assert.equal(materialized?.runtimeLeg?.canonicalThroughSeq, 0);
  const childEvents = await store.events(result.id);
  const operations = await store.operations(result.id);
  assert.equal(runtimeEpochRecoveryPending(childEvents, operations), true);
  const plan = planRuntimeEpochRecovery({ events: childEvents, operations, heldQueueIds: new Set() });
  assert.ok(plan);
  assert.match(plan.recoveryContext, /forked from an earlier point of another chat/);
  assert.match(plan.recoveryContext, /\bfirst\b/);
  assert.match(plan.recoveryContext, /\bone\b/);
  assert.doesNotMatch(plan.recoveryContext, /\btwo\b/);
  assert.doesNotMatch(plan.recoveryContext, /imported as a Snapshot/);
  await store.close();
});

test("a native branch that refuses on history mismatch falls back to a continuity fork", async () => {
  const fake = fakeRuntime({ branchError: "history-mismatch" });
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);
  const before = await store.events(id);
  const second = before.filter((e) => e.type === "user/message")[1]!;

  const result = await sessions.fork(id, second.seq);
  // The refused native attempt stays on the source as a rejected operation.
  assertForkOperationTail(before, await store.events(id), "mutation/rejected");
  await assertContinuityChild(store, id, result.id, second);
  assert.deepEqual(fake.discarded, []); // nothing to discard: backend was never created
  await store.close();
});

test("an unclassified backend branch failure creates no canonical child", async () => {
  const fake = fakeRuntime({ branchError: "boom" });
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);
  const second = (await store.events(id)).filter((e) => e.type === "user/message")[1]!;

  await assert.rejects(() => sessions.fork(id, second.seq));
  const others = (await store.projections("p1")).filter((p) => p.id !== id);
  assert.deepEqual(others, []);
  assert.deepEqual(fake.discarded, []);
  await store.close();
});

test("canonical publication failure does not issue an untracked backend delete", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake, (raw) => ({
    ...raw,
    publishChildSession: async () => {
      throw Object.assign(new Error("disk full"), { code: "internal" });
    },
  }));
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);
  const second = (await store.events(id)).filter((e) => e.type === "user/message")[1]!;

  await assert.rejects(() => sessions.fork(id, second.seq), /disk full/);
  assert.deepEqual(fake.discarded, []);
  const others = (await store.projections("p1")).filter((p) => p.id !== id);
  assert.deepEqual(others, []);
  await store.close();
});

test("fork validation: assistant targets, invalid seqs, and active rewinds are rejected", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);
  const events = await store.events(id);
  const assistant = events.find((e) => e.type === "assistant/message")!;
  const second = events.filter((e) => e.type === "user/message")[1]!;

  await assert.rejects(() => sessions.fork(id, assistant.seq), /must be a user message/);
  await assert.rejects(() => sessions.fork(id, 10_000), /not found/);
  await assert.rejects(() => sessions.fork(id, -1), /positive event sequence/);

  await sessions.rewind!(id, second.seq);
  await assert.rejects(() => sessions.fork(id, second.seq), /restore or replace/);
  await sessions.clearRewind!(id);
  const ok = await sessions.fork(id, second.seq);
  assert.ok(ok.id);
  await store.close();
});

test("truthful guards: soft rewind and fork both work during a live turn or a waiting request", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);
  const second = (await store.events(id)).filter((e) => e.type === "user/message")[1]!;

  // stale `working` row (e.g. interrupted process): no live turn, no open
  // request — the offered action must succeed, not deterministically 409
  const proj = (await store.projection(id))!;
  await store.upsertProjection({ ...proj, status: "working" });
  const marker = await sessions.rewind!(id, second.seq);
  assert.equal(marker.type, "session/rewound");
  await sessions.clearRewind!(id);

  // A real active turn can stage a soft rewind without affecting execution,
  // and Fork copies canonical history without touching the running source.
  await sessions.send(id, { text: "third" });
  await flush();
  const liveMarker = await sessions.rewind!(id, second.seq);
  assert.equal(liveMarker.type, "session/rewound");
  await sessions.clearRewind!(id);
  const branchesBefore = fake.branchRequests.length;
  const live = await sessions.fork(id, second.seq);
  assert.equal(fake.branchRequests.length, branchesBefore);
  await assertContinuityChild(store, id, live.id, second);
  assert.equal((await store.projection(id))?.status, "working");
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();

  // an unresolved question derived from durable events does not block either
  fake.emit(id, { type: "question/asked", requestId: "q1", questions: [] });
  await flush();
  const waiting = await sessions.fork(id, second.seq);
  assert.equal(fake.branchRequests.length, branchesBefore);
  await assertContinuityChild(store, id, waiting.id, second);
  await sessions.replyQuestion(id, "q1", {});
  const after = await sessions.fork(id, second.seq);
  assert.ok(after.id);
  await store.close();
});

test("a whole-session fork taken mid-turn closes the copied turn, tools and requests in the child only", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);
  await sessions.send(id, { text: "third" });
  await flush();
  fake.emit(id, { type: "tool/started", callId: "c1", tool: "bash", input: { command: "sleep 60" } });
  fake.emit(id, { type: "question/asked", requestId: "q1", questions: [] });
  await flush();
  const before = await store.events(id);
  const openTurn = before.findLast((e) => e.type === "turn/started")!;

  const result = await sessions.fork(id);
  assert.equal(result.draft, undefined);
  // The running source is not branched, stopped or written to.
  assert.equal(fake.branchRequests.length, 0);
  assert.deepEqual(await store.events(id), before);
  assert.equal((await store.projection(id))?.status, "waiting");

  const childEvents = await store.events(result.id);
  assert.deepEqual(childEvents.slice(0, before.length).map((e) => e.type), before.map((e) => e.type));
  const tail = childEvents.slice(before.length);
  assert.deepEqual(tail.map((e) => e.type), [
    "tool/error", "question/expired", "turn/stopped", "session/snapshot-imported", "session/forked",
  ]);
  assert.equal((tail[0]!.data as { callId?: string }).callId, "c1");
  assert.deepEqual(tail[1]!.data, { requestId: "q1", reason: "forked" });
  assert.deepEqual(tail[2]!.data, { turnId: (openTurn.data as { turnId: string }).turnId, reason: "aborted" });
  const child = await store.projection(result.id);
  assert.equal(child?.status, "idle");
  assert.equal(child?.backendSessionId, undefined);

  // The child gets its own native session at once, while the source turn
  // is still running.
  await sessions.send(result.id, { text: "continue here" });
  await flush();
  assert.ok(fake.ensured.includes(result.id));
  await store.close();
});

test("fork works from a recovering source: unknown, reconciling and epoch-pending", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);
  const second = (await store.events(id)).filter((e) => e.type === "user/message")[1]!;

  for (const status of ["unknown", "reconciling", "epoch-pending"] as const) {
    await store.upsertProjection({ ...(await store.projection(id))!, status });
    const result = await sessions.fork(id, second.seq);
    await assertContinuityChild(store, id, result.id, second);
    assert.equal((await store.projection(id))?.status, status);
  }
  assert.equal(fake.branchRequests.length, 0);
  await store.close();
});

test("fork continues without the source runtime when it cannot be reached", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);
  const second = (await store.events(id)).filter((e) => e.type === "user/message")[1]!;
  const project = (await store.projection(id))!.projectId;

  // A restarted server whose harness cannot be started at all.
  const restarted = createSessionService({
    store,
    projects: {
      list: async () => [], add: async () => { throw new Error("unused"); }, create: async () => { throw new Error("unused"); }, remove: async () => {},
      get: async (pid) => (pid === project ? { id: project, path: tmpdir(), name: "p", createdAt: 1 } : undefined),
    },
    permissions: { evaluate: () => "allow", addRule: () => {}, rules: () => [] } as unknown as PermissionService,
    broadcast: { event: () => {}, projection: () => {} },
    queue: store,
    runtimes: { forProject: async () => { throw Object.assign(new Error("harness is not installed"), { code: "runtime-unavailable" }); } },
  });
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  try {
    const result = await restarted.fork(id, second.seq);
    await assertContinuityChild(store, id, result.id, second);
  } finally {
    console.warn = warn;
  }
  assert.equal(fake.branchRequests.length, 0);
  assert.equal(warnings.some((line) => line.includes("continues without its runtime")), true);
  await store.close();
});

test("duplicate rewind requests are idempotent while the marker is propagating", async () => {
  const fake = fakeRuntime();
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);
  const target = (await store.events(id)).find((event) => event.type === "user/message")!;

  const results = await Promise.all([
    sessions.rewind!(id, target.seq),
    sessions.rewind!(id, target.seq),
  ]);

  assert.equal(results[0]!.type, "session/rewound");
  assert.equal(results[1]!.seq, results[0]!.seq);
  assert.equal((await store.events(id)).filter((event) => event.type === "session/rewound").length, 1);
  await store.close();
});

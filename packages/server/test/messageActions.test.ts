// UX-MSG-ACTIONS: per-message Fork publication, truthful Revert/Fork guards,
// and all-or-nothing failure behavior at the session-service seam.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore, deriveMessages } from "@polyth/session";
import type {
  AgentRuntime, ForkDraft, ModelMessage, Project, ProjectService, RuntimeBranchRequest, RuntimeEvent,
  SessionPersistence,
} from "@polyth/contracts";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import type { PermissionService } from "@polyth/permissions";

type Emit = (sessionId: string, ev: RuntimeEvent) => void;

function fakeRuntime(opts: { branchError?: string } = {}) {
  const listeners = new Set<Emit>();
  const startedTexts: string[] = [];
  const branchRequests: Array<{ sourceSessionId: string; targetSessionId: string; history: ModelMessage[] }> = [];
  const discarded: string[] = [];
  const ensured: string[] = [];
  const emit = (sessionId: string, ev: RuntimeEvent) => {
    for (const l of listeners) l(sessionId, ev);
  };
  const rt: AgentRuntime = {
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false, steering: false,
      attachments: { modalities: { file: "native" } },
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
    url: "/api/files/raw?projectId=p1&path=README.md",
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

test("backend branch failure creates no canonical child and keeps the source intact", async () => {
  const fake = fakeRuntime({ branchError: "history-mismatch" });
  const { sessions, store } = makeService(fake);
  const { id } = await sessions.create({ projectId: "p1", title: "T" });
  await seedTwoTurns(fake, sessions, id);
  const before = await store.events(id);
  const second = before.filter((e) => e.type === "user/message")[1]!;

  await assert.rejects(() => sessions.fork(id, second.seq), (err: Error & { code?: string }) => {
    assert.equal(err.code, "history-mismatch");
    return true;
  });
  assertForkOperationTail(before, await store.events(id), "mutation/rejected");
  const others = (await store.projections("p1")).filter((p) => p.id !== id);
  assert.deepEqual(others, []);
  assert.deepEqual(fake.discarded, []); // nothing to discard: backend was never created
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

test("truthful guards: a stale working projection does not block, a live turn does", async () => {
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

  // a real active turn blocks both actions
  await sessions.send(id, { text: "third" });
  await flush();
  await assert.rejects(() => sessions.rewind!(id, second.seq), /while a turn is running/);
  await assert.rejects(() => sessions.fork(id, second.seq), /while a turn is running/);
  fake.emit(id, { type: "turn/stopped", reason: "completed" });
  await flush();

  // an unresolved question derived from durable events blocks too
  fake.emit(id, { type: "question/asked", requestId: "q1", questions: [] });
  await flush();
  await assert.rejects(() => sessions.fork(id, second.seq), /while a request is waiting/);
  await sessions.replyQuestion(id, "q1", {});
  const after = await sessions.fork(id, second.seq);
  assert.ok(after.id);
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

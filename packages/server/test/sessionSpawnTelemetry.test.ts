// Spawn timing is an in-memory diagnostic: each stage is measured once, at the
// exact boundary that owns it, and nothing unknown is reported as zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type {
  AgentRuntime, Project, ProjectService, RuntimeEvent, RuntimeObservation,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import { createSpawnTelemetry } from "../src/spawnTelemetry.ts";

const WALL = 1_700_000_000_000;
const flush = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => boolean | Promise<boolean>, attempts = 200): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await flush(10);
  }
  throw new Error("condition was not reached");
};

interface Options {
  /** Runtime events emitted synchronously from inside the turn dispatch. */
  duringStart?: (sessionId: string, turn: number) => RuntimeEvent[];
  startTurn?: (turn: number) => void;
  ensureSession?: () => void;
  acquireRuntime?: () => void;
  acquisitionInfo?: (runtime: AgentRuntime, sessionId: string) => { warmRuntimeHit?: boolean; runtimeSpawnMs?: number } | undefined;
}

const harness = (options: Options = {}) => {
  const clock = { t: 10_000 };
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const observers = new Set<(sessionId: string, observation: RuntimeObservation) => void>();
  let turns = 0;
  let acquisitions = 0;
  const runtime: AgentRuntime = {
    harnessId: "fixture",
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false,
    }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (canonical) => {
      clock.t += 7;
      options.ensureSession?.();
      return `be_${canonical.sessionId}`;
    },
    sessions: async () => [],
    history: async () => [],
    startTurn: async (request) => {
      turns += 1;
      clock.t += turns === 1 ? 11 : 100;
      options.startTurn?.(turns);
      const events = options.duringStart?.(request.sessionId, turns)
        ?? [{ type: "turn/started", turnId: `native-${turns}` } as RuntimeEvent];
      for (const event of events) for (const listener of listeners) listener(request.sessionId, event);
    },
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(callback) {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
    onObservation(callback) {
      observers.add(callback);
      return { dispose: () => observers.delete(callback) };
    },
    dispose: async () => {},
  };
  const dir = mkdtempSync(join(tmpdir(), "polyth-spawn-timing-"));
  const store = createStore(join(dir, "s.db"));
  const project: Project = { id: "p1", path: dir, name: "p", createdAt: 1 };
  const projects: ProjectService = {
    list: async () => [project],
    get: async (id) => (id === "p1" ? project : undefined),
    add: async () => project,
    create: async () => project,
    remove: async () => {},
  };
  const permissions = { evaluate: () => "ask", addRule: () => {}, rules: () => [] } as unknown as PermissionService;
  const broadcast: Broadcaster = { event: () => {}, projection: () => {} };
  const telemetry = createSpawnTelemetry({ now: () => clock.t, wallNow: () => WALL });
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store,
    spawnTelemetry: telemetry,
    // Deterministic single-shot stage measurement: no readiness retry.
    runtimeAcquireRetryMs: [],
    runtimes: {
      forProject: async () => {
        acquisitions += 1;
        clock.t += 5;
        options.acquireRuntime?.();
        return runtime;
      },
      ...(options.acquisitionInfo ? { acquisitionInfo: options.acquisitionInfo } : {}),
    },
  });
  return {
    sessions, store, telemetry, clock, project,
    close: async () => {
      sessions.dispose?.();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
    acquisitions: () => acquisitions,
    emit: (sessionId: string, ...events: RuntimeEvent[]) => {
      for (const event of events) for (const listener of listeners) listener(sessionId, event);
    },
    observe: (sessionId: string, observation: RuntimeObservation) => {
      for (const observer of observers) observer(sessionId, observation);
    },
  };
};

const chunk = (turn: number, text = "hi"): RuntimeEvent =>
  ({ type: "assistant/chunk", partId: `native-${turn}:stream:0:0`, text });

const hasEvent = async (h: ReturnType<typeof harness>, id: string, type: string) =>
  (await h.store.events(id)).some((event) => event.type === type);

test("create → first admitted content records every stage exactly once", async () => {
  const lookups: string[] = [];
  const h = harness({
    acquisitionInfo: (_runtime, sessionId) => {
      lookups.push(sessionId);
      return { warmRuntimeHit: false, runtimeSpawnMs: 42 };
    },
    // A runtime that reports the turn and its first content synchronously
    // from inside the dispatch call.
    duringStart: (_sessionId, turn) => [
      { type: "turn/started", turnId: `native-${turn}` },
      chunk(turn),
    ],
  });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Timed" });
  assert.deepEqual(h.telemetry.get(id), {
    startedAt: WALL,
    runtimeAcquireMs: 5,
    nativeSessionCreateMs: 7,
    warmRuntimeHit: false,
    runtimeSpawnMs: 42,
    harnessId: "fixture",
  }, "no admission or runtime event is invented before a turn");
  assert.deepEqual(lookups, [id], "per-session lease lookup, once, at the first acquisition");

  await h.sessions.send(id, { text: "go" });
  await waitFor(() => hasEvent(h, id, "assistant/chunk"));
  const timing = h.telemetry.get(id)!;
  assert.equal(timing.turnAdmissionMs, 11);
  assert.equal(timing.firstRuntimeEventMs, 5 + 7 + 11, "measured from create, at canonical ingress");

  const debug = await h.sessions.debug!(id) as { spawnTiming?: unknown };
  assert.deepEqual(debug.spawnTiming, timing);
  await h.close();
});

test("later turns and later content never overwrite the first measurements", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Twice" });
  await h.sessions.send(id, { text: "one" });
  await waitFor(async () => (await h.store.projection(id))?.status === "working");
  h.clock.t += 3;
  h.emit(id, chunk(1));
  await waitFor(() => hasEvent(h, id, "assistant/chunk"));
  h.emit(id, { type: "turn/stopped", turnId: "native-1", reason: "completed" });
  await waitFor(async () => (await h.store.projection(id))?.status === "idle");
  const first = h.telemetry.get(id)!;
  assert.equal(first.turnAdmissionMs, 11);
  assert.equal(first.firstRuntimeEventMs, 5 + 7 + 11 + 3);

  h.clock.t += 1_000;
  await h.sessions.send(id, { text: "two" });
  await waitFor(async () => (await h.store.projection(id))?.status === "working");
  h.emit(id, chunk(2, "again"));
  await waitFor(async () => (await h.store.events(id)).filter((event) => event.type === "assistant/chunk").length === 2);
  assert.deepEqual(h.telemetry.get(id), first);
  await h.close();
});

test("a queued first message is timed only when it is actually delivered", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Queued" });
  // The leg reports its own turn (no content): the session is busy before
  // Polyth delivered anything, so the user's first message is queued.
  h.emit(id, { type: "turn/started", turnId: "native-0" });
  await waitFor(async () => (await h.store.projection(id))?.status === "working");
  const queued = await h.sessions.send(id, { text: "later", delivery: "queue" });
  assert.equal(queued.queued, true);
  assert.equal(h.telemetry.get(id)?.turnAdmissionMs, undefined, "queueing is not admission");
  assert.equal(h.telemetry.get(id)?.firstRuntimeEventMs, undefined);

  h.clock.t += 50;
  h.emit(id, { type: "turn/stopped", turnId: "native-0", reason: "completed" });
  await waitFor(() => h.telemetry.get(id)?.turnAdmissionMs !== undefined);
  assert.equal(h.telemetry.get(id)?.turnAdmissionMs, 11);
  await h.close();
});

test("an unknown first admission is recorded, and refused content never counts", async () => {
  const h = harness({
    startTurn: (turn) => {
      if (turn === 1) throw new Error("transport lost");
    },
  });
  const { id } = await h.sessions.create({ projectId: "p1", title: "Unknown" });
  await assert.rejects(h.sessions.send(id, { text: "go" }));
  assert.equal(h.telemetry.get(id)?.turnAdmissionMs, 11, "the attempt's real duration");

  h.emit(id, chunk(1, "unowned"));
  await flush(80);
  assert.ok(!(await hasEvent(h, id, "assistant/chunk")), "the fence refused the content");
  assert.equal(h.telemetry.get(id)?.firstRuntimeEventMs, undefined);
  await h.close();
});

test("a failed native create keeps what was measured and invents nothing", async () => {
  const h = harness({
    ensureSession: () => { throw Object.assign(new Error("no"), { code: "unsupported" }); },
  });
  const failed = await h.sessions.create({ projectId: "p1", title: "Broken" })
    .then(() => undefined, (error: { sessionId?: string }) => error.sessionId);
  assert.ok(failed);
  assert.deepEqual(h.telemetry.get(failed), {
    startedAt: WALL,
    runtimeAcquireMs: 5,
    nativeSessionCreateMs: 7,
    harnessId: "fixture",
  });
  await h.close();
});

test("a failed runtime acquisition preserves its error and records only that stage", async () => {
  const error = Object.assign(new Error("fixture runtime unavailable"), { code: "runtime-unavailable" });
  const h = harness({ acquireRuntime: () => { throw error; } });
  await assert.rejects(h.sessions.create({ projectId: "p1", title: "Unavailable" }), (caught) => caught === error);
  const failed = error as Error & { sessionId: string };
  assert.deepEqual(h.telemetry.get(failed.sessionId), { startedAt: WALL, runtimeAcquireMs: 5 });
  assert.equal((error as { mutationOutcome?: string }).mutationOutcome, "rejected", "not reported as outcome-unknown");
  await h.close();
});

test("a failed empty delegated child is forgotten with its canonical row", async () => {
  let failCreate = false;
  const h = harness({
    ensureSession: () => { if (failCreate) throw Object.assign(new Error("no"), { code: "unsupported" }); },
  });
  const parent = await h.sessions.create({ projectId: "p1", title: "Parent" });
  failCreate = true;
  const child = await h.sessions.create({ projectId: "p1", title: "Child", parentId: parent.id })
    .then(() => undefined, (error: { sessionId?: string }) => error.sessionId);
  assert.ok(child);
  assert.equal(await h.store.projection(child), undefined, "empty child was discarded");
  assert.equal(h.telemetry.get(child), undefined);
  assert.ok(h.telemetry.get(parent.id));
  await h.close();
});

test("debug reads timing without acquiring a runtime; delete and dispose forget it", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Debug" });
  const other = await h.sessions.create({ projectId: "p1", title: "Other" });
  const before = h.acquisitions();
  const debug = await h.sessions.debug!(id) as { spawnTiming?: { runtimeAcquireMs?: number } };
  assert.equal(debug.spawnTiming?.runtimeAcquireMs, 5);
  assert.equal(h.acquisitions(), before, "debug never starts a runtime");

  await h.sessions.delete!(id);
  assert.equal(h.telemetry.get(id), undefined);
  assert.ok(h.telemetry.get(other.id));
  h.sessions.dispose?.();
  assert.equal(h.telemetry.get(other.id), undefined);
  assert.equal(h.telemetry.size, 0);
  await h.close();
});

test("a session this service did not create reports no spawn timing", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Restart" });
  h.telemetry.forget(id);
  const debug = await h.sessions.debug!(id) as { spawnTiming?: unknown };
  assert.equal("spawnTiming" in debug, false);
  await h.close();
});

const observed = async (h: ReturnType<typeof harness>, id: string) => {
  const binding = (await h.store.projection(id))!.runtimeBinding!;
  const reconciliation = await h.store.startReconciliation(id);
  return (revision: string): RuntimeObservation => ({
    channel: "sse",
    entityKey: `answer-${revision}`,
    identity: {
      authorityId: binding.authorityId,
      generation: binding.generation,
      location: binding.location,
      backendSessionId: binding.backendSessionId,
      artifactKind: "part",
      entityId: `answer-${revision}`,
      revision,
    },
    reconciliationOrdinal: reconciliation.ordinal,
    events: [{ type: "assistant/message", partId: `answer-${revision}`, text: revision }],
    cursorAfter: revision,
  });
};

test("v2 observations outside an admitted turn do not count", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Idle observed" });
  const observation = await observed(h, id);
  // Recovered/idle content is journaled (v2 is not fenced), but it is not
  // the output of a turn Polyth admitted.
  h.observe(id, observation("idle"));
  await waitFor(() => hasEvent(h, id, "assistant/message"));
  assert.equal(h.telemetry.get(id)?.firstRuntimeEventMs, undefined);
  await h.close();
});

test("v2 observations of the admitted first turn count at ingress", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Observed" });
  await h.sessions.send(id, { text: "go" });
  await waitFor(async () => (await h.store.projection(id))?.status === "working");
  const observation = await observed(h, id);
  h.clock.t += 4;
  h.observe(id, observation("live"));
  await waitFor(() => h.telemetry.get(id)?.firstRuntimeEventMs !== undefined);
  assert.equal(h.telemetry.get(id)?.firstRuntimeEventMs, 5 + 7 + 11 + 4);
  await h.close();
});

test("stale v2 output cannot supply first-event timing", async () => {
  const h = harness();
  const { id } = await h.sessions.create({ projectId: "p1", title: "Fenced" });
  await h.sessions.send(id, { text: "prompt-content-marker" });
  await waitFor(async () => (await h.store.projection(id))?.status === "working");
  const observation = await observed(h, id);
  const stale = observation("stale");
  stale.identity.generation += 1;
  h.observe(id, stale);
  await flush(30);
  assert.equal(h.telemetry.get(id)?.firstRuntimeEventMs, undefined);
  h.clock.t += 4;
  h.observe(id, observation("current"));
  await waitFor(() => h.telemetry.get(id)?.firstRuntimeEventMs !== undefined);
  assert.equal(h.telemetry.get(id)?.firstRuntimeEventMs, 5 + 7 + 11 + 4);
  assert.equal(JSON.stringify(h.telemetry.get(id)).includes("prompt-content-marker"), false);
  await h.close();
});

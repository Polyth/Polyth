// Session start: one request creates the chat and durably queues its first
// prompt; the server provisions the runtime and delivers the prompt itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStore } from "@polyth/session";
import type {
  AgentRuntime, ModelDescriptor, Project, ProjectService, RuntimeEvent, SessionEvent,
} from "@polyth/contracts";
import type { PermissionService } from "@polyth/permissions";
import type { SessionStartStep } from "@polyth/plugins";
import { createSessionService, type Broadcaster } from "../src/sessions.ts";
import { createSessionStartStepRegistry } from "../src/sessionStartSteps.ts";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createProjectService } from "../src/projects.ts";
import { createSpaceGateway } from "../src/spaces.ts";
import { createHttpServer } from "../src/http.ts";
import { sessionIdForCreateOperation } from "../src/sessionCreateIdempotency.ts";
import { accountScopedClientOperationId } from "../src/httpCore.ts";

const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (condition: () => boolean | Promise<boolean>, attempts = 300): Promise<void> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await flush();
  }
  throw new Error("condition was not reached");
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

interface FixtureOptions {
  dir?: string;
  /** Held until released: native session create. */
  createGate?: Promise<void>;
  /** Held until released: runtime acquisition. */
  acquireGate?: Promise<void>;
  acquireError?: () => Error | undefined;
  /** Thrown by the native create: an outcome the runtime never confirmed. */
  createError?: () => Error | undefined;
  /** A definite refusal from the adapter (e.g. invalid-model). */
  rejectTurn?: { code: string; message: string };
  /** The runtime's live model catalog, read on every dispatch. */
  catalog?: () => ModelDescriptor[];
  /** An uncertain turn-submit outcome: the adapter never confirmed delivery. */
  unknownTurn?: boolean;
  keepDir?: boolean;
  startSteps?: Record<string, SessionStartStep>;
}

const fixture = (options: FixtureOptions = {}) => {
  const listeners = new Set<(sessionId: string, event: RuntimeEvent) => void>();
  const prompts: string[] = [];
  let creates = 0;
  let acquisitions = 0;
  const runtime: AgentRuntime = {
    harnessId: "fixture",
    capabilities: async () => ({
      streaming: true, permissions: true, questions: true, compaction: false, subagents: false,
    }),
    models: async () => options.catalog?.() ?? [],
    agents: async () => [],
    ensureSession: async (canonical) => {
      if (canonical.backendSessionId) return canonical.backendSessionId;
      creates += 1;
      await options.createGate;
      const failure = options.createError?.();
      if (failure) throw failure;
      return `be_${canonical.sessionId}`;
    },
    sessions: async () => [],
    history: async () => [],
    startTurn: async (request) => {
      prompts.push(request.text);
      for (const listener of listeners) listener(request.sessionId, { type: "turn/started", turnId: `native-${prompts.length}` } as RuntimeEvent);
    },
    ...(options.rejectTurn ? {
      startTurnOperation: async (request: { text: string }) => {
        prompts.push(request.text);
        return { kind: "rejected" as const, ...options.rejectTurn! };
      },
    } : {}),
    ...(options.unknownTurn ? {
      startTurnOperation: async (request: { text: string }) => {
        prompts.push(request.text);
        return { kind: "unknown" as const, code: "outcome-unknown", message: "delivery unconfirmed" };
      },
    } : {}),
    abort: async () => {},
    replyPermission: async () => {},
    replyQuestion: async () => {},
    onEvent(callback) {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
    dispose: async () => {},
  };
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "polyth-session-start-"));
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
  const projections: Array<{ id: string; status: string; autoAccept?: boolean }> = [];
  const broadcast: Broadcaster = {
    event: () => {},
    projection: (projection) => { projections.push(projection as never); },
  };
  const startSteps = createSessionStartStepRegistry();
  for (const [id, step] of Object.entries(options.startSteps ?? {})) startSteps.register(id, step);
  const sessions = createSessionService({
    store, projects, permissions, broadcast, queue: store, startSteps,
    runtimeAcquireRetryMs: [],
    runtimes: {
      forProject: async () => {
        acquisitions += 1;
        await options.acquireGate;
        const failure = options.acquireError?.();
        if (failure) throw failure;
        return runtime;
      },
    },
  });
  return {
    sessions, store, dir, projections,
    prompts, creates: () => creates, acquisitions: () => acquisitions,
    emit: (sessionId: string, event: RuntimeEvent) => {
      for (const listener of listeners) listener(sessionId, event);
    },
    close: async () => {
      sessions.dispose?.();
      await store.close();
      if (!options.keepDir && !options.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
};

const fixtureWithSteps = (startSteps: Record<string, SessionStartStep>) => fixture({ startSteps });

const userMessages = (events: readonly SessionEvent[]) => events.filter((event) => event.type === "user/message");

test("a send while the new chat is still reconciling is queued and admitted after creation", async () => {
  const gate = deferred();
  const h = fixture({ createGate: gate.promise });
  try {
    const created = h.sessions.create({ projectId: "p1" });
    let sessionId = "";
    await waitFor(async () => {
      const row = (await h.store.projections())[0];
      if (row?.status === "reconciling" && h.creates() === 1) sessionId = row.id;
      return Boolean(sessionId);
    });
    const sent = await h.sessions.send(sessionId, { text: "hello" });
    assert.equal(sent.queued, true);
    assert.equal(h.prompts.length, 0);
    gate.resolve();
    await created;
    await waitFor(() => h.prompts.length === 1);
    assert.deepEqual(h.prompts, ["hello"]);
    assert.equal(userMessages(await h.store.events(sessionId)).length, 1);
    assert.deepEqual(await h.store.queueList(sessionId), []);
  } finally {
    await h.close();
  }
});

const AUTHOR = { userId: "u1", name: "Ada" };
const KEY = "11111111-2222-4333-8444-555555555555";
const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ofType = (events: readonly SessionEvent[], type: string) => events.filter((event) => event.type === type);

test("start replies before runtime acquisition resolves and delivers the first turn after provisioning", async () => {
  const gate = deferred();
  const h = fixture({ acquireGate: gate.promise });
  try {
    const result = await h.sessions.start!({
      projectId: "p1", start: { firstTurn: { text: "build it" } }, clientOperationId: KEY,
    }, { author: AUTHOR });
    assert.equal(result.queueId, KEY);
    assert.equal(result.turnId, undefined);
    assert.equal(h.creates(), 0);
    const queued = await h.store.queueList(result.id);
    assert.deepEqual(queued.map((item) => item.text), ["build it"]);
    assert.equal(queued[0]!.author?.userId, "u1");
    const fallback = ofType(await h.store.events(result.id), "delivery/fallback-queued");
    assert.deepEqual(fallback.map((event) => event.data.reason), ["session-starting"]);
    gate.resolve();
    await waitFor(() => h.prompts.length === 1);
    await waitFor(async () => (await h.store.queueList(result.id)).length === 0);
    const events = await h.store.events(result.id);
    assert.equal(userMessages(events).length, 1);
    assert.equal(h.creates(), 1);
    assert.equal((await h.sessions.debug?.(result.id))?.spawnTiming?.startReplyMs !== undefined, true);
  } finally {
    await h.close();
  }
});

test("opening a chat while it starts neither fails nor disturbs its status", async () => {
  const gate = deferred();
  const h = fixture({ createGate: gate.promise });
  try {
    const result = await h.sessions.start!({
      projectId: "p1", start: { firstTurn: { text: "hello" } }, clientOperationId: KEY,
    }, { author: AUTHOR });
    await waitFor(() => h.creates() === 1);
    // The web client opens the chat as soon as the start replies.
    await h.sessions.activate!(result.id, { intent: "open" });
    await h.sessions.activate!(result.id);
    assert.equal((await h.store.projection(result.id))?.status, "reconciling");
    gate.resolve();
    await waitFor(() => h.prompts.length === 1);
    assert.deepEqual(h.prompts, ["hello"]);
    assert.equal(h.creates(), 1);
    assert.ok(!h.projections.some((row) => row.id === result.id && row.status === "unknown"), "never published as unknown");
  } finally {
    await h.close();
  }
});

test("the start's own queued first turn runs no recover-on-use pass that finds its create uncertain", async () => {
  // 2026-11-26: every new chat logged "recovery for a message queued in …
  // (session-starting) did not complete: backend session creation outcome is
  // unknown" — the queued send's activate ran before the start flight existed.
  const gate = deferred();
  const h = fixture({ createGate: gate.promise });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const result = await h.sessions.start!({
      projectId: "p1", start: { firstTurn: { text: "hello" } }, clientOperationId: KEY,
    }, { author: AUTHOR });
    await waitFor(() => h.creates() === 1);
    gate.resolve();
    await waitFor(() => h.prompts.length === 1);
    assert.deepEqual(warnings.filter((line) => line.includes("recovery for a message queued")), []);
    assert.ok(!h.projections.some((row) => row.id === result.id && row.status === "unknown"), "never published as unknown");
  } finally {
    console.warn = warn;
    await h.close();
  }
});

test("a resend with the same id and key returns the same result with one row, one create and one prompt", async () => {
  const gate = deferred();
  const h = fixture({ createGate: gate.promise });
  try {
    const request = { id: SESSION, projectId: "p1", start: { firstTurn: { text: "once" } }, clientOperationId: KEY };
    const first = await h.sessions.start!(request, { author: AUTHOR });
    const again = await h.sessions.start!(request, { author: AUTHOR });
    assert.deepEqual(again, first);
    assert.equal((await h.store.projections()).length, 1);
    gate.resolve();
    await waitFor(() => h.prompts.length === 1);
    // The git package resends with the row already provisioned.
    const afterDelivery = await h.sessions.start!({ ...request, worktreePath: undefined }, { author: AUTHOR });
    assert.deepEqual(afterDelivery, first);
    await flush(50);
    assert.equal(h.prompts.length, 1);
    assert.equal(h.creates(), 1);
    assert.equal(userMessages(await h.store.events(SESSION)).length, 1);
    assert.equal(ofType(await h.store.events(SESSION), "queue/enqueued").length, 1);
  } finally {
    await h.close();
  }
});

test("a resend whose row exists but whose first turn was never queued queues it once", async () => {
  const h = fixture();
  try {
    await h.sessions.create({ id: SESSION, projectId: "p1" });
    const result = await h.sessions.start!({
      id: SESSION, projectId: "p1", start: { firstTurn: { text: "late" } }, clientOperationId: KEY,
    }, { author: AUTHOR });
    assert.equal(result.id, SESSION);
    await waitFor(() => h.prompts.length === 1);
    const again = await h.sessions.start!({
      id: SESSION, projectId: "p1", start: { firstTurn: { text: "late" } }, clientOperationId: KEY,
    }, { author: AUTHOR });
    assert.equal(again.id, SESSION);
    await flush(50);
    assert.equal(h.prompts.length, 1);
    assert.equal(h.creates(), 1);
  } finally {
    await h.close();
  }
});

test("runtime failure leaves a failed chat with its first turn in the author's draft; a later send provisions again", async () => {
  let refuse = true;
  const h = fixture({ acquireError: () => refuse ? Object.assign(new Error("no runtime"), { code: "runtime-unavailable" }) : undefined });
  try {
    const result = await h.sessions.start!({
      projectId: "p1", start: { firstTurn: { text: "keep my words" } }, clientOperationId: KEY,
    }, { author: AUTHOR });
    await waitFor(async () => ofType(await h.store.events(result.id), "session/start-failed").length === 1);
    const failed = ofType(await h.store.events(result.id), "session/start-failed")[0]!;
    assert.equal(failed.data.code, "runtime-unavailable");
    assert.equal(failed.data.text, "keep my words");
    const row = await h.store.projection(result.id);
    assert.equal(row?.status, "failed");
    assert.deepEqual(await h.store.queueList(result.id), []);
    assert.equal(h.store.personStates([result.id], "u1")[result.id]?.draft, "keep my words");
    // Never auto-deleted by failed-startup cleanup.
    assert.ok(await h.store.projection(result.id));

    refuse = false;
    const sent = await h.sessions.send(result.id, { text: "try again" }, { author: AUTHOR });
    assert.equal(sent.queued, true);
    await waitFor(() => h.prompts.length === 1);
    assert.deepEqual(h.prompts, ["try again"]);
    const creates = (await h.store.operations(result.id)).filter((op) => op.mutationKind === "session-create");
    assert.deepEqual(creates.map((op) => op.state), ["rejected", "confirmed"]);
  } finally {
    await h.close();
  }
});

test("a restart while provisioning has not created the native session resumes it and delivers the first turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-session-start-restart-"));
  try {
    const before = fixture({ dir, acquireGate: new Promise(() => {}) });
    const result = await before.sessions.start!({
      projectId: "p1", start: { firstTurn: { text: "survive" } }, clientOperationId: KEY,
    }, { author: AUTHOR });
    await before.close();

    const after = fixture({ dir });
    try {
      // Boot: the same status rewrite indexCore runs before recovery.
      const { sessionStatusAfterBoot } = await import("../src/resourceStartupReconciliation.ts");
      await after.store.recoverExecutingOperations();
      for (const projection of await after.store.projections()) {
        const status = sessionStatusAfterBoot(projection.status, false, "none");
        if (status) await after.store.upsertProjection({ ...projection, status });
      }
      assert.equal((await after.store.projection(result.id))?.status, "unknown");
      await after.sessions.recoverPendingWork();
      await waitFor(() => after.prompts.length === 1);
      assert.deepEqual(after.prompts, ["survive"]);
      assert.equal(after.creates(), 1);
      await waitFor(async () => (await after.store.queueList(result.id)).length === 0);
    } finally {
      await after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart after the native create was claimed never creates again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polyth-session-start-claimed-"));
  try {
    const before = fixture({ dir, createGate: new Promise(() => {}) });
    const result = await before.sessions.start!({
      projectId: "p1", start: { firstTurn: { text: "uncertain" } }, clientOperationId: KEY,
    });
    await waitFor(() => before.creates() === 1);
    await before.close();

    const after = fixture({ dir });
    try {
      const { sessionStatusAfterBoot } = await import("../src/resourceStartupReconciliation.ts");
      await after.store.recoverExecutingOperations();
      for (const projection of await after.store.projections()) {
        const status = sessionStatusAfterBoot(projection.status, false, "none");
        if (status) await after.store.upsertProjection({ ...projection, status });
      }
      await after.sessions.recoverPendingWork();
      await flush(100);
      assert.equal(after.creates(), 0);
      assert.equal(after.prompts.length, 0);
      const creates = (await after.store.operations(result.id)).filter((op) => op.mutationKind === "session-create");
      assert.deepEqual(creates.map((op) => op.state), ["unknown"]);
      // The first turn does not wait in the queue for a create that never runs.
      const failed = ofType(await after.store.events(result.id), "session/start-failed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0]!.data.code, "process-restarted");
      assert.equal(failed[0]!.data.text, "uncertain");
      assert.deepEqual(await after.store.queueList(result.id), []);
      assert.equal((await after.store.projection(result.id))?.status, "unknown");
      // Reported once, however often recovery runs.
      await after.sessions.recoverPendingWork();
      assert.equal(ofType(await after.store.events(result.id), "session/start-failed").length, 1);
    } finally {
      await after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a native create with an uncertain outcome reports the start failure and refuses later sends", async () => {
  const h = fixture({ createError: () => new Error("socket closed") });
  try {
    const result = await h.sessions.start!({
      projectId: "p1", start: { firstTurn: { text: "keep my words" } }, clientOperationId: KEY,
    }, { author: AUTHOR });
    await waitFor(async () => ofType(await h.store.events(result.id), "session/start-failed").length === 1);
    const failed = ofType(await h.store.events(result.id), "session/start-failed")[0]!;
    assert.equal(failed.data.code, "outcome-unknown");
    // What the runtime said, not the stable "reconciliation is required" line.
    assert.equal(failed.data.message, "the runtime did not provide a definitive mutation outcome");
    assert.equal(failed.data.text, "keep my words");
    assert.equal((await h.store.projection(result.id))?.status, "unknown");
    assert.equal(h.store.personStates([result.id], "u1")[result.id]?.draft, "keep my words");

    // No native session and no second create: the send is refused, not queued forever.
    await assert.rejects(
      h.sessions.send(result.id, { text: "try again" }, { author: AUTHOR }),
      (error: { code?: string; mutationOutcome?: string }) => error.code === "conflict" && error.mutationOutcome === "not-started",
    );
    assert.deepEqual(await h.store.queueList(result.id), []);
    assert.equal(h.creates(), 1);
    const creates = (await h.store.operations(result.id)).filter((op) => op.mutationKind === "session-create");
    assert.deepEqual(creates.map((op) => op.state), ["unknown"]);
  } finally {
    await h.close();
  }
});

test("an unknown start extension is rejected before any row is written", async () => {
  const h = fixture();
  try {
    await assert.rejects(
      h.sessions.start!({ projectId: "p1", start: { extensions: { "no.such-step": {} } }, clientOperationId: KEY }),
      (error: { code?: string }) => error.code === "invalid-input",
    );
    assert.deepEqual(await h.store.projections(), []);
  } finally {
    await h.close();
  }
});

test("a start step runs after the row exists and before the first turn is queued", async () => {
  const seen: Array<{ row: boolean; queued: number; payload: unknown; text?: string }> = [];
  let store: ReturnType<typeof createStore> | undefined;
  const h = fixtureWithSteps({
    "pkg.step": {
      validate: (payload) => { if (payload.bad) throw Object.assign(new Error("bad"), { code: "invalid-input" }); },
      run: async (payload, ctx) => {
        seen.push({
          row: Boolean(await store!.projection(ctx.session.id)),
          queued: (await store!.queueList(ctx.session.id)).length,
          payload,
          ...(ctx.firstTurnText ? { text: ctx.firstTurnText } : {}),
        });
      },
    },
  });
  store = h.store;
  try {
    await assert.rejects(h.sessions.start!({ projectId: "p1", start: { extensions: { "pkg.step": { bad: true } } } }));
    assert.deepEqual(await h.store.projections(), []);
    const result = await h.sessions.start!({
      projectId: "p1",
      start: { firstTurn: { text: "go" }, extensions: { "pkg.step": { n: 1 } } },
      clientOperationId: KEY,
    });
    assert.deepEqual(seen, [{ row: true, queued: 0, payload: { n: 1 }, text: "go" }]);
    await waitFor(() => h.prompts.length === 1);
    assert.ok(result.id);
  } finally {
    await h.close();
  }
});

test("start.autoAccept is in the first published projection", async () => {
  const h = fixture({ acquireGate: new Promise(() => {}) });
  try {
    const result = await h.sessions.start!({ projectId: "p1", start: { autoAccept: "all" } });
    const first = h.projections.find((projection) => projection.id === result.id) as unknown as {
      autoAcceptSetting?: string; autoAccept?: boolean;
    };
    assert.equal(first.autoAcceptSetting, "all");
    assert.equal(first.autoAccept, true);
  } finally {
    await h.close();
  }
});

test("a first turn refused at dispatch is reported as a start failure", async () => {
  const h = fixture({
    rejectTurn: { code: "invalid-model", message: "model is not available" },
  });
  try {
    const result = await h.sessions.start!({
      projectId: "p1", start: { firstTurn: { text: "use the model" } }, clientOperationId: KEY,
    }, { author: AUTHOR });
    await waitFor(async () => ofType(await h.store.events(result.id), "session/start-failed").length === 1);
    const failed = ofType(await h.store.events(result.id), "session/start-failed")[0]!;
    assert.equal(failed.data.code, "invalid-model");
    assert.equal(failed.data.text, "use the model");
    assert.equal((await h.store.projection(result.id))?.status, "failed");
    assert.deepEqual(await h.store.queueList(result.id), []);
    assert.equal(h.store.personStates([result.id], "u1")[result.id]?.draft, "use the model");
  } finally {
    await h.close();
  }
});

const flashModel = (variants: string[]): ModelDescriptor[] => [
  { providerID: "pv", modelID: "flash", name: "Flash", harnessId: "fixture", variants } as ModelDescriptor,
];
const BAD_MODEL = { providerID: "pv", modelID: "flash", variant: "high" };

test("a first turn whose model variant the catalog does not offer fails the start visibly", async () => {
  const h = fixture({ catalog: () => flashModel([]) });
  try {
    const result = await h.sessions.start!({
      projectId: "p1", model: BAD_MODEL, start: { firstTurn: { text: "use it" } }, clientOperationId: KEY,
    }, { author: AUTHOR });
    await waitFor(async () => ofType(await h.store.events(result.id), "session/start-failed").length === 1);
    const events = await h.store.events(result.id);
    const failed = ofType(events, "session/start-failed")[0]!;
    assert.equal(failed.data.code, "invalid-variant");
    assert.match(String(failed.data.message), /does not offer a thinking level/);
    assert.equal(failed.data.text, "use it");
    assert.deepEqual(await h.store.queueList(result.id), []);
    assert.equal(h.store.personStates([result.id], "u1")[result.id]?.draft, "use it");
    assert.deepEqual(h.prompts, []);
    const debug = await h.sessions.debug?.(result.id);
    assert.ok(debug?.recentErrors.some((error) => error.code === "invalid-variant"), "session.debug says why");
  } finally {
    await h.close();
  }
});

test("a later queued item refused by the catalog leaves the queue with an error event", async () => {
  let catalog = flashModel(["high"]);
  const h = fixture({ catalog: () => catalog });
  try {
    const result = await h.sessions.start!({
      projectId: "p1", model: BAD_MODEL, start: { firstTurn: { text: "first" } }, clientOperationId: KEY,
    }, { author: AUTHOR });
    await waitFor(() => h.prompts.length === 1);
    const queued = await h.sessions.send(result.id, { text: "second" }, { author: AUTHOR });
    assert.equal(queued.queued, true);
    catalog = flashModel([]);
    h.emit(result.id, { type: "turn/stopped", reason: "completed" } as RuntimeEvent);
    await waitFor(async () => (await h.store.queueList(result.id)).length === 0);
    const events = await h.store.events(result.id);
    assert.deepEqual(h.prompts, ["first"]);
    assert.ok(ofType(events, "turn/failed").some((event) => event.data.code === "invalid-variant"));
    assert.equal(ofType(events, "session/start-failed").length, 0, "only a first turn is a start failure");
    assert.equal(h.store.personStates([result.id], "u1")[result.id]?.draft, "second");
  } finally {
    await h.close();
  }
});

test("an uncertain dispatch outcome keeps the queued item", async () => {
  const h = fixture({ unknownTurn: true });
  try {
    const result = await h.sessions.start!({
      projectId: "p1", start: { firstTurn: { text: "maybe" } }, clientOperationId: KEY,
    }, { author: AUTHOR });
    await waitFor(() => h.prompts.length === 1);
    await flush(50);
    assert.equal(ofType(await h.store.events(result.id), "session/start-failed").length, 0);
    assert.equal(h.prompts.length, 1, "an uncertain delivery is never replayed");
  } finally {
    await h.close();
  }
});

// ------------------------------------------------------------------ HTTP

const httpHarness = async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "polyth-session-start-http-"));
  const store = createStore(join(dataDir, "sessions.db"));
  const registry = createProjectService(dataDir);
  const prompts: string[] = [];
  let creates = 0;
  const runtime = {
    capabilities: async () => ({ streaming: true, permissions: false, questions: false, compaction: false, subagents: false }),
    models: async () => [],
    agents: async () => [],
    ensureSession: async (c: { sessionId: string; backendSessionId?: string }) => {
      if (c.backendSessionId) return c.backendSessionId;
      creates += 1;
      return `be_${c.sessionId}`;
    },
    sessions: async () => [],
    history: async () => [],
    startTurn: async (request: { text: string }) => { prompts.push(request.text); },
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
    runtimeAcquireRetryMs: [],
    runtimes: { forProject: async () => runtime },
    broadcast: { event: () => {}, projection: () => {} },
    queue: store,
    org: store,
  });
  const owner = gateway.store.users()[0]!;
  const home = gateway.resolver.forUser(owner.id, gateway.store.defaultSpaceFor(owner.id)!.id);
  const work = gateway.resolver.forUser(owner.id, gateway.store.createSpace({ name: "Work", ownerId: owner.id }).id);
  const homeProject = (await gateway.services(home).projects.add(mkdtempSync(join(tmpdir(), "polyth-start-home-")), "home")).id;
  const workProject = (await gateway.services(work).projects.add(mkdtempSync(join(tmpdir(), "polyth-start-work-")), "work")).id;
  const server = createHttpServer({ spaces: gateway, runtimes: {} as never, capabilities: () => [], webDist: dataDir, version: "test" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    store, home, work, homeProject, workProject, prompts, creates: () => creates,
    post: (body: Record<string, unknown>, space?: { spaceId: string }) => fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(space ? { "x-polyth-space": space.spaceId } : {}) },
      body: JSON.stringify(body),
    }),
    async close() {
      sessions.dispose?.();
      server.close();
      await once(server, "close");
    },
  };
};

test("POST /api/sessions with start replies with the queued first turn; a resend reaches the same result", async () => {
  const h = await httpHarness();
  try {
    const key = randomUUID();
    const body = { projectId: h.homeProject, clientOperationId: key, start: { firstTurn: { text: "hello there", autoTitle: true } } };
    const first = await h.post(body);
    assert.equal(first.status, 200);
    const result = await first.json() as { id: string; queueId?: string; turnId?: string };
    assert.equal(result.id, sessionIdForCreateOperation(key, h.home));
    assert.equal(result.queueId, accountScopedClientOperationId(key, h.home.userId));
    const again = await (await h.post(body)).json();
    assert.deepEqual(again, result);
    await waitFor(() => h.prompts.length === 1);
    await flush(30);
    assert.deepEqual(h.prompts, ["hello there"]);
    assert.equal(h.creates(), 1);
    const events = await h.store.events(result.id);
    assert.equal(userMessages(events).length, 1);
    assert.equal((userMessages(events)[0]!.data as { author?: { userId?: string } }).author?.userId, h.home.userId);
  } finally {
    await h.close();
  }
});

test("POST /api/sessions start is strictly validated and requires clientOperationId", async () => {
  const h = await httpHarness();
  try {
    const bad = [
      { projectId: h.homeProject, start: { firstTurn: { text: "no key" } } },
      { projectId: h.homeProject, clientOperationId: randomUUID(), start: { firstTurn: { text: 7 } } },
      { projectId: h.homeProject, clientOperationId: randomUUID(), start: { firstTurn: { text: "x", attachments: "a" } } },
      { projectId: h.homeProject, clientOperationId: randomUUID(), start: { firstTurn: { text: "x", command: { id: "" } } } },
      { projectId: h.homeProject, clientOperationId: randomUUID(), start: { firstTurn: { text: "x", autoTitle: "yes" } } },
      { projectId: h.homeProject, clientOperationId: randomUUID(), start: { autoAccept: "always" } },
      { projectId: h.homeProject, clientOperationId: randomUUID(), start: { agentProfileId: 3 } },
      { projectId: h.homeProject, clientOperationId: randomUUID(), start: { extensions: { a: [] } } },
      { projectId: h.homeProject, clientOperationId: randomUUID(), start: { extensions: { "no.such": {} } } },
      { projectId: h.homeProject, clientOperationId: randomUUID(), start: { surprise: true } },
    ];
    for (const body of bad) {
      const response = await h.post(body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.deepEqual(await h.store.projections(), []);
  } finally {
    await h.close();
  }
});

test("the same start key in another Space neither aliases nor reveals the first chat", async () => {
  const h = await httpHarness();
  try {
    const key = randomUUID();
    const start = { firstTurn: { text: "mine" } };
    const home = await (await h.post({ projectId: h.homeProject, clientOperationId: key, start })).json() as { id: string };
    const work = await h.post({ projectId: h.workProject, clientOperationId: key, start }, h.work);
    assert.equal(work.status, 200);
    assert.notEqual((await work.json() as { id: string }).id, home.id);
    // Another Space's project under the home Space is not found, not a conflict.
    const crossed = await h.post({ projectId: h.workProject, clientOperationId: randomUUID(), start });
    assert.equal(crossed.status, 404);
  } finally {
    await h.close();
  }
});
